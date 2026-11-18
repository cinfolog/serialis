import { env, SELF } from 'cloudflare:test';
import { vi } from 'vitest';
import { registerInstall, shopStub, type ShopRouting } from '../src/routing.js';

export const SECRET = 'test-secret';
export const API_KEY = env.SHOPIFY_API_KEY;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function signWebhook(body: string, secret = SECRET): Promise<string> {
  const sig = await hmac(secret, body);
  return btoa(String.fromCharCode(...sig));
}

export async function sessionToken(shop: string, overrides: Record<string, unknown> = {}, secret = SECRET): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: API_KEY, sub: '7', exp: now + 60, nbf: now - 1, iat: now - 1, jti: crypto.randomUUID(), sid: 's', ...overrides };
  const h = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const c = b64url(enc.encode(JSON.stringify(claims)));
  return `${h}.${c}.${b64url(await hmac(secret, `${h}.${c}`))}`;
}

export interface WebhookOptions {
  shop: string;
  topic: string;
  body: unknown;
  webhookId?: string;
  triggeredAt?: string;
}

export async function sendWebhook(options: WebhookOptions): Promise<Response> {
  const body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  return SELF.fetch('https://hooks.serialis.dev/webhooks/shopify', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': await signWebhook(body),
      'X-Shopify-Shop-Domain': options.shop,
      'X-Shopify-Topic': options.topic,
      'X-Shopify-Webhook-Id': options.webhookId ?? crypto.randomUUID(),
      ...(options.triggeredAt ? { 'X-Shopify-Triggered-At': options.triggeredAt } : {}),
    },
  });
}

/** Registers and installs a shop without Shopify access (no token exchange). */
export async function installShop(shop: string, placement: Pick<ShopRouting, 'jurisdiction' | 'locationHint'> = { jurisdiction: null, locationHint: null }) {
  const routing = await registerInstall(env, shop, { placement, shopifyShopGid: null });
  const stub = shopStub(env, routing);
  await stub.install({ shopDomain: shop, objectName: routing.objectName, sessionToken: null });
  return { routing, stub };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export interface ShopifyMockOptions {
  /** Offline token responses, in order (the last one repeats). */
  offline?: Array<Response | (() => Response)>;
  online?: () => Response;
  refresh?: Array<(refreshToken: string) => Response | Promise<Response>>;
  graphql?: (body: { query: string; variables?: Record<string, unknown> }, token: string | null) => Response | Promise<Response>;
}

export interface RecordedCall {
  url: string;
  kind: 'offline' | 'online' | 'refresh' | 'graphql' | 'other';
  body: Record<string, unknown>;
  token: string | null;
}

let counter = 0;

/** Default offline token pair, unique per call. */
export function tokenPair(expiresIn = 3600): Response {
  counter += 1;
  return json({ access_token: `shpat_test_${counter}`, expires_in: expiresIn, refresh_token: `shprt_test_${counter}`, refresh_token_expires_in: 7776000, scope: 'read_orders' });
}

/** Stubs the global fetch (seen by the Worker and the objects, same isolate) with a fake Shopify. */
export function mockShopify(options: ShopifyMockOptions = {}) {
  const calls: RecordedCall[] = [];
  const offline = [...(options.offline ?? [])];
  const refresh = [...(options.refresh ?? [])];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const raw = init?.body ? String(init.body) : '{}';
    const body = JSON.parse(raw) as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    const token = headers.get('X-Shopify-Access-Token');
    if (url.endsWith('/admin/oauth/access_token')) {
      if (body.grant_type === 'refresh_token') {
        calls.push({ url, kind: 'refresh', body, token });
        const next = refresh.length > 1 ? refresh.shift()! : refresh[0];
        return next ? next(String(body.refresh_token)) : tokenPair();
      }
      if (body.requested_token_type === 'urn:shopify:params:oauth:token-type:online-access-token') {
        calls.push({ url, kind: 'online', body, token });
        return options.online ? options.online() : json({ access_token: 'online_test', expires_in: 86399, scope: 'read_orders' });
      }
      calls.push({ url, kind: 'offline', body, token });
      const next = offline.length > 1 ? offline.shift()! : offline[0];
      return next ? (typeof next === 'function' ? next() : next.clone()) : tokenPair();
    }
    if (url.includes('/admin/api/2026-10/graphql.json')) {
      calls.push({ url, kind: 'graphql', body, token });
      if (options.graphql) return options.graphql(body as { query: string; variables?: Record<string, unknown> }, token);
      return json({ data: {} });
    }
    calls.push({ url, kind: 'other', body, token });
    return new Response('unexpected', { status: 599 });
  });
  return { calls, spy, of: (kind: RecordedCall['kind']) => calls.filter((c) => c.kind === kind) };
}
