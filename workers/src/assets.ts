/**
 * Embedded admin app (`app/dist`, spec 10.2, 15): served through the `ASSETS` binding, the Worker
 * running first. Navigation routes get `index.html` (no cache, public API key of the environment
 * filled in); hashed files under `/assets/` are cached for a year.
 */
import type { Env } from './env.js';

/** Routes of the admin app (app/src/routes.tsx): the SPA answers them with index.html. */
const APP_ROUTES = [/^\/$/, /^\/units\/?$/, /^\/units\/[^/]+\/?$/, /^\/tracked-items\/?$/, /^\/anomalies\/?$/, /^\/imports\/?$/, /^\/settings\/?$/, /^\/settings\/health\/?$/, /^\/start\/?$/];

const CSP = [
  'frame-ancestors https://admin.shopify.com https://*.myshopify.com',
  "script-src 'self' https://cdn.shopify.com",
  "connect-src 'self' https://cdn.shopify.com https://*.shopify.com",
  "default-src 'self' https://cdn.shopify.com",
  "style-src 'self' 'unsafe-inline' https://cdn.shopify.com",
  "img-src 'self' data: https://cdn.shopify.com",
].join('; ');

export async function serveAdminApp(request: Request, env: Env, url: URL): Promise<Response> {
  if (APP_ROUTES.some((r) => r.test(url.pathname))) {
    const index = await env.ASSETS.fetch(new Request(new URL('/index.html', url), { method: 'GET' }));
    if (!index.ok) return new Response('Admin app not built', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    const html = (await index.text()).replaceAll('%SHOPIFY_API_KEY%', env.SHOPIFY_API_KEY);
    return new Response(request.method === 'HEAD' ? null : html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP },
    });
  }
  const response = await env.ASSETS.fetch(request);
  if (!response.ok || !url.pathname.startsWith('/assets/')) return response;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(response.body, { status: response.status, headers });
}
