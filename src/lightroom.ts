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

async function proxyFetch(adobePath: string, init: RequestInit = {}): Promise<Response> {
  const doFetch = async (): Promise<Response> => {
    const accessToken = localStorage.getItem(LS_ACCESS_TOKEN) || '';
    return fetch(`${PROXY_URL}?path=${encodeURIComponent(adobePath)}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        'Authorization': `Bearer ${accessToken}`,
        'x-adobe-client-id': ADOBE_CLIENT_ID,
      },
    });
  };
  let res = await doFetch();
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) res = await doFetch();
  }
  return res;
}

export type LightroomAlbumAsset = {
  id: string;
  filename: string;
  width: number;
  height: number;
  // Adobe returns rendition URLs that we proxy via fetchAssetBlob().
  renditionPath: string;
};

/** Get the user's first catalogue ID. Most users have a single catalogue. */
export async function getCatalogId(): Promise<string> {
  const res = await proxyFetch('/v2/catalog');
  if (!res.ok) throw new Error(`Adobe catalog fetch failed: ${res.status}`);
  const json = await res.json() as { id: string };
  return json.id;
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
export async function resolveShareUrl(rawShareUrl: string): Promise<{ catalogId: string; albumId: string; name: string } | { error: string }> {
  // Step 0: expand adobe.ly shorteners. No-op for non-short URLs.
  console.log('[lightroom] resolveShareUrl input:', rawShareUrl);
  const shareUrl = await expandShortUrl(rawShareUrl);
  if (shareUrl !== rawShareUrl) console.log('[lightroom] expanded to:', shareUrl);
  // Direct album URL: /libraries/<catId>/albums/<albumId>/...
  const directMatch = shareUrl.match(/\/libraries\/([^/]+)\/albums\/([^/?#]+)/);
  if (directMatch) {
    const [, catalogId, albumId] = directMatch;
    console.log('[lightroom] matched album URL:', { catalogId, albumId });
    const name = await fetchAlbumName(catalogId, albumId);
    return { catalogId, albumId, name };
  }
  // Share-link URL: /shares/<shareId>(/...)? — share belongs to authenticated user.
  const shareMatch = shareUrl.match(/\/shares\/([^/?#]+)/);
  if (shareMatch) {
    const [, shareId] = shareMatch;
    console.log('[lightroom] matched share URL with id:', shareId);
    try {
      const catalogId = await getCatalogId();
      console.log('[lightroom] user catalog id:', catalogId);
      const path = `/v2/catalogs/${catalogId}/assetshares/${shareId}`;
      console.log('[lightroom] looking up share at:', path);
      const res = await proxyFetch(path);
      const bodyText = await res.text();
      console.log('[lightroom] share lookup response:', res.status, bodyText.slice(0, 500));
      if (!res.ok) {
        return { error: `Adobe returned ${res.status} for the share lookup. The share most likely belongs to a different Adobe account than the one you signed in with. (Adobe response: ${bodyText.slice(0, 200)})` };
      }
      // Adobe sometimes prefixes JSON responses with "while(1){}" — strip that.
      const cleanedBody = bodyText.replace(/^while\s*\(1\)\s*\{\s*\}\s*/, '');
      let json: { payload?: { albumId?: string; shareName?: string; album?: { id?: string; name?: string } } };
      try {
        json = JSON.parse(cleanedBody);
      } catch {
        return { error: `Adobe response wasn't valid JSON: ${cleanedBody.slice(0, 200)}` };
      }
      const albumId = json.payload?.albumId || json.payload?.album?.id;
      if (!albumId) {
        return { error: `Share resource is missing an album reference. Payload keys: ${Object.keys(json.payload || {}).join(', ')}` };
      }
      const name = json.payload?.shareName || json.payload?.album?.name || await fetchAlbumName(catalogId, albumId);
      return { catalogId, albumId, name };
    } catch (e) {
      return { error: `Share resolution threw: ${(e as Error).message}` };
    }
  }
  return { error: `URL does not match a Lightroom share or album pattern. Got: ${shareUrl}` };
}

/** Look up an album's display name. Used to label the new folder we drop
 *  the imported images into. Falls back to "Lightroom Import" on failure. */
async function fetchAlbumName(catalogId: string, albumId: string): Promise<string> {
  try {
    const res = await proxyFetch(`/v2/catalogs/${catalogId}/albums/${albumId}`);
    if (!res.ok) return 'Lightroom Import';
    const json = await res.json() as { payload?: { name?: string } };
    return json.payload?.name || 'Lightroom Import';
  } catch {
    return 'Lightroom Import';
  }
}

/** List all assets in an album. Returns paginated results — caller iterates. */
export async function fetchAlbumAssets(catalogId: string, albumId: string): Promise<LightroomAlbumAsset[]> {
  const all: LightroomAlbumAsset[] = [];
  let cursor: string | undefined;
  do {
    const path = `/v2/catalogs/${catalogId}/albums/${albumId}/assets${cursor ? `?after=${cursor}` : ''}`;
    const res = await proxyFetch(path);
    if (!res.ok) throw new Error(`Adobe album assets fetch failed: ${res.status}`);
    const json = await res.json() as { resources: Array<{ asset: { id: string; payload: { importSource: { fileName: string }; develop?: { croppedHeight?: number; croppedWidth?: number } } } }>; links?: { next?: { href: string } } };
    for (const r of json.resources) {
      const dev = r.asset.payload.develop || {};
      all.push({
        id: r.asset.id,
        filename: r.asset.payload.importSource.fileName,
        width: dev.croppedWidth || 0,
        height: dev.croppedHeight || 0,
        renditionPath: `/v2/catalogs/${catalogId}/assets/${r.asset.id}/renditions/2048`,
      });
    }
    cursor = json.links?.next?.href ? new URL(json.links.next.href, 'https://lr.adobe.io').searchParams.get('after') || undefined : undefined;
  } while (cursor);
  return all;
}

/** Fetch a single asset's rendition as a Blob, ready to feed into the
 *  existing addFocusImages() pipeline (which scales + uploads to Supabase). */
export async function fetchAssetBlob(asset: LightroomAlbumAsset): Promise<Blob> {
  const res = await proxyFetch(asset.renditionPath);
  if (!res.ok) throw new Error(`Adobe rendition fetch failed for ${asset.filename}: ${res.status}`);
  return res.blob();
}
