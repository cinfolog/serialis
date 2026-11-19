/**
 * Internal API `/api/v1` (api/contract, spec 14.1, 14.2): authentication (session and ID token),
 * CORS of the admin extensions, Idempotency-Key replay and conflict, If-Match / 412,
 * problem+json, cursor pagination, and each route of `ALL_ROUTES`.
 */
import { SELF } from 'cloudflare:test';
import { ALL_ROUTES } from '@serialis/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { matchRoute } from '../src/api/router.js';
import { addRefs, anomalies, createHarness, json, track, type Harness } from './e2e-harness.js';
import { sessionToken } from './helpers.js';

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.restore();
});

async function setup(name: string, stock = 0) {
  const h = await createHarness(name);
  harnesses.push(h);
  const loc = h.sim.addLocation('Main');
  const loc2 = h.sim.addLocation('Second');
  const { productId, variantIds, itemIds } = h.sim.addProduct('Bike', [{ sku: 'BIKE-M', stock: { [loc]: stock, [loc2]: 0 } }, { sku: 'BIKE-L', stock: { [loc]: 0 } }]);
  return { h, loc, loc2, productId, variant: variantIds[0]!, variantL: variantIds[1]!, item: itemIds[0]! };
}

const BASE = 'https://staging.serialis.dev/api/v1';

describe('route table', () => {
  it('serves every route of ALL_ROUTES', () => {
    for (const spec of Object.values(ALL_ROUTES)) {
      const [method, path] = spec.split(' ') as [string, string];
      const m = matchRoute(method, path.replace(/\{\w+\}/g, 'x1'));
      expect(m && 'route' in m, spec).toBe(true);
    }
    expect(matchRoute('GET', '/units/batch')).toMatchObject({ route: { name: 'getUnit' } });
    expect(matchRoute('POST', '/units/batch')).toMatchObject({ route: { name: 'createUnitsBatch' } });
    expect(matchRoute('PUT', '/units/1')).toEqual({ allowed: ['GET'] });
  });
});

describe('authentication and CORS (16, 11.3, T-SEC-01)', () => {
  it('refuses a missing or bad token with 401 and the retry header, another shop with 403', async () => {
    const { h } = await setup('auth');
    const missing = await SELF.fetch(`${BASE}/me`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('X-Shopify-Retry-Invalid-Session-Request')).toBe('1');
    expect(missing.headers.get('Content-Type')).toContain('application/problem+json');
    expect(await missing.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
    const forged = await SELF.fetch(`${BASE}/me`, { headers: { Authorization: `Bearer ${await sessionToken(h.shop, {}, 'other-secret')}` } });
    expect(forged.status).toBe(401);
    const mismatch = await SELF.fetch(`${BASE}/units?shop=other-shop.myshopify.com`, { headers: { Authorization: `Bearer ${await sessionToken(h.shop)}` } });
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toMatchObject({ code: 'forbidden' });
    const notInstalled = await SELF.fetch(`${BASE}/units`, { headers: { Authorization: `Bearer ${await sessionToken('never-installed.myshopify.com')}` } });
    expect(notInstalled.status).toBe(403);
  });

  it('accepts the ID token of an admin extension (no user) and answers the CORS preflight of the extensions origin', async () => {
    const { h } = await setup('cors');
    const preflight = await SELF.fetch(`${BASE}/allocations`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://extensions.shopifycdn.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, idempotency-key' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://extensions.shopifycdn.com');
    for (const header of ['Authorization', 'Content-Type', 'Idempotency-Key', 'If-Match', 'Accept']) {
      expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain(header);
    }
    // ID token of an extension: same signature rules, no `sub`.
    const idToken = await sessionToken(h.shop, { sub: undefined, sid: undefined });
    const res = await SELF.fetch(`${BASE}/locations`, { headers: { Authorization: `Bearer ${idToken}`, Origin: 'https://extensions.shopifycdn.com' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://extensions.shopifycdn.com');
    const other = await SELF.fetch(`${BASE}/locations`, { headers: { Authorization: `Bearer ${idToken}`, Origin: 'https://evil.example' } });
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('Idempotency-Key, If-Match, problem+json, pagination (14.1, T-API-01)', () => {
  it('replays the same POST, refuses another body with 409 and a POST without key with 400', async () => {
    const { h, loc, variant } = await setup('idem');
    await track(h, [variant]);
    const body = { variantGid: variant, locationId: loc, refs: ['K-1'], alreadyCounted: false, mode: 'per_item' };
    const first = await h.api('POST', '/units/batch', body, { 'Idempotency-Key': 'k-1' });
    const firstBody = await json(first, 201);
    const replay = await h.api('POST', '/units/batch', body, { 'Idempotency-Key': 'k-1' });
    expect(await json(replay, 201)).toEqual(firstBody);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await h.query('SELECT id FROM units')).toHaveLength(1);
    const conflict = await h.api('POST', '/units/batch', { ...body, refs: ['K-2'] }, { 'Idempotency-Key': 'k-1' });
    expect(await json(conflict, 409)).toMatchObject({ code: 'idempotency_conflict' });
    const noKey = await SELF.fetch(`${BASE}/automation/pause`, { method: 'POST', headers: { Authorization: `Bearer ${await sessionToken(h.shop)}` } });
    expect(await json(noKey, 400)).toMatchObject({ code: 'validation_failed' });
  });

  it('If-Match: ETag of units, allocations and settings; a stale value gives 412', async () => {
    const { h, loc, variant } = await setup('ifmatch');
    await track(h, [variant]);
    const { created } = await addRefs(h, variant, loc, ['E-1', 'E-2']);
    const unit = await h.api('GET', `/units/${created[0].id}`);
    expect(unit.headers.get('ETag')).toBe('"u0"');
    expect((await h.api('GET', `/units/${created[0].id}`, undefined, { 'If-Match': '"u9"' })).status).toBe(412);
    await h.drain();
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    await h.drain();
    const lines = (await json(await h.api('GET', `/orders/${encodeURIComponent(order.id)}/allocations`), 200)).lines;
    const allocation = lines[0].allocations[0];
    const stale = await h.api('DELETE', `/allocations/${allocation.id}`, undefined, { 'If-Match': '"a99"' });
    expect(await json(stale, 412)).toMatchObject({ code: 'precondition_failed' });
    expect((await h.api('DELETE', `/allocations/${allocation.id}`, undefined, { 'If-Match': '"a1"' })).status).toBe(204);
    const settings = await h.api('GET', '/settings?scope=shop');
    const etag = settings.headers.get('ETag')!;
    await json(await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-08': 'first' } }, { 'If-Match': etag }), 200);
    expect((await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-08': 'last' } }, { 'If-Match': etag })).status).toBe(412);
  });

  it('cursor pagination is complete and stable; problem+json on unknown routes and resources', async () => {
    const { h, loc, variant } = await setup('pages');
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['P-1', 'P-2', 'P-3', 'P-4', 'P-5']);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: Array<{ ref: string }>; nextCursor: string | null } = await json(await h.api('GET', `/units?variant=${encodeURIComponent(variant)}&state=AVAILABLE&limit=2${cursor ? `&cursor=${cursor}` : ''}`), 200);
      seen.push(...page.items.map((u) => u.ref));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(['P-1', 'P-2', 'P-3', 'P-4', 'P-5']);
    expect((await h.api('GET', '/units?limit=251')).status).toBe(400);
    expect(await json(await h.api('GET', '/units/nope'), 404)).toMatchObject({ code: 'not_found', type: 'https://serialis.dev/problems/not_found' });
    expect((await h.api('GET', '/nothing-here')).status).toBe(404);
    expect((await h.api('GET', '/units?state=NOPE')).status).toBe(400);
  });
});

describe('resources', () => {
  it('me, tracked items (filters, untrack), locations, lookup, events, check batch', async () => {
    const { h, loc, loc2, productId, variant, variantL } = await setup('resources', 2);
    const me = await json(await h.api('GET', '/me?locale=en'), 200);
    expect(me).toMatchObject({ shop: h.shop, installed: true, emergencyStop: false, locale: 'en', onboarding: { step: 'products', completed: false }, role: 'admin' });

    await json(await h.api('POST', '/tracked-items', { variantGids: [variant, variantL] }), 200);
    const byVariant = await json(await h.api('GET', `/tracked-items?variant=${encodeURIComponent(variant)}`), 200);
    expect(byVariant.items).toHaveLength(1);
    expect(byVariant.items[0]).toMatchObject({ variantGid: variant, productGid: productId, sku: 'BIKE-M', initializing: true, mode: 'interchangeable' });
    expect(byVariant.items[0].stock).toEqual(expect.arrayContaining([{ locationId: loc, shopifyOnHand: 2, registeredUnits: 0, availableUnits: 0 }]));
    expect((await json(await h.api('GET', `/tracked-items?product=${encodeURIComponent(productId)}`), 200)).items).toHaveLength(2);
    const untracked = await json(await h.api('POST', '/tracked-items', { action: 'untrack', variantGids: [variantL] }), 200);
    expect(untracked.items).toEqual([]);

    const locations = await json(await h.api('GET', '/locations'), 200);
    expect(locations).toEqual({ items: expect.arrayContaining([{ id: loc, name: 'Main', active: true }, { id: loc2, name: 'Second', active: true }]), nextCursor: null });

    const check = await json(await h.api('POST', '/units/batch/check', { variantGid: variant, locationId: loc, refs: ['Q-1', 'q-1', 'Q-2', 'Q-3'], alreadyCounted: true, mode: 'per_item' }), 200);
    expect(check).toEqual({
      rows: [
        { index: 0, ref: 'Q-1', status: 'ready' },
        { index: 1, ref: 'q-1', status: 'duplicate_in_list' },
        { index: 2, ref: 'Q-2', status: 'ready' },
        { index: 3, ref: 'Q-3', status: 'beyond_gap', detail: 'no_usable_deficit' },
      ],
      ready: 2,
      stockWrite: 0,
      gapBefore: 2,
    });
    expect(await h.query('SELECT 1 FROM units')).toHaveLength(0);
    const { created } = await addRefs(h, variant, loc, ['Q-1', 'Q-2'], true);
    await h.drain();
    // Initialization ends once I1 holds (S-25 automatic, EF-01).
    expect((await json(await h.api('GET', `/tracked-items?variant=${encodeURIComponent(variant)}`), 200)).items[0].initializing).toBe(false);
    expect((await json(await h.api('GET', '/lookup?identifier=q 1'), 200)).unit).toBeNull();
    expect((await json(await h.api('GET', '/lookup?identifier=%20q-1'), 200)).unit).toMatchObject({ id: created[0].id, state: 'AVAILABLE' });
    const events = await json(await h.api('GET', `/units/${created[0].id}/events`), 200);
    expect(events.items).toEqual([expect.objectContaining({ type: 'created', fromState: null, toState: 'AVAILABLE', actor: 'user', reason: 'already_counted', stockEffect: 'no write' })]);
    const stats = await json(await h.api('GET', '/stats/home'), 200);
    expect(stats.unitsByState).toEqual([{ locationId: loc, state: 'AVAILABLE', count: 2 }]);
    expect(stats.sync).toMatchObject({ pendingWrites: 0 });
  });

  it('allocations: numeric order id, location_mismatch, variant_mismatch, ambiguous last 4, unknown ref, replace', async () => {
    const { h, loc, loc2, variant, variantL } = await setup('allocs');
    await track(h, [variant, variantL]);
    await addRefs(h, variant, loc, ['AB-1234', 'CD-1234']);
    await addRefs(h, variant, loc2, ['FAR-9999']);
    await addRefs(h, variantL, loc, ['LARGE-1']);
    await h.drain();
    await json(await h.api('POST', '/automation/pause'), 200);
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1, locationId: loc }] });
    await h.drain();
    const numeric = order.id.split('/').pop()!;
    const allocs = await json(await h.api('GET', `/orders/${numeric}/allocations`), 200);
    expect(allocs).toMatchObject({ orderGid: order.id, syncState: 'synced', lines: [{ missing: 1, allocations: [] }] });
    const line = allocs.lines[0].lineItemGid;
    const post = (ref: string) => h.api('POST', '/allocations', { orderGid: numeric, lineItemGid: line, ref });
    expect(await json(await post('FAR-9999'), 409)).toMatchObject({ code: 'location_mismatch' });
    expect(await json(await post('LARGE-1'), 409)).toMatchObject({ code: 'variant_mismatch' });
    expect(await json(await post('1234'), 409)).toMatchObject({ code: 'ambiguous_ref' });
    expect(await json(await post('ZZ-0000'), 404)).toMatchObject({ code: 'unknown_ref' });
    const created = await json(await post('ab-1234'), 201);
    expect(created).toMatchObject({ ref: 'AB-1234', status: 'active', source: 'pick', locationId: loc }); // app or extension: manual (recette 2)
    expect(await json(await post('CD-1234'), 409)).toMatchObject({ code: 'invalid_transition' });
    const replaced = await json(await h.api('POST', `/allocations/${created.id}/replace`, { ref: 'CD-1234' }), 201);
    expect(replaced.ref).toBe('CD-1234');
    expect(await json(await h.api('POST', `/allocations/${created.id}/replace`, { ref: 'AB-1234' }), 409)).toMatchObject({ code: 'invalid_transition' });
    expect(await json(await h.api('POST', `/allocations/${replaced.id}/confirm-shipped`, { ref: 'CD-1234' }), 409)).toMatchObject({ code: 'invalid_transition' });
    await json(await h.api('POST', '/automation/resume'), 200);
    expect((await json(await h.api('GET', '/me'), 200)).emergencyStop).toBe(false);
  });

  it('anomalies: list with filters, acknowledge, resolve with a wrong action', async () => {
    const { h, loc, variant } = await setup('anoms');
    await track(h, [variant]);
    h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1, locationId: loc }] });
    await h.drain();
    const list = await json(await h.api('GET', '/anomalies?severity=critical'), 200);
    expect(list.items).toEqual([expect.objectContaining({ type: 'insufficient_units', status: 'open', severity: 'critical', locationId: loc, actions: [expect.objectContaining({ action: 'allocate', needsRef: true, writesStock: false })] })]);
    const ack = await json(await h.api('POST', `/anomalies/${list.items[0].id}/acknowledge`), 200);
    expect(ack.status).toBe('acknowledged');
    expect(await json(await h.api('POST', `/anomalies/${list.items[0].id}/resolve`, { action: 'restock' }), 422)).toMatchObject({ code: 'validation_failed' });
    expect((await json(await h.api('GET', '/anomalies?status=resolved'), 200)).items).toEqual([]);
    expect(await anomalies(h, 'insufficient_units')).toHaveLength(1);
  });

  it('settings: encoding, fixed values, scopes, simulation required for "simulation" settings', async () => {
    const { h } = await setup('settings');
    const current = await json(await h.api('GET', '/settings?scope=shop'), 200);
    const byKey = Object.fromEntries(current.values.map((v: { key: string }) => [v.key, v]));
    expect(byKey['S-01']).toMatchObject({ value: 'do_not_block', origin: 'fixed' });
    expect(byKey['S-05']).toMatchObject({ value: 'fifo', origin: 'default', changeRule: 'immediate' });
    expect(byKey['S-22']).toMatchObject({ value: 10 });
    expect(byKey['S-36.strip_spaces']).toMatchObject({ value: true });
    expect(byKey['S-40']).toMatchObject({ value: 'owner_digest' });

    const saved = await json(await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-05': 'earliest_expiry', 'S-22': 30 } }), 200);
    const after = Object.fromEntries(saved.values.map((v: { key: string }) => [v.key, v]));
    expect(after['S-05']).toMatchObject({ value: 'earliest_expiry', origin: 'shop' });
    expect(after['S-22']).toMatchObject({ value: 30, origin: 'shop' });
    expect(await json(await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-01': 'hold' } }), 422)).toMatchObject({ code: 'validation_failed' });
    expect((await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-22': 2 } })).status).toBe(422);
    expect((await h.api('PATCH', '/settings', { scope: 'location:gid://shopify/Location/1', values: { 'S-05': 'fifo' } })).status).toBe(422);

    expect(await json(await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-11': 'process' } }), 409)).toMatchObject({ code: 'simulation_expired' });
    const sim = await json(await h.api('POST', '/settings/simulate', { scope: 'shop', values: { 'S-11': 'process', 'S-17': false } }), 201);
    expect(sim.warnings).toHaveLength(1);
    const ok = await json(await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-11': 'process', 'S-17': false }, simulationId: sim.simulationId }), 200);
    expect(Object.fromEntries(ok.values.map((v: { key: string; value: unknown }) => [v.key, v.value]))).toMatchObject({ 'S-11': 'process', 'S-17': false });
    // Back to the default (value null).
    const reset = await json(await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-05': null } }), 200);
    expect(reset.values.find((v: { key: string }) => v.key === 'S-05')).toMatchObject({ value: 'fifo', origin: 'default' });
  });

  it('settings: a shop value equal to the default is not stored, null removes it (T-SET-06, « Mes choix »)', async () => {
    // Browser recette: S-22 10 → 15 → 10 left an explicit shop value of 10 listed in « Mes choix ».
    const { h } = await setup('settings-default');
    const s22 = (r: { values: Array<{ key: string }> }) => r.values.find((v) => v.key === 'S-22');
    const shopRows = async () => (await h.query<{ n: number }>("SELECT count(*) AS n FROM settings WHERE scope_type = 'shop' AND key = 'S-22'"))[0]!.n;
    expect(s22(await json(await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-22': 15 } }), 200))).toMatchObject({ value: 15, origin: 'shop' });
    expect(s22(await json(await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-22': 10 } }), 200))).toMatchObject({ value: 10, origin: 'default' });
    expect(await shopRows()).toBe(0);
    expect(s22(await json(await h.api('GET', '/settings?scope=shop'), 200))).toMatchObject({ value: 10, origin: 'default' });
    // Same rule for a structured value (S-40) and a choice (S-05).
    await json(await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-40': 'owner_no_digest', 'S-05': 'earliest_expiry' } }), 200);
    const back = await json(await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-40': 'owner_digest', 'S-05': 'fifo' } }), 200);
    expect(back.values.filter((v: { key: string; origin: string }) => ['S-40', 'S-05'].includes(v.key)).map((v: { origin: string }) => v.origin)).toEqual(['default', 'default']);
    // A value stored before this rule (explicit 10) is still removed by « Back to default » (null).
    await h.run("INSERT INTO settings (scope_type, scope_id, key, value, updated_by, updated_at) VALUES ('shop', '', 'S-22', '600000', 'legacy', 0)");
    expect(s22(await json(await h.api('GET', '/settings?scope=shop'), 200))).toMatchObject({ value: 10, origin: 'shop' });
    expect(s22(await json(await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-22': null } }), 200))).toMatchObject({ value: 10, origin: 'default' });
    expect(await shopRows()).toBe(0);
  });

  it('imports: simulation report, then confirmation (received and already counted)', async () => {
    const { h, loc, variant, item } = await setup('imports', 1);
    await track(h, [variant]);
    const csv = ['ref;sku;location;already_counted', 'IMP-1;BIKE-M;Main;yes', 'IMP-2;BIKE-M;Main;yes', 'IMP-3;BIKE-M;Main;no', 'IMP-3;BIKE-M;Main;no', 'IMP-4;UNKNOWN;Main;no', 'IMP-5;BIKE-M;Nowhere;no'].join('\n');
    const report = await json(await h.api('POST', '/imports', { filename: 'units.csv', csv }), 201);
    expect(report).toMatchObject({ status: 'simulated', rows: 6, valid: 2, beyondGap: 1, stockWrites: 1 });
    expect(report.errors.map((e: { row: number; code: string }) => [e.row, e.code])).toEqual([
      [3, 'validation_failed'],
      [5, 'identifier_conflict'],
      [6, 'not_tracked'],
      [7, 'validation_failed'],
    ]);
    expect(await json(await h.api('GET', `/imports/${report.id}`), 200)).toMatchObject({ id: report.id, status: 'simulated' });
    expect(await h.query('SELECT 1 FROM units')).toHaveLength(0);
    const confirmed = await json(await h.api('POST', `/imports/${report.id}/confirm`), 200);
    expect(confirmed).toMatchObject({ status: 'confirmed', valid: 2 });
    await h.drain();
    expect((await h.query<{ ref: string }>('SELECT primary_identifier AS ref FROM units ORDER BY 1')).map((r) => r.ref)).toEqual(['IMP-1', 'IMP-3']);
    expect(h.sim.shop.getLevel(item, loc)!.q.available).toBe(2);
  });
});
