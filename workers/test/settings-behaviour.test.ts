/**
 * Behaviour of non-default settings at the Worker level (spec 6.6.1, T-SET-08): referenced from
 * `core/src/settings.ts` (`testRefs`) when the effect needs the whole chain (API, sync, outbox).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addRefs, createHarness, json, metafieldOf, track, type Harness } from './e2e-harness.js';

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.restore();
});

describe('settings behaviour (T-SET-08)', () => {
  it('S-38 no: the metafield is removed from the open orders at once', { timeout: 30_000 }, async () => {
    const h = await createHarness('s38');
    harnesses.push(h);
    const loc = h.sim.addLocation('Main');
    const { variantIds } = h.sim.addProduct('Bike', [{ sku: 'BIKE', stock: { [loc]: 0 } }]);
    const variant = variantIds[0]!;
    await track(h, [variant]);
    await addRefs(h, variant, loc, ['M-1', 'M-2']);
    await h.drain();
    const order = h.sim.merchant.createOrder({ lines: [{ variantId: variant, quantity: 1 }] });
    await h.drain();
    expect(metafieldOf(h, order.id)).not.toBeNull();

    const sim = await json(await h.api('POST', '/settings/simulate', { scope: 'shop', values: { 'S-38': false } }), 201);
    expect(sim.effects).toEqual([{ key: 'S-38', count: 1, summary: 'metafields_removed_at_next_sync' }]);
    await json(await h.api('PATCH', '/settings', { scope: 'shop', values: { 'S-38': false }, simulationId: sim.simulationId }), 200);
    // 6.6.1: the concerned orders are synchronized at saving time, without waiting for a change in Shopify.
    await h.drain();
    expect(metafieldOf(h, order.id)).toBeNull();
    expect(h.sim.callCount('metafieldsDelete')).toBe(1);
    // The units stay allocated: only the metafield goes.
    expect(await h.query("SELECT count(*) AS n FROM allocations WHERE status = 'active'")).toEqual([{ n: 1 }]);
  });
});
