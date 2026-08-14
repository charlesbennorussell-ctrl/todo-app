-- Membership schema for Ctrl-Project auth (v0.3.x).
--
-- Two tables: `members` (one row per workspace member, keyed to the Supabase
-- auth user) and `invites` (one-time invite links). All privileged writes go
-- through edge functions with the service role; RLS below is the safety net
-- for direct supabase-js reads and the few self-service writes.
--
-- Identity bridging: person_short links a member to the existing Person.short
-- initials denormalized into every task's assignees array in the Liveblocks
-- room ('B', 'P', 'D'). Shorts must stay UNIQUE across members — task data
-- cannot distinguish two people with the same short.

create table public.members (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  email          text not null,
  display_name   text not null,
  role           text not null default 'member' check (role in ('admin', 'member')),
  person_short   text not null,
  -- {"mode":"all"} | {"mode":"selected","projectIds":["p1","p2"]}
  project_access jsonb not null default '{"mode":"all"}'::jsonb,
  -- Soft delete. Removing a member sets removed_at instead of deleting the
  -- row: access is revoked (liveblocks-auth requires removed_at IS NULL) but
  -- the short stays RESERVED forever — task data still carries their initial
  -- in assignees arrays, and reissuing 'P' to a new member would silently
  -- hand them every task (and personal item) the old 'P' ever owned.
  removed_at     timestamptz,
  created_at     timestamptz not null default now()
);

-- Uniqueness spans removed members on purpose (tombstoned shorts).
create unique index members_person_short_key on public.members (lower(person_short));
create unique index members_email_key on public.members (lower(email));

create table public.invites (
  id             uuid primary key default gen_random_uuid(),
  -- SHA-256 hex of the raw token. The raw token appears only once, in the
  -- create-invite response the admin copies; the DB never stores it.
  token_hash     text not null unique,
  created_by     uuid not null references public.members(user_id) on delete cascade,
  invited_email  text,
  role           text not null default 'member' check (role in ('admin', 'member')),
  person_short   text,
  project_access jsonb not null default '{"mode":"all"}'::jsonb,
  expires_at     timestamptz not null default now() + interval '7 days',
  max_uses       int not null default 1,
  use_count      int not null default 0,
  revoked_at     timestamptz,
  redeemed_by    uuid[] not null default '{}',
  created_at     timestamptz not null default now()
);

-- No two LIVE invites may promise the same short (racing invites both
-- redeeming would collide with members_person_short_key at the worst moment
-- — mid-redemption for the second person). Expired/revoked/spent invites
-- free the short again.
create unique index invites_person_short_live_key on public.invites (lower(person_short))
  where person_short is not null and revoked_at is null and use_count < max_uses;

alter table public.members enable row level security;
alter table public.invites enable row level security;

-- Helpers. SECURITY DEFINER so they can read members regardless of the
-- caller's own RLS visibility; search_path pinned per Supabase lint rules.
create function public.is_member() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.members
                  where user_id = auth.uid() and removed_at is null) $$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.members
                  where user_id = auth.uid() and role = 'admin' and removed_at is null) $$;

-- members: every member can see the roster (names/roles power the UI).
create policy members_select on public.members
  for select using (public.is_member());

-- Self-service: a member may update their OWN row, but the trigger below
-- rejects changes to privileged columns unless the caller is an admin.
create policy members_update_self on public.members
  for update using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- Admins may remove members (removing the row revokes access at the next
-- token mint; the auth.users account itself is left alone).
create policy members_delete_admin on public.members
  for delete using (public.is_admin());

-- No INSERT policy: membership rows are created only by edge functions
-- (redeem-invite / admin bootstrap) using the service role.

create function public.members_guard_privileged_cols() returns trigger
language plpgsql security definer set search_path = public as
$$
begin
  if not public.is_admin() then
    if new.role is distinct from old.role
       or new.project_access is distinct from old.project_access
       or new.person_short is distinct from old.person_short
       or new.user_id is distinct from old.user_id
       or new.email is distinct from old.email
       or new.removed_at is distinct from old.removed_at then
      raise exception 'only admins may change role, access, short, email, or removal';
    end if;
  end if;
  return new;
end;
$$;

create trigger members_guard_privileged_cols
  before update on public.members
  for each row execute function public.members_guard_privileged_cols();

-- LAST-ADMIN INVARIANT, enforced in the database (the client-side adminCount
-- check is UX only — direct REST calls and two-admin races bypass it, and a
-- workspace with zero live admins can never mint invites or reset passwords
-- again without dashboard SQL). Locks the (tiny) table to close the
-- READ-COMMITTED race where two admins demote each other concurrently.
-- Break-glass: dashboard SQL can still `alter table … disable trigger`.
create function public.members_protect_last_admin() returns trigger
language plpgsql security definer set search_path = public as
$$
declare
  was_live_admin boolean;
  loses_admin boolean;
  remaining int;
begin
  was_live_admin := old.role = 'admin' and old.removed_at is null;
  if not was_live_admin then
    return coalesce(new, old);
  end if;
  loses_admin := tg_op = 'DELETE'
    or new.role <> 'admin'
    or new.removed_at is not null;
  if not loses_admin then
    return new;
  end if;
  lock table public.members in share row exclusive mode;
  select count(*) into remaining from public.members
    where role = 'admin' and removed_at is null and user_id <> old.user_id;
  if remaining = 0 then
    raise exception 'cannot demote or remove the last admin';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger members_protect_last_admin
  before update or delete on public.members
  for each row execute function public.members_protect_last_admin();

-- Atomic invite redemption. Runs as ONE transaction so racing windows (main +
-- PIP both firing redeem) can't double-spend max_uses or half-join a member.
-- Called ONLY by the membership edge function with the service role — it is
-- not exposed to clients (revoked from anon/authenticated below).
create function public.redeem_invite_tx(p_token_hash text, p_user_id uuid, p_email text, p_display_name text)
returns table (ok boolean, reason text, person_short text, role text, project_access jsonb)
language plpgsql security definer set search_path = public as
$$
declare
  inv public.invites%rowtype;
  existing public.members%rowtype;
begin
  -- Already a live member → success, and DON'T consume the invite.
  select * into existing from public.members m where m.user_id = p_user_id;
  if found then
    if existing.removed_at is not null then
      return query select false, 'membership was revoked — ask the admin for help', null::text, null::text, null::jsonb;
      return;
    end if;
    return query select true, 'already a member', existing.person_short, existing.role, existing.project_access;
    return;
  end if;

  -- Lock the invite row for the duration of the transaction.
  select * into inv from public.invites i where i.token_hash = p_token_hash for update;
  if not found then
    return query select false, 'invite not found', null::text, null::text, null::jsonb;
    return;
  end if;
  if inv.revoked_at is not null then
    return query select false, 'invite was revoked', null::text, null::text, null::jsonb;
    return;
  end if;
  if inv.expires_at < now() then
    return query select false, 'invite expired', null::text, null::text, null::jsonb;
    return;
  end if;
  if inv.use_count >= inv.max_uses then
    return query select false, 'invite already used', null::text, null::text, null::jsonb;
    return;
  end if;
  -- When the admin pinned the invite to an email, only that email may redeem.
  -- Real guarantee on the authed path (p_email comes from the verified
  -- session); on the pre-auth path it stops a token holder from registering
  -- someone ELSE's address as pre-verified under this invite.
  if inv.invited_email is not null and lower(inv.invited_email) <> lower(p_email) then
    return query select false, 'this invite was issued for a different email address', null::text, null::text, null::jsonb;
    return;
  end if;

  update public.invites set use_count = use_count + 1, redeemed_by = redeemed_by || p_user_id
    where id = inv.id;

  insert into public.members (user_id, email, display_name, role, person_short, project_access)
  values (p_user_id, p_email, p_display_name, inv.role,
          coalesce(inv.person_short, upper(left(p_display_name, 1))), inv.project_access);

  return query select true, 'joined', coalesce(inv.person_short, upper(left(p_display_name, 1))), inv.role, inv.project_access;
exception
  when unique_violation then
    return query select false, 'that initial is already taken — ask the admin for a fresh invite', null::text, null::text, null::jsonb;
end;
$$;

revoke execute on function public.redeem_invite_tx from public, anon, authenticated;

-- invites: admin-only visibility and revocation. Creation and redemption run
-- in edge functions with the service role (redemption must validate a token
-- HASH and mutate atomically — never trust the client with that).
create policy invites_select_admin on public.invites
  for select using (public.is_admin());

create policy invites_update_admin on public.invites
  for update using (public.is_admin()) with check (public.is_admin());

create policy invites_delete_admin on public.invites
  for delete using (public.is_admin());
