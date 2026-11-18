import { base64UrlEncode } from '../src/util.js';

export const API_KEY = 'test-api-key';
export const API_SECRET = 'test-secret';
export const SHOP = 'example.myshopify.com';

/** Signs a JWT (HS256) like App Bridge does. */
export async function signJwt(claims: Record<string, unknown>, secret = API_SECRET, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): Promise<string> {
  const enc = new TextEncoder();
  const h = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const c = base64UrlEncode(enc.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${h}.${c}`)));
  return `${h}.${c}.${base64UrlEncode(sig)}`;
}

export function sessionClaims(shop = SHOP, nowSec = Math.floor(Date.now() / 1000), overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `https://${shop}/admin`,
    dest: `https://${shop}`,
    aud: API_KEY,
    sub: '42',
    exp: nowSec + 60,
    nbf: nowSec - 1,
    iat: nowSec - 1,
    jti: 'jti-1',
    sid: 'sid-1',
    ...overrides,
  };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
}

/** A fake clock whose sleep advances time instantly. */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}
