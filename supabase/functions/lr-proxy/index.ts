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

const ADOBE_API_BASE = 'https://lr.adobe.io';

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

  // Validate caller credentials
  const authHeader = req.headers.get('Authorization');
  const clientId = req.headers.get('x-adobe-client-id');
  if (!authHeader || !clientId) {
    return new Response(
      JSON.stringify({ error: 'Missing Authorization or x-adobe-client-id header' }),
      { status: 401, headers: { ...baseHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Parse the target path from the query string
  const url = new URL(req.url);
  const pathParam = url.searchParams.get('path');
  if (!pathParam) {
    return new Response(
      JSON.stringify({ error: 'Missing ?path query parameter' }),
      { status: 400, headers: { ...baseHeaders, 'Content-Type': 'application/json' } },
    );
  }
  // Defensive: only allow forwarding to lr.adobe.io paths (prevent SSRF).
  if (!pathParam.startsWith('/')) {
    return new Response(
      JSON.stringify({ error: 'path must start with /' }),
      { status: 400, headers: { ...baseHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Forward to Adobe
  const adobeUrl = `${ADOBE_API_BASE}${pathParam}`;
  let adobeRes: Response;
  try {
    adobeRes = await fetch(adobeUrl, {
      method: req.method,
      headers: {
        'Authorization': authHeader,
        'X-API-Key': clientId,
        'Accept': req.headers.get('Accept') || 'application/json',
      },
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
