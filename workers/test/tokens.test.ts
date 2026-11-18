import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenCipher } from '../src/crypto.js';
import type { ShopStore } from '../src/shop-store.js';
import { installShop, json, mockShopify, tokenPair } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const KEY_1 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const KEY_2 = 'Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=';

/** Installs a shop and runs the offline token exchange. */
async function installWithToken(shop: string) {
  const { routing, stub } = await installShop(shop);
  await stub.install({ shopDomain: shop, objectName: routing.objectName, sessionToken: 'session-jwt' });
  return stub;
}

async function expireSoon(stub: DurableObjectStub<ShopStore>, inMs = 60_000) {
  await runInDurableObject(stub, (_s: ShopStore, state: DurableObjectState) => {
    state.storage.sql.exec('UPDATE shopify_token SET access_expires_at = ?', Date.now() + inMs);
  });
}

async function tokenStatus(stub: DurableObjectStub<ShopStore>) {
  return (await stub.status()).token;
}

describe('token encryption (spec 16)', () => {
  it('round-trips, binds the ciphertext to its shop and field, supports key rotation', async () => {
    const v1 = await TokenCipher.fromSecret(KEY_1);
    const blob = await v1.encrypt('shpat_x', 'shop-a:access');
    expect(await v1.decrypt(blob, 1, 'shop-a:access')).toBe('shpat_x');
    await expect(v1.decrypt(blob, 1, 'shop-b:access')).rejects.toThrow();

    const rotated = await TokenCipher.fromSecret(`2:${KEY_2},1:${KEY_1}`);
    expect(rotated.currentVersion).toBe(2);
    expect(await rotated.decrypt(blob, 1, 'shop-a:access')).toBe('shpat_x');
    const blob2 = await rotated.encrypt('shpat_y', 'shop-a:access');
    expect(await rotated.decrypt(blob2, 2, 'shop-a:access')).toBe('shpat_y');

    await expect(TokenCipher.fromSecret('')).rejects.toThrow(/not configured/);
    await expect(TokenCipher.fromSecret('c2hvcnQ=')).rejects.toThrow(/32-byte/);
  });
});

describe('expiring offline token in the shop object (spec 13.9)', () => {
  it('refreshes before expiry and keeps the used refresh token as previous', async () => {
    const mock = mockShopify({ offline: [() => tokenPair()] });
    const stub = await installWithToken('refresh-example.myshopify.com');
    const first = await stub.accessToken();
    expect(mock.of('refresh')).toHaveLength(0);

    await expireSoon(stub); // expires in 1 min < 5 min margin
    const second = await stub.accessToken();
    expect(second).not.toBe(first);
    expect(mock.of('refresh')).toHaveLength(1);
    const usedRefresh = String(mock.of('refresh')[0]!.body.refresh_token);
    expect(usedRefresh).toMatch(/^shprt_test_/);
    expect(await stub.accessToken()).toBe(second); // fresh again, no new refresh
    expect(mock.of('refresh')).toHaveLength(1);

    await runInDurableObject(stub, (_s: ShopStore, state: DurableObjectState) => {
      const row = state.storage.sql.exec<{ previous_refresh_token_enc: ArrayBuffer | null }>('SELECT previous_refresh_token_enc FROM shopify_token').one();
      expect(row.previous_refresh_token_enc).not.toBeNull();
    });
  });

  it('serialises concurrent refreshes into one call', async () => {
    const mock = mockShopify();
    const stub = await installWithToken('concurrent-example.myshopify.com');
    await expireSoon(stub);
    const tokens = await Promise.all([stub.accessToken(), stub.accessToken(), stub.accessToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(mock.of('refresh')).toHaveLength(1);
  });

  it('falls back to the previous refresh token when the current one is refused', async () => {
    const refusedOnce = vi.fn((_t: string) => json({ error: 'invalid_grant' }, 400));
    const mock = mockShopify({ refresh: [() => tokenPair(), refusedOnce, () => tokenPair()] });
    const stub = await installWithToken('fallback-example.myshopify.com');
    await expireSoon(stub);
    await stub.accessToken(); // refresh 1: R0 → R1 (previous = R0)
    await expireSoon(stub);
    await stub.accessToken(); // refresh 2: R1 refused, R0 accepted
    const used = mock.of('refresh').map((c) => String(c.body.refresh_token));
    expect(used).toHaveLength(3);
    expect(used[2]).toBe(used[0]);
    expect(await tokenStatus(stub)).toBe('valid');
  });

  it('marks reconnect_required when every refresh token is refused, recovers with a new exchange', async () => {
    mockShopify({ refresh: [() => json({ error: 'invalid_grant' }, 400)] });
    const stub = await installWithToken('lost-example.myshopify.com');
    await expireSoon(stub);
    await runInDurableObject(stub, async (store: ShopStore) => {
      await expect(store.accessToken()).rejects.toThrow(/refused the refresh tokens/);
      await expect(store.accessToken()).rejects.toThrow(/no usable Shopify token/);
    });
    expect(await tokenStatus(stub)).toBe('reconnect_required');
    const anomaly = (status: string) =>
      runInDurableObject(stub, (_s: ShopStore, state: DurableObjectState) => state.storage.sql.exec("SELECT severity FROM anomalies WHERE type = 'reconnect_required' AND status = ?", status).toArray());
    // 12.7: critical anomaly while the merchant must reopen the app.
    expect(await anomaly('open')).toEqual([{ severity: 'critical' }]);
    // Next opening of the app: the token exchange gives a new pair.
    await stub.install({ shopDomain: 'lost-example.myshopify.com', objectName: 'global:lost-example.myshopify.com', sessionToken: 'session-jwt' });
    expect(await tokenStatus(stub)).toBe('valid');
    expect(await anomaly('open')).toEqual([]);
    expect(await anomaly('auto_resolved')).toHaveLength(1);
  });

  it('keeps the current access token while Shopify is unreachable', async () => {
    mockShopify({ refresh: [() => new Response('', { status: 503 })] });
    const stub = await installWithToken('outage-example.myshopify.com');
    const current = await stub.accessToken();
    await expireSoon(stub, 120_000); // still valid for 2 min
    expect(await stub.accessToken()).toBe(current);
    expect(await tokenStatus(stub)).toBe('valid');
  });
});
