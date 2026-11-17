import { describe, expect, it, vi } from 'vitest';
import { exchangeForOfflineToken, exchangeForOnlineToken, refreshOfflineToken, ShopifyOAuthError } from '../src/index.js';
import { API_KEY, API_SECRET, SHOP, json } from './helpers.js';

const NOW = 1_700_000_000_000;

describe('token exchange and refresh (spec 13.9)', () => {
  it('exchanges a session token for an expiring offline token', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json({ access_token: 'shpat_a', expires_in: 3600, refresh_token: 'shprt_r', refresh_token_expires_in: 7776000, scope: 'read_orders' }),
    );
    const set = await exchangeForOfflineToken('jwt', { shop: SHOP, apiKey: API_KEY, apiSecret: API_SECRET, fetch, now: () => NOW });
    expect(set).toEqual({ accessToken: 'shpat_a', accessExpiresAt: NOW + 3_600_000, refreshToken: 'shprt_r', refreshExpiresAt: NOW + 7_776_000_000, scopes: 'read_orders' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      client_id: API_KEY,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'jwt',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    });
  });

  it('refuses a non-expiring answer (no refresh token)', async () => {
    const fetch = async () => json({ access_token: 'shpat_a', scope: '' });
    await expect(exchangeForOfflineToken('jwt', { shop: SHOP, apiKey: API_KEY, apiSecret: API_SECRET, fetch })).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('exchanges for an online token without keeping user details', async () => {
    const fetch = async () => json({ access_token: 'online', expires_in: 86399, scope: 'read_orders', associated_user: { id: 1, email: 'x' } });
    const token = await exchangeForOnlineToken('jwt', { shop: SHOP, apiKey: API_KEY, apiSecret: API_SECRET, fetch, now: () => NOW });
    expect(token).toEqual({ accessToken: 'online', accessExpiresAt: NOW + 86_399_000, scopes: 'read_orders' });
  });

  it('refreshes with the refresh-token grant and classifies errors', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json({ access_token: 'a2', expires_in: 3600, refresh_token: 'r2', refresh_token_expires_in: 7776000, scope: 's' }),
    );
    const set = await refreshOfflineToken('r1', { shop: SHOP, apiKey: API_KEY, apiSecret: API_SECRET, fetch, now: () => NOW });
    expect(set.refreshToken).toBe('r2');
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r1' });

    const refused = async () => json({ error: 'invalid_grant', error_description: 'token r1 is revoked' }, { status: 400 });
    const err = await refreshOfflineToken('r1', { shop: SHOP, apiKey: API_KEY, apiSecret: API_SECRET, fetch: refused }).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyOAuthError);
    expect(err.kind).toBe('invalid_grant');
    expect(err.message).not.toContain('r1'); // descriptions are never copied

    const down = async () => new Response('oops', { status: 503 });
    await expect(refreshOfflineToken('r1', { shop: SHOP, apiKey: API_KEY, apiSecret: API_SECRET, fetch: down })).rejects.toMatchObject({ kind: 'server', retryable: true });
    const offline = async () => {
      throw new TypeError('network');
    };
    await expect(refreshOfflineToken('r1', { shop: SHOP, apiKey: API_KEY, apiSecret: API_SECRET, fetch: offline })).rejects.toMatchObject({ kind: 'network' });
  });
});
