/**
 * Third browser recette (real Shopify admin, staging).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addRefs, anomalies, assertConsistent, createHarness, json, sim_level, track, type Harness } from './e2e-harness.js';

const harnesses: Harness[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (harnesses.length) harnesses.pop()!.restore();
});

const numeric = (gid: string) => gid.split('/').pop()!;

async function setup(name: string) {
  const h = await createHarness(name);
  harnesses.push(h);
  const loc = h.sim.addLocation('Main');
  const loc2 = h.sim.addLocation('Second');
  const { variantIds, itemIds } = h.sim.addProduct('Bike', [{ sku: 'BIKE-M', stock: { [loc]: 0, [loc2]: 0 } }]);
  const variant = variantIds[0]!;
  await track(h, [variant]);
  await addRefs(h, variant, loc, ['VR-001', 'VR-002', 'VR-003', 'VR-004', 'VR-005']);
  await h.drain();
  return { h, loc, loc2, variant, item: itemIds[0]! };
}

async function unitState(h: Harness, unitId: string): Promise<string> {
  return (await json(await h.api('GET', `/units/${unitId}`), 200)).state;
}

async function shippedOrder(h: Harness, variant: string, qty = 1) {
  const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: qty }] });
  await h.drain();
  order.fulfill();
  await h.drain();
  const sold = (await json(await h.api('GET', `/orders/${numeric(order.id)}/allocations`), 200)).lines[0].allocations as Array<{ unitId: string; ref: string }>;
  return { order, sold };
}

/** Identifies the return line through its « Return to identify » anomaly. */
async function identifyThroughAnomaly(h: Harness, ref: string) {
  const todo = await anomalies(h, 'return_unidentified');
  expect(todo).toHaveLength(1);
  await json(await h.api('POST', `/anomalies/${todo[0]!.id}/resolve`, { action: 'identify', params: { ref } }), 200);
  await h.drain();
}

describe('recette 3, item 1 — PV-3: PROCESSING_REQUIRED (Shopify adds nothing, default branch)', () => {
  for (const variantCase of [
    { label: 'disposition with its location', opts: {} },
    { label: 'disposition stored without location (nullable field)', opts: { recordLocation: false } },
    { label: 'reverse line without fulfillmentLineItem (nullable field)', opts: { unlinked: true, recordLocation: false } },
  ] as const) {
    it(`plain shipped unit, dispose through the API only — ${variantCase.label}: return to identify, then QUALITY_CONTROL with quality_control +1`, async () => {
      const { h, loc, variant, item } = await setup('r3-pr-plain');
      const { order, sold } = await shippedOrder(h, variant);
      order.createReturn({ lines: [{ line: 0, quantity: 1 }] });
      await h.drain();
      const before = sim_level(h, item, loc);
      order.dispose(order.returns[0]!.id, [{ line: 0, quantity: 1, disposition: 'PROCESSING_REQUIRED', locationId: loc }], { returnUpdate: false, ...variantCase.opts });
      await h.drain();
      // Shopify added nothing (PV-3): never silently nothing — S-17 (yes) asks for the ref.
      expect(sim_level(h, item, loc)).toEqual(before);
      await identifyThroughAnomaly(h, sold[0]!.ref);
      const unit = await json(await h.api('GET', `/units/${sold[0]!.unitId}`), 200);
      expect(unit.state).toBe('QUALITY_CONTROL');
      expect(unit.locationId).toBe(loc);
      expect(sim_level(h, item, loc)).toEqual({ ...before, quality_control: before.quality_control + 1, on_hand: before.on_hand + 1 });
      expect(await anomalies(h)).toEqual([]);
      await assertConsistent(h);
    });
  }

  it('recette history: line of 2 with an earlier return, the unit typed before on a return of another order (mismatch still open)', async () => {
    const { h, loc, variant, item } = await setup('r3-pr-history');
    const { order, sold } = await shippedOrder(h, variant, 2);
    // R1: the other unit of the line, restocked.
    order.createReturn({ lines: [{ line: 0, quantity: 1 }] });
    await h.drain();
    const r1 = order.returns[0]!;
    await json(await h.api('POST', `/returns/${numeric(r1.id)}/identify`, { returnLineItemGid: r1.lines[0]!.id, ref: sold[1]!.ref }), 202);
    order.dispose(r1.id, [{ line: 0, quantity: 1, disposition: 'RESTOCKED', locationId: loc }]);
    await h.drain();
    expect(await unitState(h, sold[1]!.unitId)).toBe('AVAILABLE');
    // The unit kept is typed on a return of another order: return_unit_mismatch there.
    const other = await shippedOrder(h, variant);
    other.order.createReturn({ lines: [{ line: 0, quantity: 1 }] });
    await h.drain();
    const otherRet = other.order.returns[0]!;
    await json(await h.api('POST', `/returns/${numeric(otherRet.id)}/identify`, { returnLineItemGid: otherRet.lines[0]!.id, ref: sold[0]!.ref }), 202);
    await h.drain();
    expect(await anomalies(h, 'return_unit_mismatch')).toHaveLength(1);
    expect(await unitState(h, sold[0]!.unitId)).toBe('SHIPPED');

    // R2 of the order, no disposition in the admin, then PROCESSING_REQUIRED through GraphiQL.
    order.createReturn({ lines: [{ line: 0, quantity: 1 }] });
    await h.drain();
    const before = sim_level(h, item, loc);
    order.dispose(order.returns[1]!.id, [{ line: 0, quantity: 1, disposition: 'PROCESSING_REQUIRED', locationId: loc }], { returnUpdate: false, recordLocation: false });
    await h.drain();
    expect(sim_level(h, item, loc)).toEqual(before);
    // The open mismatch of the other order blocks neither the unit nor this return line.
    await identifyThroughAnomaly(h, sold[0]!.ref);
    expect(await unitState(h, sold[0]!.unitId)).toBe('QUALITY_CONTROL');
    expect(sim_level(h, item, loc).quality_control).toBe(before.quality_control + 1);
    expect((await anomalies(h)).map((a) => a.type)).toEqual(['return_unit_mismatch']);
    await assertConsistent(h);
  }, 30_000);
});

describe('recette 3, item 1 — one structured log line per webhook (17.1)', () => {
  it('topic, webhook id, shop, resolved ids and outcome; no body, no order id in clear', async () => {
    const { h, loc, variant } = await setup('r3-weblog');
    const { order } = await shippedOrder(h, variant);
    order.createReturn({ lines: [{ line: 0, quantity: 1 }] });
    await h.drain();
    const lines: Record<string, unknown>[] = [];
    const raw: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, m).mockImplementation((l: unknown) => {
        if (typeof l !== 'string') return;
        raw.push(l);
        try {
          lines.push(JSON.parse(l) as Record<string, unknown>);
        } catch {
          /* not structured */
        }
      });
    }
    order.dispose(order.returns[0]!.id, [{ line: 0, quantity: 1, disposition: 'PROCESSING_REQUIRED', locationId: loc }], { returnUpdate: false });
    const ids = h.sim.webhooks.pending().map((e) => e.id);
    await h.deliver();
    // An unhandled topic is logged as ignored with its reason.
    h.sim.shop.emit('bulk_operations/finish', { admin_graphql_api_id: 'gid://shopify/BulkOperation/1' });
    await h.deliver();
    await h.drain();
    const hooks = lines.filter((l) => l.event === 'webhook');
    expect(hooks[0]).toMatchObject({ topic: 'reverse_fulfillment_orders/dispose', shop: h.shop, outcome: 'handled', task_kind: 'resolve', return: order.returns[0]!.reverseFulfillmentOrders[0]!.id });
    expect(ids).toContain(hooks[0]!.webhook_id);
    expect(hooks[1]).toMatchObject({ topic: 'bulk_operations/finish', outcome: 'ignored', reason: 'not_handled_yet' });
    expect(lines.find((l) => l.event === 'resolve.done')).toMatchObject({ outcome: 'handled', order: expect.stringMatching(/^order:[0-9a-f]{12}$/) });
    expect(raw.join('\n')).not.toContain(order.id);
  });
});

describe('recette 3, item 2 — order block polling is cheap (ETag / If-None-Match)', () => {
  it('304 without body while the order is unchanged, 200 with a new ETag after a native fulfillment', async () => {
    const { h, variant } = await setup('r3-etag');
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    await h.drain();
    const path = `/orders/${numeric(order.id)}/allocations`;
    const first = await h.api('GET', path);
    expect(first.status).toBe(200);
    const etag = first.headers.get('ETag')!;
    expect(etag).toMatch(/^W\/"o[0-9a-f]{20}"$/);
    const same = await h.api('GET', path, undefined, { 'If-None-Match': etag });
    expect(same.status).toBe(304);
    expect(await same.text()).toBe('');
    order.fulfill();
    await h.drain();
    const changed = await h.api('GET', path, undefined, { 'If-None-Match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('ETag')).not.toBe(etag);
    const cors = await h.api('OPTIONS', path, undefined, { Origin: 'https://extensions.shopifycdn.com' });
    expect(cors.headers.get('Access-Control-Allow-Headers')).toContain('If-None-Match');
  });
});

describe('recette 3, item 3 — order metafield definition pinned', () => {
  it('pinned at creation; an existing unpinned definition is pinned once (idempotent)', async () => {
    const h = await createHarness('r3-pin');
    harnesses.push(h);
    await h.drain();
    const defs = [...h.sim.shop.metafieldDefinitions.values()];
    expect(defs).toHaveLength(1);
    expect(defs[0]!.pinnedPosition).toBe(1);
    expect(h.sim.callCount('metafieldDefinitionPin')).toBe(0);

    // A shop of an earlier version: definition known, unpinned.
    defs[0]!.pinnedPosition = null;
    await h.run("DELETE FROM meta WHERE key = 'order_metafield_definition_pinned'");
    await h.run("INSERT INTO tasks (key, kind, priority, payload, status, run_at, deadline_at, attempts, created_at, updated_at) VALUES ('definitions', 'definitions', 45, '{}', 'pending', 0, 0, 0, 0, 0) ON CONFLICT (key) DO UPDATE SET status = 'pending', run_at = 0");
    await h.drain();
    expect(defs[0]!.pinnedPosition).toBe(1);
    expect(h.sim.callCount('metafieldDefinitionPin')).toBe(1);
    expect(h.sim.callCount('metafieldDefinitionCreate')).toBe(1);

    // Done once: a later unpinning by the merchant is not overruled, the task is not scheduled again.
    defs[0]!.pinnedPosition = null;
    await h.run("UPDATE tasks SET status = 'pending', run_at = 0 WHERE key = 'definitions'");
    await h.drain();
    expect(h.sim.callCount('metafieldDefinitionPin')).toBe(1);
    expect(defs[0]!.pinnedPosition).toBeNull();
  });
});

describe('recette 3, item 4a — partial confirmation of shipped units', () => {
  it('one unit of two confirmed: the anomaly stays open with 1 remaining, then closes', async () => {
    const { h, variant } = await setup('r3-partial');
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 3 }] });
    await h.drain();
    order.fulfill({ lines: [{ line: 0, quantity: 2 }] });
    await h.drain();
    const toConfirm = await anomalies(h, 'shipped_unit_to_confirm');
    expect(toConfirm).toHaveLength(1);
    const lines = (await json(await h.api('GET', `/orders/${numeric(order.id)}/allocations`), 200)).lines;
    const provisional = (lines[0].allocations as Array<{ ref: string; toConfirm: boolean }>).filter((a) => a.toConfirm).map((a) => a.ref);
    const first = await json(await h.api('POST', `/anomalies/${toConfirm[0]!.id}/resolve`, { action: 'confirm_shipped', params: { ref: provisional[0] } }), 200);
    expect(first).toMatchObject({ status: 'open', remaining: 1 });
    const second = await json(await h.api('POST', `/anomalies/${toConfirm[0]!.id}/resolve`, { action: 'confirm_shipped', params: { ref: provisional[1] } }), 200);
    expect(second).toMatchObject({ status: 'resolved', remaining: 0 });
  });
});

describe('recette 3, item 4c — import errors name the line of the file', () => {
  it('header is line 1 and blank lines count, like a text editor', async () => {
    const { h } = await setup('r3-import-lines');
    const csv = ['ref;sku;location;already_counted', 'IMP-1;BIKE-M;Main;no', '', 'IMP-2;UNKNOWN;Main;no', 'IMP-1;BIKE-M;Main;no'].join('\n');
    const report = await json(await h.api('POST', '/imports', { filename: 'units.csv', csv }), 201);
    expect(report.rows).toBe(3);
    expect(report.errors.map((e: { row: number; code: string; detail: string }) => [e.row, e.code, e.detail])).toEqual([
      [4, 'not_tracked', expect.any(String)],
      [5, 'identifier_conflict', expect.stringContaining('duplicate_in_file')],
    ]);
  });
});
