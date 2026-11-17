import { describe, expect, it, vi } from 'vitest';
import { AdminGraphqlClient, CostThrottle, ShopifyError, firstUserErrors, type ClientEvent } from '../src/index.js';
import { SHOP, fakeClock, json } from './helpers.js';

function cost(currentlyAvailable: number, requested = 10, maximumAvailable = 1000, restoreRate = 100) {
  return { cost: { requestedQueryCost: requested, actualQueryCost: requested, throttleStatus: { maximumAvailable, currentlyAvailable, restoreRate } } };
}

function setup(responses: Array<Response | Error>, extra: Partial<ConstructorParameters<typeof AdminGraphqlClient>[0]> = {}) {
  const clock = fakeClock();
  const events: ClientEvent[] = [];
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const throttle = new CostThrottle({ now: clock.now });
  const client = new AdminGraphqlClient({ shop: SHOP, accessToken: 'shpat_secret', fetch, throttle, now: clock.now, sleep: clock.sleep, random: () => 1, onEvent: (e) => events.push(e), ...extra });
  return { client, fetch, clock, events, throttle };
}

describe('Admin GraphQL client (spec 12.4, 12.8)', () => {
  it('posts to the 2026-10 endpoint with the token header and returns data', async () => {
    const { client, fetch } = setup([json({ data: { shop: { id: 'gid://shopify/Shop/1' } }, extensions: cost(990) })]);
    const res = await client.request<{ shop: { id: string } }>('{ shop { id } }');
    expect(res.data.shop.id).toBe('gid://shopify/Shop/1');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://${SHOP}/admin/api/2026-10/graphql.json`);
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_secret');
  });

  it('waits when the bucket estimate is too low', async () => {
    const { client, clock, events } = setup([json({ data: { a: 1 }, extensions: cost(20, 10) }), json({ data: { a: 2 }, extensions: cost(0, 10) })]);
    await client.request('{ a }', { estimatedCost: 10 });
    // 20 points left, next request estimated at 100: (100 - 20) / 100 pts/s = 800 ms wait.
    await client.request('{ a }', { estimatedCost: 100 });
    expect(clock.sleeps).toEqual([800]);
    expect(events).toContainEqual({ type: 'throttle_wait', ms: 800, reason: 'bucket' });
  });

  it('replays THROTTLED after the bucket refills, without counting a failure', async () => {
    const throttled = () => json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: cost(5, 205) });
    const { client, fetch, clock } = setup([throttled(), throttled(), throttled(), throttled(), throttled(), json({ data: { ok: true }, extensions: cost(800) })], { maxRetries: 1 });
    const res = await client.request('{ ok }');
    expect(res.data).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(6);
    // (205 - 5) / 100 = 2 s per replay.
    expect(clock.sleeps.filter((ms) => ms === 2000).length).toBeGreaterThanOrEqual(5);
  });

  it('retries 5xx and network errors with exponential backoff, then fails with a typed error', async () => {
    const { client, clock, events } = setup([new TypeError('reset'), new Response('', { status: 502 }), json({ data: { ok: 1 }, extensions: cost(900) })]);
    expect((await client.request('{ ok }')).data).toEqual({ ok: 1 });
    expect(clock.sleeps).toEqual([500, 1000]);
    expect(events.filter((e) => e.type === 'retry').map((e) => (e as { kind: string }).kind)).toEqual(['network', 'server']);

    const failing = setup([new Response('', { status: 500 }), new Response('', { status: 500 }), new Response('', { status: 500 })], { maxRetries: 2 });
    const error = await failing.client.request('{ ok }').catch((e) => e);
    expect(error).toBeInstanceOf(ShopifyError);
    expect(error.kind).toBe('server');
    expect(failing.fetch).toHaveBeenCalledTimes(3);
  });

  it('honours Retry-After on 429', async () => {
    const { client, clock } = setup([new Response('', { status: 429, headers: { 'Retry-After': '3' } }), json({ data: { ok: 1 }, extensions: cost(900) })]);
    await client.request('{ ok }');
    expect(clock.sleeps).toEqual([3000]);
  });

  it('does not retry auth, frozen and GraphQL errors, and never leaks the token', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [402, 'frozen'], [423, 'frozen'], [404, 'not_found']] as const) {
      const { client, fetch } = setup([new Response('', { status })]);
      const error = await client.request('{ ok }').catch((e) => e);
      expect(error).toMatchObject({ kind, status });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(error.message)).not.toContain('shpat_secret');
    }
    const { client } = setup([json({ errors: [{ message: "Field 'x' doesn't exist", extensions: { code: 'undefinedField' } }] })]);
    await expect(client.request('{ x }', { variables: { secret: 'v' } })).rejects.toMatchObject({ kind: 'graphql', codes: ['undefinedField'] });
  });

  it('uses a token provider called before each attempt', async () => {
    const provider = vi.fn(async () => 'fresh');
    const { client, fetch } = setup([new Response('', { status: 503 }), json({ data: { ok: 1 } })], { accessToken: provider });
    await client.request('{ ok }');
    expect(provider).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1]![1].headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('fresh');
  });

  it('extracts userErrors of a mutation', () => {
    expect(firstUserErrors({ metafieldsSet: { metafields: [], userErrors: [{ code: 'INVALID', message: 'bad' }] } })).toEqual([{ code: 'INVALID', message: 'bad' }]);
    expect(firstUserErrors({ shop: { id: '1' } })).toEqual([]);
  });
});
