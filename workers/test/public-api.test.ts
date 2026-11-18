/**
 * Public API with API keys (spec 14.1, 11.2 `api_keys`, 11.3, 16): key management on the internal
 * surface, seal and secret checks, scopes, idempotency, If-Match, pagination, rate limit, and the
 * OpenAPI contract. T-API-01, T-SEC-01 and T-SEC-02 (API key parts).
 */
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { PUBLIC_ROUTES, type ApiKey, type CreateApiKeyResponse } from '@serialis/contract';
import { openApiDocument } from '@serialis/contract/openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeSeal, currentSealVersion, issueApiKey, parseApiKey, publicPartOf, sealSecrets, verifySeal } from '../src/public-api/keys.js';
import { matchPublicRoute } from '../src/public-api/object.js';
import { TokenBucketLimiter } from '../src/public-api/rate-limit.js';
import { publicApiBase } from '../src/public-api/worker.js';
import type { ShopStore } from '../src/shop-store.js';
import type { Env } from '../src/env.js';
import { createHarness, json, track, type Harness } from './e2e-harness.js';
import { installShop } from './helpers.js';

const harnesses: Harness[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (harnesses.length) harnesses.pop()!.restore();
});

const API = 'https://api.serialis.dev/v1';
const STAGING_PUBLIC = 'https://staging.serialis.dev/public/v1';

async function setup(name: string) {
  const h = await createHarness(name);
  harnesses.push(h);
  const loc = h.sim.addLocation('Main');
  const { variantIds } = h.sim.addProduct('Bike', [{ sku: 'BIKE-M', stock: { [loc]: 0 } }]);
  return { h, loc, variant: variantIds[0]! };
}

async function createKey(h: Harness, scopes: string[], name = 'ERP'): Promise<CreateApiKeyResponse> {
  return json<CreateApiKeyResponse>(await h.api('POST', '/api-keys', { name, scopes }), 201);
}

function pub(key: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, base = API): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
      ...headers,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return SELF.fetch(`${base}${path}`, init);
}

const ALL = ['units:read', 'units:write', 'allocations:read', 'allocations:write', 'anomalies:read', 'anomalies:write', 'admin'];

/** Same public part, another seal (the attacker does not have the sealing secret). */
function withSeal(key: string, seal: string): string {
  const parsed = parseApiKey(key)!;
  return `${parsed.publicPart}_${seal}.${parsed.secret}`;
}

describe('API key format and seal (14.1)', () => {
  it('issues a sealed key whose secret is split at the last dot, and verifies the seal of each configured version', async () => {
    const issued = await issueApiKey(env, 'format-shop.myshopify.com', 'eu');
    const parsed = parseApiKey(issued.key)!;
    expect(parsed).toMatchObject({ version: 1, location: 'eu', shop: 'format-shop.myshopify.com', prefix: issued.prefix });
    expect(issued.key.startsWith(`srl_1_eu_format-shop.myshopify.com_${issued.prefix}_`)).toBe(true);
    expect(parsed.seal).toMatch(/^[0-9a-f]{32}$/); // 128 bits
    expect(await verifySeal(env, parsed)).toBe(true);
    expect(await verifySeal(env, { ...parsed, seal: '0'.repeat(32) })).toBe(false);
    // Another shop in the same public part: the seal no longer matches.
    const moved = parseApiKey(issued.key.replace('format-shop', 'other-shop'))!;
    expect(await verifySeal(env, moved)).toBe(false);
    for (const bad of ['', 'srl_1_eu_x.myshopify.com', 'srl_1_mars_a.myshopify.com_aaaaaaaaaaaaaaaa_' + '0'.repeat(32) + '.' + 'A'.repeat(43), issued.key + '_x']) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });

  it('rotation: a new version seals new keys, keys of the older version stay valid', async () => {
    const rotated = { ...env, API_KEY_SEAL_SECRET_V2: 'second-sealing-secret-for-tests' } as unknown as Env;
    expect([...sealSecrets(rotated).keys()].sort()).toEqual([1, 2]);
    expect(currentSealVersion(rotated)).toBe(2);
    const old = parseApiKey((await issueApiKey(env, 'rot.myshopify.com', 'global')).key)!;
    const fresh = parseApiKey((await issueApiKey(rotated, 'rot.myshopify.com', 'global')).key)!;
    expect(fresh.version).toBe(2);
    expect(await verifySeal(rotated, old)).toBe(true);
    expect(await verifySeal(rotated, fresh)).toBe(true);
    expect(await verifySeal(env, fresh)).toBe(false); // V2 unknown before the rotation
    expect(await computeSeal('x'.repeat(16), publicPartOf(1, 'eu', 'a.myshopify.com', 'abcdefghijklmnop'))).toHaveLength(32);
  });

  it('token bucket: burst of 100, then 20 per second', () => {
    const limiter = new TokenBucketLimiter();
    for (let i = 0; i < 100; i++) expect(limiter.take('k', 1_000).allowed).toBe(true);
    const refused = limiter.take('k', 1_000);
    expect(refused).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 1, limit: 100 });
    expect(limiter.take('k', 1_050).allowed).toBe(true); // 50 ms = 1 token
    expect(limiter.take('k', 1_050).allowed).toBe(false);
    expect(limiter.take('other', 1_050).allowed).toBe(true); // per key
    const later = limiter.take('k', 6_050); // 5 s later: full again
    expect(later.remaining).toBe(99);
  });

  it('routing rule: api.* host under /v1; /public/v1 on the other hosts except in production', () => {
    expect(publicApiBase(new URL('https://api.serialis.dev/v1/units'), { ENVIRONMENT: 'production' })).toBe('/v1');
    expect(publicApiBase(new URL('https://app.serialis.dev/public/v1/units'), { ENVIRONMENT: 'production' })).toBeNull();
    expect(publicApiBase(new URL('https://staging.serialis.dev/public/v1/units'), { ENVIRONMENT: 'staging' })).toBe('/public/v1');
    expect(publicApiBase(new URL('https://staging.serialis.dev/api/v1/units'), { ENVIRONMENT: 'staging' })).toBeNull();
  });
});

describe('API key management (15.4 Réglages › API, 11.2)', () => {
  it('shows the full key once, lists only its hint, never stores the secret in clear, audits create and revoke', async () => {
    const { h } = await setup('keys');
    const created = await createKey(h, ['units:read', 'units:write']);
    expect(created.key.startsWith(`srl_1_global_${h.shop}_${created.apiKey.prefix}_`)).toBe(true);
    expect(created.apiKey).toMatchObject({ name: 'ERP', scopes: ['units:read', 'units:write'], lastUsedAt: null, revokedAt: null, createdBy: '7' });
    const secret = parseApiKey(created.key)!.secret;

    const list = await json<{ items: ApiKey[] }>(await h.api('GET', '/api-keys'), 200);
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(JSON.stringify(list)).not.toContain(parseApiKey(created.key)!.seal);
    expect(list.items[0]!.hint).toBe(`srl_1_global_${h.shop}_${created.apiKey.prefix}_…`);

    // Neither the secret nor the full key is anywhere in the shop's database (only its SHA-256).
    const dump = await runInDurableObject(h.stub, (_s: ShopStore, state: DurableObjectState) => {
      const sql = state.storage.sql;
      const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray();
      const dec = new TextDecoder();
      return tables
        .map(({ name }) => JSON.stringify(sql.exec(`SELECT * FROM "${name}"`).toArray().map((r) => Object.values(r).map((v) => (v instanceof ArrayBuffer ? dec.decode(v) : v)))))
        .join('\n');
    });
    expect(dump).not.toContain(secret);
    const hash = await h.query<{ n: number }>('SELECT length(hash) AS n FROM api_keys');
    expect(hash[0]!.n).toBe(32);

    // Works, then revoked: refused at once (no cache outside the object).
    expect((await pub(created.key, 'GET', '/units')).status).toBe(200);
    expect((await h.api('DELETE', `/api-keys/${created.apiKey.prefix}`)).status).toBe(204);
    expect((await h.api('DELETE', `/api-keys/${created.apiKey.prefix}`)).status).toBe(204);
    const revoked = await pub(created.key, 'GET', '/units');
    expect(await json(revoked, 401)).toMatchObject({ code: 'unauthenticated', detail: 'api_key_revoked' });
    const after = await json<{ items: ApiKey[] }>(await h.api('GET', '/api-keys'), 200);
    expect(after.items[0]!.revokedAt).not.toBeNull();
    expect(after.items[0]!.lastUsedAt).not.toBeNull();
    expect((await h.api('DELETE', '/api-keys/unknownprefixxxx')).status).toBe(404);
    const audit = await h.query<{ action: string; actor_type: string }>("SELECT action, actor_type FROM audit_log WHERE action LIKE 'api_key.%' ORDER BY id");
    expect(audit).toEqual([{ action: 'api_key.create', actor_type: 'user' }, { action: 'api_key.revoke', actor_type: 'user' }]);
    // The creation response is not kept for replay (it carries the secret).
    expect(await h.query('SELECT key FROM api_idempotency')).toEqual([]);
  });

  it('validates name and scopes; an API key can never manage keys (O5)', async () => {
    const { h } = await setup('keys-val');
    expect(await json(await h.api('POST', '/api-keys', { name: '', scopes: ['units:read'] }), 422)).toMatchObject({ code: 'validation_failed' });
    expect(await json(await h.api('POST', '/api-keys', { name: 'x', scopes: [] }), 422)).toMatchObject({ code: 'validation_failed' });
    expect(await json(await h.api('POST', '/api-keys', { name: 'x', scopes: ['webhooks:manage'] }), 422)).toMatchObject({ code: 'validation_failed' });
    const { key } = await createKey(h, ALL);
    expect((await pub(key, 'GET', '/api-keys')).status).toBe(404);
    expect((await pub(key, 'POST', '/api-keys', { name: 'y', scopes: ['admin'] })).status).toBe(404);
    expect(await h.query('SELECT prefix FROM api_keys')).toHaveLength(1);
  });
});

describe('T-API-01 — public API', () => {
  it('creates units with idempotency (replay, 409 on another body, 400 without key) and reads them back', async () => {
    const { h, loc, variant } = await setup('api01');
    await track(h, [variant]);
    const { key } = await createKey(h, ['units:read', 'units:write']);

    const body = { variantGid: variant, locationId: loc, ref: 'SN-0001', alreadyCounted: false };
    const first = await pub(key, 'POST', '/units', body, { 'Idempotency-Key': 'create-1' });
    const unit = await json(first, 201);
    expect(unit).toMatchObject({ ref: 'SN-0001', variantGid: variant, locationId: loc, state: 'AVAILABLE', version: 0 });
    expect(first.headers.get('ETag')).toBe('"u0"');
    const replay = await pub(key, 'POST', '/units', body, { 'Idempotency-Key': 'create-1' });
    expect(await json(replay, 201)).toEqual(unit);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    const conflict = await pub(key, 'POST', '/units', { ...body, ref: 'SN-0002' }, { 'Idempotency-Key': 'create-1' });
    expect(await json(conflict, 409)).toMatchObject({ code: 'idempotency_conflict' });
    const noKey = await SELF.fetch(`${API}/units`, { method: 'POST', body: JSON.stringify(body), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
    expect(await json(noKey, 400)).toMatchObject({ code: 'validation_failed' });
    const duplicate = await pub(key, 'POST', '/units', body);
    expect(await json(duplicate, 422)).toMatchObject({ code: 'identifier_conflict' });

    const batch = await json(await pub(key, 'POST', '/units/batch', { variantGid: variant, locationId: loc, refs: ['SN-0002', 'SN-0003', 'SN-0004', 'SN-0005', 'SN-0006', 'SN-0007'], alreadyCounted: false, mode: 'atomic' }), 201);
    expect(batch.created).toHaveLength(6);
    expect(await json(await pub(key, 'GET', '/lookup?identifier=SN-0004'), 200)).toMatchObject({ unit: { ref: 'SN-0004' } });
    const read = await pub(key, 'GET', `/units/${unit.id}`);
    expect(read.headers.get('ETag')).toBe('"u0"');
    // Events are attributed to the key (P-05 review of a leaked key's actions).
    const events = await h.query<{ actor_type: string; actor_id: string; cause_type: string }>('SELECT actor_type, actor_id, cause_type FROM unit_events WHERE unit_id = ?', unit.id);
    expect(events[0]).toMatchObject({ actor_type: 'api_key', actor_id: parseApiKey(key)!.prefix, cause_type: 'api_request' });

    // Cursor pagination complete and stable.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: Array<{ ref: string }>; nextCursor: string | null } = await json(await pub(key, 'GET', `/units?limit=3${cursor ? `&cursor=${cursor}` : ''}`), 200);
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((u) => u.ref));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(['SN-0001', 'SN-0002', 'SN-0003', 'SN-0004', 'SN-0005', 'SN-0006', 'SN-0007']);
  });

  it('enforces the scopes of the 14.1 table; If-Match stale gives 412; same API through /public/v1 on staging', async () => {
    const { h, loc, variant } = await setup('scopes');
    await track(h, [variant]);
    const reader = (await createKey(h, ['units:read'], 'reader')).key;
    const admin = (await createKey(h, ['admin'], 'admin')).key;

    const denied = await pub(reader, 'POST', '/units', { variantGid: variant, locationId: loc, ref: 'X-1', alreadyCounted: false });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'forbidden', detail: 'insufficient_scope: units:write required' });
    expect(denied.headers.get('WWW-Authenticate')).toContain('insufficient_scope');
    expect((await pub(reader, 'GET', '/anomalies')).status).toBe(403);
    expect((await pub(reader, 'GET', '/settings?scope=shop')).status).toBe(403);
    expect((await pub(reader, 'POST', '/automation/pause')).status).toBe(403);
    expect((await pub(reader, 'GET', '/units')).status).toBe(200);
    expect((await pub(admin, 'GET', '/units')).status).toBe(403); // admin does not imply the other scopes
    // Session and home screen are not part of the public API.
    expect((await pub(admin, 'GET', '/me')).status).toBe(404);
    expect((await pub(admin, 'GET', '/stats/home')).status).toBe(404);
    expect((await pub(reader, 'PUT', '/units')).status).toBe(405);

    const settings = await pub(admin, 'GET', '/settings?scope=shop');
    const etag = settings.headers.get('ETag')!;
    expect(etag).toMatch(/^"s\d+"$/);
    expect((await pub(admin, 'PATCH', '/settings', { scope: 'shop', values: { 'S-08': 'first' } }, { 'If-Match': etag })).status).toBe(200);
    const stale = await pub(admin, 'PATCH', '/settings', { scope: 'shop', values: { 'S-08': 'last' } }, { 'If-Match': etag });
    expect(await json(stale, 412)).toMatchObject({ code: 'precondition_failed' });

    const staging = await pub(reader, 'GET', '/units', undefined, {}, STAGING_PUBLIC);
    expect(staging.status).toBe(200);
    expect(staging.headers.get('RateLimit-Limit')).toBe('100');
  });

  it('a stock-writing resolution requires admin; a resolution without stock write requires anomalies:write', async () => {
    const { h } = await setup('resolve-scope');
    await h.run(
      `INSERT INTO anomalies (id, type, severity, subject, fingerprint, fingerprint_key, status, detected_at, updated_at)
       VALUES ('ano-v', 'unit_to_verify', 'warning', '{}', 'fp-v', 'k-v', 'open', 0, 0)`,
    );
    const writer = (await createKey(h, ['anomalies:write'], 'ops')).key;
    const restock = await pub(writer, 'POST', '/anomalies/ano-v/resolve', { action: 'restock' });
    expect(await json(restock, 403)).toMatchObject({ detail: 'insufficient_scope: admin required' });
    const lose = await pub(writer, 'POST', '/anomalies/ano-v/resolve', { action: 'lose' });
    expect(lose.status).not.toBe(403);
    const admin = (await createKey(h, ['admin'], 'admin')).key;
    expect((await pub(admin, 'POST', '/anomalies/ano-v/resolve', { action: 'restock' })).status).not.toBe(403);
    // Unknown anomaly: anomalies:write is enough to get the 404 of the handler.
    expect((await pub(writer, 'POST', '/anomalies/none/resolve', { action: 'dismiss' })).status).toBe(404);
  });

  it('rate limit: beyond the burst, 429 with Retry-After and RateLimit-* headers', async () => {
    const { h } = await setup('rate');
    const { key } = await createKey(h, ['units:read']);
    const ok = await pub(key, 'GET', '/units?limit=1');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('RateLimit-Limit')).toBe('100');
    expect(Number(ok.headers.get('RateLimit-Remaining'))).toBe(99);
    expect(ok.headers.get('RateLimit-Reset')).not.toBeNull();
    const responses = await Promise.all(Array.from({ length: 160 }, () => pub(key, 'GET', '/units?limit=1')));
    const limited = responses.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    const first = limited[0]!;
    expect(Number(first.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(first.headers.get('RateLimit-Remaining')).toBe('0');
    expect(await first.json()).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(responses.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(99);
    await Promise.all(responses.filter((r) => !r.bodyUsed).map((r) => r.text()));
    // Another key of the same shop has its own bucket.
    const other = (await createKey(h, ['units:read'], 'other')).key;
    expect((await pub(other, 'GET', '/units?limit=1')).status).toBe(200);
  });
});

describe('T-SEC-01 / T-SEC-02 — API keys', () => {
  it('a key of shop A on a resource of shop B: 404; naming shop B: 403; a key of an uninstalled shop: 403', async () => {
    const a = await setup('sec-a');
    const b = await setup('sec-b');
    await track(b.h, [b.variant]);
    const keyB = (await createKey(b.h, ['units:read', 'units:write'])).key;
    const unitB = await json(await pub(keyB, 'POST', '/units', { variantGid: b.variant, locationId: b.loc, ref: 'B-1', alreadyCounted: false }), 201);
    const keyA = (await createKey(a.h, ['units:read'])).key;
    expect(await json(await pub(keyA, 'GET', `/units/${unitB.id}`), 404)).toMatchObject({ code: 'not_found' });
    expect(await json(await pub(keyA, 'GET', `/units?shop=${b.h.shop}`), 403)).toMatchObject({ code: 'forbidden', detail: 'shop_mismatch' });
    expect((await pub(keyA, 'GET', `/units?shop=${a.h.shop}`)).status).toBe(200);

    // A key sealed for A but carrying B's prefix and secret: A's object does not know it.
    const pa = parseApiKey(keyA)!;
    const pb = parseApiKey(keyB)!;
    const forgedPublic = publicPartOf(pa.version, pa.location, pa.shop, pb.prefix);
    const forged = `${forgedPublic}_${await computeSeal(env.API_KEY_SEAL_SECRET_V1, forgedPublic)}.${pb.secret}`;
    expect(await json(await pub(forged, 'GET', '/units'), 401)).toMatchObject({ code: 'unauthenticated' });

    // Uninstalled shop: refused by the Worker from the KV/registry status.
    await env.REGISTRY.prepare("UPDATE shops SET status = 'inactive' WHERE shop_domain = ?").bind(a.h.shop).run();
    await env.SHOP_ROUTING.delete(`shop:${a.h.shop}`);
    expect(await json(await pub(keyA, 'GET', '/units'), 403)).toMatchObject({ detail: 'shop_not_installed' });
  });

  it('a forged or malformed key is refused by the Worker without reading KV or calling any object', async () => {
    const { h } = await setup('sec-seal');
    const { key } = await createKey(h, ['units:read']);
    const getStub = vi.spyOn(env.SHOP_STORE, 'get');
    const kvGet = vi.spyOn(env.SHOP_ROUTING, 'get');

    // Positive control: a valid key goes through KV and the object.
    expect((await pub(key, 'GET', '/units')).status).toBe(200);
    const spiesWork = getStub.mock.calls.length > 0 && kvGet.mock.calls.length > 0;
    getStub.mockClear();
    kvGet.mockClear();

    const parsed = parseApiKey(key)!;
    const flipped = parsed.seal.slice(0, -1) + (parsed.seal.endsWith('0') ? '1' : '0');
    const attempts = [
      withSeal(key, flipped), // forged seal (T-SEC-02)
      withSeal(key, '0'.repeat(32)),
      key.replace(`srl_1_`, 'srl_9_'), // unknown sealing version
      key.replace(h.shop, 'victim-shop.myshopify.com'), // other shop, same seal (T-SEC-01)
      `${parsed.publicPart}_${parsed.seal}`, // no secret
      'not-a-key',
    ];
    for (const attempt of attempts) {
      const res = await pub(attempt, 'GET', '/units');
      expect(res.status, attempt).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
      expect(await res.json()).toMatchObject({ code: 'unauthenticated' });
    }
    const missing = await SELF.fetch(`${API}/units`);
    expect(await json(missing, 401)).toMatchObject({ detail: 'api_key_required' });
    expect(spiesWork).toBe(true);
    expect(getStub).not.toHaveBeenCalled();
    expect(kvGet).not.toHaveBeenCalled();
    // No object was created for the invented shop either.
    const victim = env.SHOP_STORE.get(env.SHOP_STORE.idFromName('global:victim-shop.myshopify.com'));
    expect(await victim.status()).toMatchObject({ installed: false });
  });

  it('an object without a base refuses a correctly sealed key without creating anything (10.5)', async () => {
    const shop = 'sealed-but-empty.myshopify.com';
    const { routing, stub } = await installShop(`registered-${Math.floor(Math.random() * 1e6)}.myshopify.com`, undefined, { seedTrackedItem: false });
    expect(routing.status).toBe('active');
    // The registry knows the shop but its object was erased: simulated with a never-installed object name.
    await env.REGISTRY.prepare("INSERT INTO shops (shop_domain, object_name, status, installed_at, install_count) VALUES (?, ?, 'active', ?, 1)").bind(shop, `global:${shop}`, new Date().toISOString()).run();
    const issued = await issueApiKey(env, shop, 'global');
    expect(await json(await pub(issued.key, 'GET', '/units'), 401)).toMatchObject({ code: 'unauthenticated' });
    const empty = env.SHOP_STORE.get(env.SHOP_STORE.idFromName(`global:${shop}`));
    expect(await empty.status()).toMatchObject({ installed: false });
    expect(await stub.status()).toMatchObject({ installed: true });
  });
});

describe('OpenAPI 3.1 contract (14.1)', () => {
  it('is served without authentication on both entry points', async () => {
    for (const url of [`${API}/openapi.json`, `${STAGING_PUBLIC}/openapi.json`]) {
      const res = await SELF.fetch(url);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as typeof openApiDocument;
      expect(doc.openapi).toBe('3.1.0');
      expect(doc.servers[0]!.url).toBe(url.replace('/openapi.json', ''));
    }
    expect((await SELF.fetch('https://app.serialis.dev/elsewhere-on-api-host', { headers: {} })).status).not.toBe(500);
    expect((await SELF.fetch('https://api.serialis.dev/units')).status).toBe(404);
  });

  it('every OpenAPI operation is routed by the Worker, and every public Worker route is in the OpenAPI', async () => {
    const documented = new Set<string>();
    for (const [path, ops] of Object.entries(openApiDocument.paths)) {
      for (const method of Object.keys(ops)) documented.add(`${method.toUpperCase()} ${path}`);
    }
    const routed = new Set(Object.values(PUBLIC_ROUTES).map((r) => r.route));
    expect([...documented].sort()).toEqual([...routed].sort());
    for (const spec of routed) {
      const [method, path] = spec.split(' ') as [string, string];
      const m = matchPublicRoute(method, path.replace(/\{\w+\}/g, 'x1'));
      expect(m && 'route' in m, spec).toBe(true);
      const op = (openApiDocument.paths as Record<string, Record<string, { 'x-required-scope': string; operationId: string }>>)[path]![method.toLowerCase()]!;
      const entry = Object.entries(PUBLIC_ROUTES).find(([, r]) => r.route === spec)!;
      expect(op.operationId).toBe(entry[0]);
      expect(op['x-required-scope']).toBe(entry[1].scope);
    }

    // Through the Worker: every documented operation reaches a handler (never "no route" / 405).
    const { h } = await setup('openapi');
    const { key } = await createKey(h, ALL);
    for (const spec of routed) {
      const [method, path] = spec.split(' ') as [string, string];
      const res = await pub(key, method, path.replace(/\{\w+\}/g, 'x1'), method === 'GET' || method === 'DELETE' ? undefined : {});
      const text = await res.text();
      expect(res.status, `${spec} → ${text}`).not.toBe(405);
      expect(text, spec).not.toContain('no route');
      expect(res.status, spec).not.toBe(401);
    }
  });
});
