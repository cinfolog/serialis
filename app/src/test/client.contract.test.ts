import { ROUTES, ADMIN_APP_ROUTES, API_KEY_ROUTES, INTERNAL_BASE, INTERNAL_ROUTES, OPERATIONS_ROUTES } from '@serialis/contract';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, CLIENT_ROUTES, HttpClient, type ApiClient } from '../api/client';
import { MockClient } from '../api/mock';

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

function fakeFetch(respond: (call: Call) => Response | Promise<Response> = () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, client: new HttpClient({ fetch: fetchImpl, getToken: async () => 'session-token' }) };
}

/** One call per client method, with plausible arguments. */
const INVOCATIONS: { [K in keyof ApiClient]: (c: ApiClient) => Promise<unknown> } = {
  me: (c) => c.me(),
  homeStats: (c) => c.homeStats(),
  listTrackedItems: (c) => c.listTrackedItems({ limit: 10 }),
  trackItems: (c) => c.trackItems({ variantGids: ['gid://shopify/ProductVariant/1'] }),
  listUnits: (c) => c.listUnits({ q: 'SN', state: ['AVAILABLE', 'HELD'], limit: 5 }),
  getUnit: (c) => c.getUnit('unit 1'),
  unitEvents: (c) => c.unitEvents('unit-1'),
  lookup: (c) => c.lookup('SN-1'),
  checkUnitsBatch: (c) => c.checkUnitsBatch({ variantGid: 'v', locationId: 'l', refs: ['A'], alreadyCounted: false, mode: 'per_item' }),
  createUnitsBatch: (c) => c.createUnitsBatch({ variantGid: 'v', locationId: 'l', refs: ['A'], alreadyCounted: false, mode: 'per_item' }),
  listAnomalies: (c) => c.listAnomalies({ status: 'resolved' }),
  acknowledgeAnomaly: (c) => c.acknowledgeAnomaly('ano-1'),
  resolveAnomaly: (c) => c.resolveAnomaly('ano-1', { action: 'x', params: { ref: 'R' } }),
  listLocations: (c) => c.listLocations(),
  getSettings: (c) => c.getSettings('shop'),
  simulateSettings: (c) => c.simulateSettings({ scope: 'shop', values: { 'S-17': false } }),
  patchSettings: (c) => c.patchSettings({ scope: 'shop', values: { 'S-05': 'manual' } }),
  createImport: (c) => c.createImport({ csv: 'ref,sku,location,already_counted' }),
  confirmImport: (c) => c.confirmImport('imp-1'),
  pause: (c) => c.pause(),
  resume: (c) => c.resume(),
  listApiKeys: (c) => c.listApiKeys(),
  createApiKey: (c) => c.createApiKey({ name: 'ERP', scopes: ['units:read'] }),
  revokeApiKey: (c) => c.revokeApiKey('abcdefghijklmnop'),
  health: (c) => c.health(),
  reviveTask: (c) => c.reviveTask('sync_order:gid://shopify/Order/1'),
  retryWrite: (c) => c.retryWrite(42),
  abandonWrite: (c) => c.abandonWrite(42),
  listAppUsers: (c) => c.listAppUsers(),
  patchAppUser: (c) => c.patchAppUser({ userId: '70003', role: 'admin' }),
};

const methods = Object.keys(INVOCATIONS) as Array<keyof ApiClient>;

describe('Client API ↔ contrat', () => {
  it('declares a route for every client method, and each route exists in the contract', () => {
    expect(Object.keys(CLIENT_ROUTES).sort()).toEqual([...methods].sort());
    for (const route of Object.values(CLIENT_ROUTES)) expect(INTERNAL_ROUTES).toHaveProperty(route);
  });

  it('only uses routes of ROUTES (shared contract) or the documented additions', () => {
    const additions = new Set([...Object.keys(ADMIN_APP_ROUTES), ...Object.keys(API_KEY_ROUTES), ...Object.keys(OPERATIONS_ROUTES)]);
    for (const route of Object.values(CLIENT_ROUTES)) {
      expect(route in ROUTES || additions.has(route)).toBe(true);
    }
    // Spec 14.2: the additions are real resources of the public list.
    expect(Object.values(ADMIN_APP_ROUTES)).toEqual(['GET /stats/home', 'POST /units/batch/check', 'POST /anomalies/{id}/acknowledge', 'POST /settings/simulate']);
    // Key management: the declared exception of 14.2 (interface only, O5).
    expect(Object.values(API_KEY_ROUTES)).toEqual(['GET /api-keys', 'POST /api-keys', 'DELETE /api-keys/{prefix}']);
    // Operations (15.8, 17.1): the health section reads GET /health.
    expect(OPERATIONS_ROUTES.health).toBe('GET /health');
    // Health actions (12.7): internal only, never in PUBLIC_ROUTES.
    expect(OPERATIONS_ROUTES.reviveTask).toBe('POST /health/tasks/{key}/revive');
    // Outbox actions (12.4, route table of the spec): internal only, never in PUBLIC_ROUTES.
    expect(OPERATIONS_ROUTES.retryWrite).toBe('POST /outbox/{id}/retry');
    expect(OPERATIONS_ROUTES.abandonWrite).toBe('POST /outbox/{id}/abandon');
    // Users (15.8): GET/PATCH /app-users.
    expect([OPERATIONS_ROUTES.listAppUsers, OPERATIONS_ROUTES.patchAppUser]).toEqual(['GET /app-users', 'PATCH /app-users']);
  });

  it('the HTTP client implements exactly the methods of the interface, and so does the mock', () => {
    const own = (o: object) => Object.getOwnPropertyNames(Object.getPrototypeOf(o)).filter((n) => n !== 'constructor' && !n.startsWith('_'));
    const http = own(new HttpClient({ getToken: async () => 't' })).filter((n) => n !== 'call' && n !== 'baseUrl');
    expect(http.sort()).toEqual([...methods].sort());
    const mock = new MockClient();
    for (const m of methods) expect(typeof mock[m]).toBe('function');
  });

  it.each(methods)('%s calls the method and path of its contract route, authenticated', async (name) => {
    const { client, calls } = fakeFetch();
    await INVOCATIONS[name](client);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const [verb, template] = INTERNAL_ROUTES[CLIENT_ROUTES[name]].split(' ') as [string, string];
    expect(call.method).toBe(verb);
    const path = new URL(call.url, 'https://app.example').pathname;
    const pattern = new RegExp(`^${INTERNAL_BASE}${template.replace(/\{\w+\}/g, '[^/]+')}$`);
    expect(path).toMatch(pattern);
    expect(call.headers['Authorization']).toBe('Bearer session-token');
    if (verb === 'POST') expect(call.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    else expect(call.headers['Idempotency-Key']).toBeUndefined();
  });

  it('encodes path parameters and query strings (state arrays are comma separated)', async () => {
    const { client, calls } = fakeFetch();
    await client.getUnit('unit 1/x');
    await client.listUnits({ q: 'SN 1', state: ['AVAILABLE', 'HELD'], limit: 5 });
    expect(calls[0]?.url).toBe('/api/v1/units/unit%201%2Fx');
    expect(calls[1]?.url).toBe('/api/v1/units?state=AVAILABLE%2CHELD&q=SN+1&limit=5');
    // A task key carries ':' and '/': one encoded path segment.
    await client.reviveTask('sync_order:gid://shopify/Order/1');
    expect(calls[2]?.url).toBe('/api/v1/health/tasks/sync_order%3Agid%3A%2F%2Fshopify%2FOrder%2F1/revive');
  });

  it('uses the Idempotency-Key given by the caller (replay after a cut) and a fresh one otherwise', async () => {
    const { client, calls } = fakeFetch();
    const req = { variantGid: 'v', locationId: 'l', refs: ['A'], alreadyCounted: true, mode: 'per_item' as const };
    await client.createUnitsBatch(req, { idempotencyKey: 'key-1' });
    await client.createUnitsBatch(req, { idempotencyKey: 'key-1' });
    await client.createUnitsBatch(req);
    expect(calls.map((c) => c.headers['Idempotency-Key']).slice(0, 2)).toEqual(['key-1', 'key-1']);
    expect(calls[2]?.headers['Idempotency-Key']).not.toBe('key-1');
    expect(calls[0]?.body).toEqual(req);
  });
});

describe('Erreurs problem+json', () => {
  const problem = (status: number, body: object, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json', ...headers } });

  it('turns a problem+json response into an ApiError with its stable code, detail and item errors', async () => {
    const { client } = fakeFetch(() =>
      problem(422, { type: 'about:blank', title: 'Invalid', status: 422, code: 'identifier_conflict', detail: 'Ref déjà connue', errors: [{ index: 2, code: 'identifier_conflict' }] }),
    );
    const error = await client.createUnitsBatch({ variantGid: 'v', locationId: 'l', refs: ['A'], alreadyCounted: false, mode: 'atomic' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: 'identifier_conflict', detail: 'Ref déjà connue', errors: [{ index: 2, code: 'identifier_conflict' }] });
  });

  it('keeps Retry-After on 429 and maps 412 to precondition_failed', async () => {
    const limited = fakeFetch(() => problem(429, { type: 'x', title: 'Slow down', status: 429, code: 'rate_limited' }, { 'Retry-After': '7' }));
    await expect(limited.client.me()).rejects.toMatchObject({ code: 'rate_limited', retryAfterSeconds: 7 });
    const stale = fakeFetch(() => problem(412, { type: 'x', title: 'Stale', status: 412, code: 'precondition_failed' }));
    await expect(stale.client.getUnit('u')).rejects.toMatchObject({ code: 'precondition_failed', status: 412 });
  });

  it('falls back on the HTTP status when the body is not a problem document', async () => {
    const forbidden = fakeFetch(() => new Response('Forbidden', { status: 403 }));
    await expect(forbidden.client.pause()).rejects.toMatchObject({ code: 'forbidden' });
    const broken = fakeFetch(() => new Response('<html>oops</html>', { status: 502 }));
    await expect(broken.client.me()).rejects.toMatchObject({ code: 'unknown', status: 502 });
  });

  it('reports a network failure as code "network" (input kept, banner shown by the screens)', async () => {
    const client = new HttpClient({ fetch: (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch, getToken: async () => 't' });
    await expect(client.me()).rejects.toMatchObject({ code: 'network', status: 0 });
  });

  it('retries exactly once with a fresh token when Shopify says the session token was invalid', async () => {
    const getToken = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('fresh');
    let n = 0;
    const seen: string[] = [];
    const client = new HttpClient({
      getToken,
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        seen.push((init?.headers as Record<string, string>)['Authorization'] ?? '');
        return n++ === 0
          ? new Response('', { status: 401, headers: { 'X-Shopify-Retry-Invalid-Session-Request': '1' } })
          : new Response('{"shop":"s"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch,
    });
    await expect(client.me()).resolves.toMatchObject({ shop: 's' });
    expect(seen).toEqual(['Bearer old', 'Bearer fresh']);
  });

  it('returns undefined for 204 and reports a missing session token as unauthenticated', async () => {
    const empty = fakeFetch(() => new Response(null, { status: 204 }));
    await expect(empty.client.me()).resolves.toBeUndefined();
    const noToken = new HttpClient({ fetch: (async () => new Response('{}')) as typeof fetch, getToken: async () => { throw new Error('no bridge'); } });
    await expect(noToken.me()).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
