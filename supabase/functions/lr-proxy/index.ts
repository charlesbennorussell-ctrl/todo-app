// Supabase Edge Function: Lightroom API CORS proxy.
//
// PROBLEM: Adobe's Lightroom Services API (https://lr.adobe.io) doesn't send
//   CORS headers, so a browser can't call it directly. Without a server hop,
//   import-from-Lightroom would be impossible.
//
// SOLUTION: This edge function accepts requests from the app frontend with:
//   - Authorization: Bearer <user's Adobe access token>
//   - x-adobe-client-id: <app's Lightroom Client ID>
//   - ?path=/v2/catalogs/... (the Adobe API path to forward)
//
// ...and forwards them to Adobe with the same auth headers, then streams the
// response back with CORS headers attached. The user's Adobe token never
// leaves their browser → this Edge Function → Adobe; we don't store anything
// about the user here.
//
// DEPLOY (local):
//   supabase functions deploy lr-proxy --no-verify-jwt
//
// The --no-verify-jwt flag means we don't require a Supabase auth token to
// hit this endpoint — anyone can call it, but they need their OWN Adobe
// token in the Authorization header to actually retrieve any data, so it's
// not abusable.

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

// Allowlisted upstream hosts. lr.adobe.io is the authenticated Lightroom
// Services API. photos.adobe.io is the public-shares API (no Bearer token
// needed, only X-API-Key). lightroom.adobe.com is for fetching public share
// pages as HTML so we can scrape the embedded SharesConfig.
const ALLOWED_HOSTS = new Set(['lr.adobe.io', 'photos.adobe.io', 'lightroom.adobe.com']);
const DEFAULT_HOST = 'lr.adobe.io';

// Allow the app's origins. Adjust if you add new deploy targets.
const ALLOWED_ORIGINS = new Set([
  'https://charlesbennorussell-ctrl.github.io',
  'http://localhost:5173',
  // Tauri loads from the same GitHub Pages URL, so no extra entry needed.
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://charlesbennorussell-ctrl.github.io';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-adobe-client-id',
    'Access-Control-Max-Age': '86400',
  };
}

serve(async (req: Request) => {
  const origin = req.headers.get('Origin');
  const baseHeaders = corsHeaders(origin);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  const url = new URL(req.url);

  // ── URL-expansion endpoint ────────────────────────────────────────────────
  // Adobe's mobile share UI hands out adobe.ly short URLs that redirect to
  // the canonical lightroom.adobe.com/shares/<id> form. The browser can't
  // follow those redirects (CORS), so we do it here. Pure pass-through, no
  // auth required — the caller just gets the final destination URL back.
  // Restricted to a small allowlist of known shortener hosts so this can't
  // be used as an open redirect resolver.
  const expandUrl = url.searchParams.get('expand');
  if (expandUrl) {
    try {
      const target = new URL(expandUrl);
      const allowedExpandHosts = new Set(['adobe.ly', 'lightroom.adobe.com']);
      if (!allowedExpandHosts.has(target.host)) {
        return new Response(
          JSON.stringify({ error: 'expand: host not allowed' }),
          { status: 400, headers: { ...baseHeaders, 'Content-Type': 'application/json' } },
        );
      }
      // fetch follows redirects by default; .url on the response is the
      // final URL after all hops. HEAD is cheaper than GET (no body).
      const resp = await fetch(expandUrl, { method: 'HEAD', redirect: 'follow' });
      return new Response(
        JSON.stringify({ finalUrl: resp.url }),
        { status: 200, headers: { ...baseHeaders, 'Content-Type': 'application/json' } },
      );
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'expand failed', detail: (e as Error).message }),
        { status: 502, headers: { ...baseHeaders, 'Content-Type': 'application/json' } },
      );
    }
  }

  // ── Adobe API / share-page proxy endpoint ────────────────────────────────
  // Auth headers are NO LONGER required to call this endpoint — public-share
  // assets on photos.adobe.io don't need a Bearer token, only an X-API-Key.
  // We pass through whatever auth headers the caller provided; if Adobe
  // needs them and they're missing, Adobe will reject the request and we
  // surface the error verbatim.
  const authHeader = req.headers.get('Authorization');
  const clientId = req.headers.get('x-adobe-client-id');

  // Parse the target path + optional host
  const pathParam = url.searchParams.get('path');
  if (!pathParam) {
    return new Response(
      JSON.stringify({ error: 'Missing ?path query parameter' }),
      { status: 400, headers: { ...baseHeaders, 'Content-Type': 'application/json' } },
    );
  }
  if (!pathParam.startsWith('/')) {
    return new Response(
      JSON.stringify({ error: 'path must start with /' }),
      { status: 400, headers: { ...baseHeaders, 'Content-Type': 'application/json' } },
    );
  }
  const hostParam = url.searchParams.get('host') || DEFAULT_HOST;
  if (!ALLOWED_HOSTS.has(hostParam)) {
    return new Response(
      JSON.stringify({ error: `host not allowed: ${hostParam}` }),
      { status: 400, headers: { ...baseHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Forward to Adobe. Pass through the auth headers the caller provided
  // (all are optional from the proxy's perspective).
  const adobeUrl = `https://${hostParam}${pathParam}`;
  const upstreamHeaders: Record<string, string> = {
    'Accept': req.headers.get('Accept') || 'application/json',
  };
  if (authHeader) upstreamHeaders['Authorization'] = authHeader;
  if (clientId) upstreamHeaders['X-API-Key'] = clientId;
  let adobeRes: Response;
  try {
    adobeRes = await fetch(adobeUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'Upstream fetch failed', detail: (e as Error).message }),
      { status: 502, headers: { ...baseHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Stream response back with CORS headers attached. Preserve content-type
  // so JSON responses parse and image responses render correctly.
  const responseHeaders: Record<string, string> = { ...baseHeaders };
  const contentType = adobeRes.headers.get('Content-Type');
  if (contentType) responseHeaders['Content-Type'] = contentType;

  return new Response(adobeRes.body, {
    status: adobeRes.status,
    headers: responseHeaders,
  });
});
