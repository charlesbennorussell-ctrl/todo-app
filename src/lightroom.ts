// Adobe Lightroom Services integration — PKCE OAuth + album-import client.
//
// FLOW:
//   1. User clicks "Import from Lightroom" → openLightroomAuth() generates a
//      PKCE code-verifier + challenge, stashes the verifier in sessionStorage,
//      and redirects the browser to Adobe's OAuth screen.
//   2. Adobe redirects back to the app with `?code=…&state=…` in the URL.
//      consumeOauthRedirect() (called once at App mount) detects the params,
//      exchanges the code for an access token, stores both access + refresh
//      tokens in localStorage, and cleans the URL.
//   3. Subsequent calls (resolveShareUrl / fetchAlbumAssets / fetchAssetBlob)
//      use the access token via the Supabase Edge Function `lr-proxy` to
//      bypass CORS — Adobe's API doesn't allow direct browser calls.
//   4. Token expiry is handled by refreshAccessToken() which uses the refresh
//      token; the proxy retries 401s once with a fresh access token.
//
// All localStorage keys are namespaced under `lr:` so they're easy to identify
// in browser dev tools and to clear via `localStorage.clear()`-equivalents.

const ADOBE_CLIENT_ID = (import.meta.env.VITE_ADOBE_CLIENT_ID as string | undefined) || '';
const ADOBE_AUTH_URL = 'https://ims-na1.adobelogin.com/ims/authorize/v2';
const ADOBE_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
// Scopes:
//   openid                 — required by IMS
//   lr_partner_apis        — Lightroom catalogue + album reads
//   lr_partner_rendition_apis — read image renditions (the actual binaries)
//   offline_access         — issue a refresh token so we don't have to bounce
//                            the user back through auth every hour
const ADOBE_SCOPES = ['openid', 'lr_partner_apis', 'lr_partner_rendition_apis', 'offline_access'];

const LS_PKCE_VERIFIER = 'lr:pkce_verifier';
const LS_PKCE_STATE = 'lr:pkce_state';
const LS_ACCESS_TOKEN = 'lr:access_token';
const LS_REFRESH_TOKEN = 'lr:refresh_token';
const LS_TOKEN_EXPIRES_AT = 'lr:token_expires_at';

// ── PKCE helpers ────────────────────────────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash);
}

function generateRandomString(length = 64): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

// ── Public API ─────────────────────────────────────────────────────────────

/** True if the app has a valid access token (not yet expired). */
export function hasLightroomAuth(): boolean {
  const tok = localStorage.getItem(LS_ACCESS_TOKEN);
  if (!tok) return false;
  const exp = Number(localStorage.getItem(LS_TOKEN_EXPIRES_AT) || 0);
  return Date.now() < exp - 60_000; // 1-min safety buffer
}

/** Get the current redirect URI based on where the app is running. Adobe
 *  needs an EXACT match against one of its registered patterns, so we use
 *  `window.location.origin + '/todo-app/'` for prod and origin-only for dev. */
function getRedirectUri(): string {
  // GitHub Pages serves under /todo-app/. Local dev (vite) serves at root.
  // Both URLs were registered as redirect-pattern entries in Adobe's console.
  const origin = window.location.origin;
  if (origin.includes('github.io')) return `${origin}/todo-app/`;
  return `${origin}/`;
}

/** Step 1 of OAuth: redirect to Adobe's auth screen. */
export async function openLightroomAuth(): Promise<void> {
  if (!ADOBE_CLIENT_ID) {
    throw new Error('VITE_ADOBE_CLIENT_ID is not set — Lightroom import disabled.');
  }
  const verifier = generateRandomString(64);
  const challenge = base64UrlEncode(await sha256(verifier));
  const state = generateRandomString(32);
  // Stash the verifier + state for the redirect-back handler.
  sessionStorage.setItem(LS_PKCE_VERIFIER, verifier);
  sessionStorage.setItem(LS_PKCE_STATE, state);
  const params = new URLSearchParams({
    client_id: ADOBE_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: ADOBE_SCOPES.join(','),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  window.location.href = `${ADOBE_AUTH_URL}?${params.toString()}`;
}

/** Step 2 of OAuth: called at app mount to detect ?code=…&state=… in the URL
 *  after Adobe redirects back. Exchanges the code for tokens, stores them,
 *  and cleans the URL. Returns true if a redirect was consumed (caller can
 *  show a success toast etc.). */
export async function consumeOauthRedirect(): Promise<boolean> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  if (!code) return false;
  const expectedState = sessionStorage.getItem(LS_PKCE_STATE);
  const verifier = sessionStorage.getItem(LS_PKCE_VERIFIER);
  if (!verifier || !expectedState || returnedState !== expectedState) {
    console.warn('[lightroom] OAuth state mismatch or missing verifier; ignoring code.');
    // Clean the URL anyway so we don't loop.
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    window.history.replaceState({}, '', url.toString());
    return false;
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: ADOBE_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: getRedirectUri(),
  });
  const res = await fetch(ADOBE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error('[lightroom] Token exchange failed:', res.status, errText);
    sessionStorage.removeItem(LS_PKCE_VERIFIER);
    sessionStorage.removeItem(LS_PKCE_STATE);
    return false;
  }
  const json = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
  localStorage.setItem(LS_ACCESS_TOKEN, json.access_token);
  if (json.refresh_token) localStorage.setItem(LS_REFRESH_TOKEN, json.refresh_token);
  localStorage.setItem(LS_TOKEN_EXPIRES_AT, String(Date.now() + json.expires_in * 1000));
  sessionStorage.removeItem(LS_PKCE_VERIFIER);
  sessionStorage.removeItem(LS_PKCE_STATE);
  // Clean ?code=…&state=… from the URL so a refresh doesn't re-attempt.
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  window.history.replaceState({}, '', url.toString());
  return true;
}

/** Step 3 of OAuth: refresh the access token using the stored refresh token.
 *  Called automatically by the proxy on a 401. Returns true if successful. */
export async function refreshAccessToken(): Promise<boolean> {
  const refresh = localStorage.getItem(LS_REFRESH_TOKEN);
  if (!refresh) return false;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ADOBE_CLIENT_ID,
    refresh_token: refresh,
  });
  const res = await fetch(ADOBE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    console.warn('[lightroom] Refresh token exchange failed:', res.status);
    return false;
  }
  const json = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
  localStorage.setItem(LS_ACCESS_TOKEN, json.access_token);
  if (json.refresh_token) localStorage.setItem(LS_REFRESH_TOKEN, json.refresh_token);
  localStorage.setItem(LS_TOKEN_EXPIRES_AT, String(Date.now() + json.expires_in * 1000));
  return true;
}

/** Sign out — wipe all stored tokens. */
export function signOutLightroom(): void {
  localStorage.removeItem(LS_ACCESS_TOKEN);
  localStorage.removeItem(LS_REFRESH_TOKEN);
  localStorage.removeItem(LS_TOKEN_EXPIRES_AT);
}

// ── API client (Edge Function proxy) ───────────────────────────────────────
//
// Adobe's Lightroom API doesn't allow CORS from browser origins, so all
// outbound calls (catalogue read, album list, asset list, rendition fetch)
// go through `${SUPABASE_URL}/functions/v1/lr-proxy?path=…`. The proxy:
//   - Receives the user's Adobe access token via the Authorization header
//   - Forwards the request to lr.adobe.io with that token + an x-api-key header
//     containing ADOBE_CLIENT_ID (Adobe requires both for API calls)
//   - Streams the response back, including correct content-type for binaries
//
// On a 401 from Adobe, we attempt one refresh and one retry.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const PROXY_URL = `${SUPABASE_URL}/functions/v1/lr-proxy`;

type ProxyOpts = {
  /** Upstream host. Defaults to lr.adobe.io (authenticated API). Use
   *  photos.adobe.io for public-share endpoints, lightroom.adobe.com for
   *  fetching share-page HTML. */
  host?: 'lr.adobe.io' | 'photos.adobe.io' | 'lightroom.adobe.com';
  /** If true, skip the Authorization header (used for public endpoints
   *  that only need X-API-Key). Default false. */
  noAuth?: boolean;
  /** Optional cancellation signal. When the signal fires the in-flight
   *  fetch is aborted and the call rejects with an AbortError. */
  signal?: AbortSignal;
};

async function proxyFetch(adobePath: string, opts: ProxyOpts = {}, init: RequestInit = {}): Promise<Response> {
  const host = opts.host || 'lr.adobe.io';
  const doFetch = async (): Promise<Response> => {
    const headers: Record<string, string> = {
      'x-adobe-client-id': ADOBE_CLIENT_ID,
      ...(init.headers as Record<string, string> | undefined || {}),
    };
    if (!opts.noAuth) {
      const accessToken = localStorage.getItem(LS_ACCESS_TOKEN) || '';
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    }
    return fetch(`${PROXY_URL}?path=${encodeURIComponent(adobePath)}&host=${host}`, {
      ...init,
      headers,
      signal: opts.signal,
    });
  };
  let res = await doFetch();
  // Refresh-and-retry only applies to authenticated calls (noAuth=false).
  if (!opts.noAuth && res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) res = await doFetch();
  }
  return res;
}

// Adobe wraps JSON responses with an anti-JSON-hijacking prefix that varies
// per endpoint:
//   - "{}" (empty object) + whitespace + real JSON   ← lr-services /v2/catalog
//   - "while (1) {}" or "while(1)" + real JSON        ← some endpoints
//   - ")]}'," + real JSON                             ← Google-style
// The browser's res.json() chokes on every variant. Rather than try to maintain
// a list of prefix shapes, this helper: reads the body, then tries JSON.parse
// from each `{` / `[` position in turn, returning the first successful parse.
// Linear-time and bulletproof against new prefix shapes Adobe might add later.
async function proxyFetchJson<T>(adobePath: string, opts: ProxyOpts = {}, init: RequestInit = {}): Promise<T> {
  const res = await proxyFetch(adobePath, opts, init);
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Adobe ${adobePath} returned ${res.status}: ${bodyText.slice(0, 200)}`);
  }
  // Fast path: try parsing the whole body first.
  try { return JSON.parse(bodyText) as T; } catch { /* fall through */ }
  // Walk every `{` / `[` position and try parsing from there. The first
  // successful parse is the real payload. Walk forward (not backward) so
  // we prefer the earliest valid JSON, in case a later one is something
  // small inside the document we don't want to accidentally land on.
  for (let i = 0; i < bodyText.length; i++) {
    const ch = bodyText[i];
    if (ch !== '{' && ch !== '[') continue;
    try {
      const parsed = JSON.parse(bodyText.slice(i)) as T;
      // Skip the "{}" empty-object prefix specifically — if we parsed an
      // empty object/array AND there's more content after, keep walking.
      if ((ch === '{' && bodyText[i + 1] === '}') || (ch === '[' && bodyText[i + 1] === ']')) continue;
      return parsed;
    } catch { /* try next position */ }
  }
  throw new Error(`Adobe ${adobePath} returned non-JSON body: ${bodyText.slice(0, 200)}`);
}

export type LightroomAlbumAsset = {
  id: string;
  filename: string;
  width: number;
  height: number;
  // Path to the rendition under the API base. fetchAssetBlob() combines
  // this with the right host (photos.adobe.io for shareSpaceId-rooted paths,
  // lr.adobe.io for catalog-rooted paths).
  renditionPath: string;
  // For public shares, the path is rooted at /v2/spaces/<shareId>/. The
  // resolved share carries shareId so fetchAssetBlob knows which host to
  // hit. For authenticated /libraries/ imports, this is undefined and we
  // use the catalog API (lr.adobe.io).
  shareId?: string;
};

/** Get the user's first catalogue ID. Most users have a single catalogue.
 *  Used by the authenticated /libraries/ URL path; public shares don't need it. */
export async function getCatalogId(): Promise<string> {
  const json = await proxyFetchJson<{ id: string }>('/v2/catalog');
  return json.id;
}

// ── Public-share path (no auth required) ───────────────────────────────────
//
// A public Lightroom share URL (lightroom.adobe.com/shares/<id>) is fully
// accessible without OAuth — Adobe serves the share page as static-ish HTML
// with a window.SharesConfig blob inlined, and the asset/rendition endpoints
// on photos.adobe.io accept any X-API-Key. So we scrape the embedded config
// to learn the album's id + name, then hit the public endpoints directly.

/** Brace-counting JSON-object extractor. Scans `str` for `marker`, then
 *  returns the substring of the next balanced `{...}` after it (respecting
 *  string literals + escapes so braces inside strings don't fool us). */
function extractObjectAfter(str: string, marker: string): string | null {
  const i = str.indexOf(marker);
  if (i < 0) return null;
  const startIdx = str.indexOf('{', i + marker.length);
  if (startIdx < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = startIdx; j < str.length; j++) {
    const c = str[j];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return str.slice(startIdx, j + 1);
    }
  }
  return null;
}

/** Fetch the public share page HTML, extract the inlined SharesConfig.
 *  Returns the album info needed to list its assets. */
async function fetchPublicShareInfo(shareId: string): Promise<{ albumId: string; name: string }> {
  const res = await proxyFetch(`/shares/${shareId}`, { host: 'lightroom.adobe.com', noAuth: true });
  if (!res.ok) throw new Error(`Share page fetch failed: ${res.status}`);
  const html = await res.text();
  const albumJsonStr = extractObjectAfter(html, 'albumAttributes:');
  if (!albumJsonStr) {
    throw new Error('Could not find albumAttributes in the share page. Is this a valid Lightroom share URL?');
  }
  let album: { id?: string; payload?: { name?: string } };
  try {
    album = JSON.parse(albumJsonStr);
  } catch (e) {
    throw new Error(`Could not parse albumAttributes JSON: ${(e as Error).message}`);
  }
  if (!album.id) throw new Error('Share albumAttributes is missing an id.');
  return { albumId: album.id, name: album.payload?.name || 'Lightroom Import' };
}

/** List assets in a public share's album. Pagination via the `links.next`
 *  cursor. Each asset's rendition path is /spaces/<share>/<asset.links.rendition_2048.href>. */
async function fetchPublicShareAssets(shareId: string, albumId: string, signal?: AbortSignal): Promise<LightroomAlbumAsset[]> {
  const all: LightroomAlbumAsset[] = [];
  let path: string | null = `/v2/spaces/${shareId}/albums/${albumId}/assets?embed=asset&subtype=image%3Bvideo`;
  while (path) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const json: {
      base: string;
      resources: Array<{
        asset: {
          id: string;
          payload: {
            importSource?: { fileName?: string };
            develop?: { croppedWidth?: number; croppedHeight?: number };
          };
          links: Record<string, { href: string }>;
        };
      }>;
      links?: { next?: { href: string } };
    } = await proxyFetchJson(path, { host: 'photos.adobe.io', noAuth: true, signal });
    for (const r of json.resources) {
      const dev = r.asset.payload.develop || {};
      const renditionLink = r.asset.links['/rels/rendition_type/2048']
        || r.asset.links['/rels/rendition_type/1280']
        || r.asset.links['/rels/rendition_type/640'];
      if (!renditionLink) continue;
      // renditionLink.href is relative to the response's base, which is
      // `https://photos.adobe.io/v2/spaces/<shareId>/`. We just need the
      // path for the proxy, so prepend `/v2/spaces/<shareId>/`.
      const renditionPath = `/v2/spaces/${shareId}/${renditionLink.href}`;
      all.push({
        id: r.asset.id,
        filename: r.asset.payload.importSource?.fileName || `${r.asset.id}.jpg`,
        width: dev.croppedWidth || 0,
        height: dev.croppedHeight || 0,
        renditionPath,
        shareId,
      });
    }
    // Pagination: links.next.href is relative to the assets endpoint's base.
    const nextHref = json.links?.next?.href;
    if (nextHref) {
      // nextHref looks like "albums/.../assets?after=…". Stitch back onto
      // the spaces path.
      path = `/v2/spaces/${shareId}/${nextHref}`;
    } else {
      path = null;
    }
  }
  return all;
}

/** Expand an Adobe short URL (https://adobe.ly/...) to its canonical form
 *  via the proxy's /expand endpoint. Browsers can't follow the redirect
 *  themselves (CORS), so the Edge Function does it server-side and returns
 *  the final URL. Pass-through for non-shortened URLs. */
async function expandShortUrl(input: string): Promise<string> {
  let parsed: URL;
  try { parsed = new URL(input); } catch { return input; }
  if (parsed.host !== 'adobe.ly') return input;
  try {
    const res = await fetch(`${PROXY_URL}?expand=${encodeURIComponent(input)}`);
    if (!res.ok) {
      console.warn('[lightroom] adobe.ly expand failed:', res.status);
      return input;
    }
    const json = await res.json() as { finalUrl?: string };
    return json.finalUrl || input;
  } catch (e) {
    console.warn('[lightroom] adobe.ly expand threw:', e);
    return input;
  }
}

/** Resolve a Lightroom URL to its catalogId + albumId. Accepts:
 *    - https://adobe.ly/<short>                               ← Adobe URL shortener
 *    - https://lightroom.adobe.com/shares/<shareId>           ← share-link URL
 *    - https://lightroom.adobe.com/shares/<shareId>/...        ← share variants
 *    - https://lightroom.adobe.com/libraries/<catalogId>/albums/<albumId>/...
 *      (the URL you copy from your own LR web view of an album)
 *
 *  Short URLs are expanded server-side first (CORS blocks the browser from
 *  following adobe.ly redirects). For share-link URLs, this calls
 *  /v2/catalogs/{cat}/assetshares/{shareId} on the AUTHENTICATED user's
 *  catalog — which works for albums YOU shared. Importing someone-else's
 *  shared album is not yet supported (would need a server-side scrape of
 *  the public share page; left for a follow-up). Returns null with a
 *  console warning if the URL doesn't match any pattern. */
/** Resolved import target. The `kind` discriminates between the public-share
 *  path (no auth, hits photos.adobe.io) and the authenticated /libraries/
 *  path (needs OAuth, hits lr.adobe.io). */
export type ResolvedTarget =
  | { kind: 'publicShare'; shareId: string; albumId: string; name: string }
  | { kind: 'ownAlbum'; catalogId: string; albumId: string; name: string };

export async function resolveShareUrl(rawShareUrl: string): Promise<ResolvedTarget | { error: string }> {
  console.log('[lightroom] resolveShareUrl input:', rawShareUrl);
  const shareUrl = await expandShortUrl(rawShareUrl);
  if (shareUrl !== rawShareUrl) console.log('[lightroom] expanded to:', shareUrl);
  // /shares/<id> — public share path (no OAuth required, scrape the share page).
  const shareMatch = shareUrl.match(/\/shares\/([^/?#]+)/);
  if (shareMatch) {
    const [, shareId] = shareMatch;
    console.log('[lightroom] matched public share id:', shareId);
    try {
      const info = await fetchPublicShareInfo(shareId);
      return { kind: 'publicShare', shareId, albumId: info.albumId, name: info.name };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  // /libraries/<cat>/albums/<id> — authenticated own-album path.
  const directMatch = shareUrl.match(/\/libraries\/([^/]+)\/albums\/([^/?#]+)/);
  if (directMatch) {
    const [, catalogId, albumId] = directMatch;
    console.log('[lightroom] matched own album URL:', { catalogId, albumId });
    if (!hasLightroomAuth()) {
      return { error: '/libraries/ URLs need a Lightroom sign-in (the share is in your private catalog). Click Connect Lightroom in the toolbar first, then retry. /shares/ URLs work without sign-in.' };
    }
    const name = await fetchAlbumName(catalogId, albumId);
    return { kind: 'ownAlbum', catalogId, albumId, name };
  }
  return { error: `URL does not match a Lightroom share or album pattern. Got: ${shareUrl}` };
}

/** Look up an album's display name. Used to label the new folder we drop
 *  the imported images into. Falls back to "Lightroom Import" on failure. */
async function fetchAlbumName(catalogId: string, albumId: string): Promise<string> {
  try {
    const json = await proxyFetchJson<{ payload?: { name?: string } }>(`/v2/catalogs/${catalogId}/albums/${albumId}`);
    return json.payload?.name || 'Lightroom Import';
  } catch {
    return 'Lightroom Import';
  }
}

/** List all assets in a resolved target — dispatches to the public-share or
 *  authenticated-own-album loader as appropriate. */
export async function fetchAlbumAssets(target: ResolvedTarget, signal?: AbortSignal): Promise<LightroomAlbumAsset[]> {
  if (target.kind === 'publicShare') {
    return fetchPublicShareAssets(target.shareId, target.albumId, signal);
  }
  // Own-album path (authenticated, lr.adobe.io).
  const all: LightroomAlbumAsset[] = [];
  let cursor: string | undefined;
  do {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const path = `/v2/catalogs/${target.catalogId}/albums/${target.albumId}/assets${cursor ? `?after=${cursor}` : ''}`;
    const json = await proxyFetchJson<{ resources: Array<{ asset: { id: string; payload: { importSource: { fileName: string }; develop?: { croppedHeight?: number; croppedWidth?: number } } } }>; links?: { next?: { href: string } } }>(path, { signal });
    for (const r of json.resources) {
      const dev = r.asset.payload.develop || {};
      all.push({
        id: r.asset.id,
        filename: r.asset.payload.importSource.fileName,
        width: dev.croppedWidth || 0,
        height: dev.croppedHeight || 0,
        renditionPath: `/v2/catalogs/${target.catalogId}/assets/${r.asset.id}/renditions/2048`,
      });
    }
    cursor = json.links?.next?.href ? new URL(json.links.next.href, 'https://lr.adobe.io').searchParams.get('after') || undefined : undefined;
  } while (cursor);
  return all;
}

/** Fetch a single asset's rendition as a Blob, ready to feed into the
 *  existing addFocusImages() pipeline. Routes to the right host based on
 *  whether the asset came from a public share (photos.adobe.io, no auth)
 *  or a private catalog (lr.adobe.io, authenticated). */
export async function fetchAssetBlob(asset: LightroomAlbumAsset, signal?: AbortSignal): Promise<Blob> {
  const isPublic = !!asset.shareId;
  const res = await proxyFetch(asset.renditionPath, isPublic ? { host: 'photos.adobe.io', noAuth: true, signal } : { signal });
  if (!res.ok) throw new Error(`Rendition fetch failed for ${asset.filename}: ${res.status}`);
  return res.blob();
}
