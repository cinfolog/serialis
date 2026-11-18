import { describe, expect, it } from 'vitest';
import { SessionTokenError, sessionTokenFromRequest, verifySessionToken } from '../src/index.js';
import { API_KEY, API_SECRET, SHOP, sessionClaims, signJwt } from './helpers.js';

const NOW = 1_700_000_000_000;
const nowSec = NOW / 1000;
const opts = { apiKey: API_KEY, apiSecret: API_SECRET, now: () => NOW };

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (e) {
    expect(e).toBeInstanceOf(SessionTokenError);
    return (e as SessionTokenError).reason;
  }
}

describe('session token verification (spec 16)', () => {
  it('accepts a valid token and returns the shop from dest', async () => {
    const token = await signJwt(sessionClaims(SHOP, nowSec));
    const verified = await verifySessionToken(token, opts);
    expect(verified.shop).toBe(SHOP);
    expect(verified.userId).toBe('42');
    expect(verified.expiresAt).toBe((nowSec + 60) * 1000);
  });

  it('rejects an expired token, with a small leeway', async () => {
    const justExpired = await signJwt(sessionClaims(SHOP, nowSec, { exp: nowSec - 2 }));
    expect(await reason(verifySessionToken(justExpired, opts))).toBe('accepted'); // within 5 s leeway
    const expired = await signJwt(sessionClaims(SHOP, nowSec, { exp: nowSec - 30 }));
    expect(await reason(verifySessionToken(expired, opts))).toBe('expired');
    const future = await signJwt(sessionClaims(SHOP, nowSec, { nbf: nowSec + 60 }));
    expect(await reason(verifySessionToken(future, opts))).toBe('not_yet_valid');
  });

  it('rejects a wrong audience', async () => {
    const token = await signJwt(sessionClaims(SHOP, nowSec, { aud: 'another-app' }));
    expect(await reason(verifySessionToken(token, opts))).toBe('wrong_audience');
  });

  it('rejects a bad signature, alg none and malformed tokens', async () => {
    const forged = await signJwt(sessionClaims(SHOP, nowSec), 'not-the-secret');
    expect(await reason(verifySessionToken(forged, opts))).toBe('bad_signature');
    const none = await signJwt(sessionClaims(SHOP, nowSec), API_SECRET, { alg: 'none' });
    expect(await reason(verifySessionToken(none, opts))).toBe('unsupported_algorithm');
    expect(await reason(verifySessionToken('a.b', opts))).toBe('malformed');
    expect(await reason(verifySessionToken(null, opts))).toBe('missing');
    // Tampered payload with the original signature.
    const valid = await signJwt(sessionClaims(SHOP, nowSec));
    const [h, , s] = valid.split('.');
    const other = (await signJwt(sessionClaims('other.myshopify.com', nowSec))).split('.')[1];
    expect(await reason(verifySessionToken(`${h}.${other}.${s}`, opts))).toBe('bad_signature');
  });

  it('rejects cross-shop tokens', async () => {
    const mixed = await signJwt(sessionClaims(SHOP, nowSec, { iss: 'https://other.myshopify.com/admin' }));
    expect(await reason(verifySessionToken(mixed, opts))).toBe('shop_mismatch');
    const token = await signJwt(sessionClaims(SHOP, nowSec));
    expect(await reason(verifySessionToken(token, { ...opts, expectedShop: 'other.myshopify.com' }))).toBe('shop_mismatch');
    const notShopify = await signJwt(sessionClaims(SHOP, nowSec, { dest: 'https://evil.example.com', iss: 'https://evil.example.com/admin' }));
    expect(await reason(verifySessionToken(notShopify, opts))).toBe('invalid_shop');
  });

  it('reads the bearer token from the request', () => {
    const req = new Request('https://app.example/api/me', { headers: { Authorization: 'Bearer abc.def.ghi' } });
    expect(sessionTokenFromRequest(req)).toBe('abc.def.ghi');
    expect(sessionTokenFromRequest(new Request('https://app.example/'))).toBeNull();
  });
});
