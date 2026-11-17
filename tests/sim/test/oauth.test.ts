import { describe, expect, it } from 'vitest';
import { OFFLINE_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT } from '../src/index.js';
import { fixture } from './helpers.js';

const URL = 'https://sim-shop.myshopify.com/admin/oauth/access_token';
const post = (f: ReturnType<typeof fixture>, body: Record<string, string>, asJson = true) =>
  f.sim.fetch(new Request(URL, asJson ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() }));
const exchange = { client_id: 'id', client_secret: 'secret', grant_type: TOKEN_EXCHANGE_GRANT, subject_token: 'session.jwt', subject_token_type: 'urn:ietf:params:oauth:token-type:id_token', requested_token_type: OFFLINE_TOKEN_TYPE };
const ping = (f: ReturnType<typeof fixture>, token: string) =>
  f.sim.fetch(new Request('https://sim-shop.myshopify.com/admin/api/2026-10/graphql.json', { method: 'POST', headers: { 'X-Shopify-Access-Token': token }, body: '{"query":"{ shop { name } }"}' }));

describe('oauth', () => {
  it('token exchange returns an expiring offline token with a refresh token', async () => {
    const f = fixture();
    const r = await post(f, exchange);
    const b = (await r.json()) as Record<string, any>;
    expect(r.status).toBe(200);
    expect(b).toMatchObject({ expires_in: 3600 });
    expect(b['access_token']).toMatch(/^shpat_/);
    expect(b['refresh_token']).toMatch(/^shprt_/);
    expect(b['scope']).toContain('read_orders');
    expect((await post(f, { ...exchange, requested_token_type: 'nope' }, false)).status).toBe(400);
    expect((await post(f, { ...exchange, subject_token: '' })).status).toBe(400);
  });

  it('refresh rotates tokens; the old refresh token works until the new access token is used (lost response)', async () => {
    const f = fixture({ enforceAuth: true });
    const first = (await (await post(f, exchange)).json()) as Record<string, string>;
    expect((await ping(f, first['access_token']!)).status).toBe(200);
    const refresh = (rt: string) => post(f, { client_id: 'id', client_secret: 'secret', grant_type: 'refresh_token', refresh_token: rt });
    const lost = (await (await refresh(first['refresh_token']!)).json()) as Record<string, string>;
    const retry = (await (await refresh(first['refresh_token']!)).json()) as Record<string, string>;
    expect(retry['access_token']).not.toBe(lost['access_token']);
    expect((await ping(f, retry['access_token']!)).status).toBe(200);
    expect((await refresh(first['refresh_token']!)).status).toBe(400);
    expect((await refresh(retry['refresh_token']!)).status).toBe(200);
  });

  it('access tokens expire with the sim clock; invalid tokens are 401', async () => {
    const f = fixture({ enforceAuth: true });
    const t = (await (await post(f, exchange)).json()) as Record<string, string>;
    expect((await ping(f, 'bogus')).status).toBe(401);
    f.sim.clock.advance(3601 * 1000);
    expect((await ping(f, t['access_token']!)).status).toBe(401);
  });

  it('oauth faults: lost refresh response (applied) and 5xx', async () => {
    const f = fixture();
    f.sim.faults.add({ operation: 'oauth', calls: 1, fault: { kind: 'timeout', applied: true } });
    f.sim.faults.add({ operation: 'oauth', calls: 2, fault: { kind: 'http', status: 502 } });
    await expect(post(f, exchange)).rejects.toThrow();
    expect(f.sim.oauth.issued).toBe(1);
    expect((await post(f, exchange)).status).toBe(502);
    expect((await post(f, exchange)).status).toBe(200);
  });
});
