import { describe, expect, it } from 'vitest';
import { fixture, level } from './helpers.js';

const topics = (f: ReturnType<typeof fixture>): string[] => f.sim.shop.events.map((e) => e.topic);

describe('merchant scenarios: stock and webhooks', () => {
  it('createOrder commits stock and emits create/updated', () => {
    const f = fixture();
    f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 3 }] });
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ available: 7, committed: 3, on_hand: 10 });
    expect(topics(f)).toEqual(['inventory_levels/update', 'orders/create', 'fulfillment_orders/order_routing_complete', 'orders/updated']);
  });

  it('partial then total fulfilment decrements committed and tracks fulfillment order status', () => {
    const f = fixture();
    const o = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 3 }] });
    o.fulfill({ lines: [{ line: 0, quantity: 1 }] });
    expect(o.fulfillmentOrders[0]?.status).toBe('IN_PROGRESS');
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ available: 7, committed: 2, on_hand: 9 });
    o.fulfill();
    expect(o.fulfillmentOrders[0]?.status).toBe('CLOSED');
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ committed: 0, on_hand: 7 });
    expect(() => o.fulfill()).toThrow(/Nothing to fulfil/);
  });

  it('editOrder: remove with restock, reduce without restock, add', () => {
    const f = fixture();
    const o = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 3 }, { variantId: f.variant2Id, quantity: 2 }] });
    o.edit().removeLine(0, { restock: true }).reduceLine(1, { by: 1 }, { restock: false }).commit();
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ available: 10, committed: 0 });
    expect(level(f.sim, f.sim.shop.variants.get(f.variant2Id)!.inventoryItemId, f.loc)).toMatchObject({ available: 3, committed: 1, on_hand: 4 });
    expect(o.lines.map((l) => l.currentQuantity)).toEqual([0, 1]);
    o.edit().addLine({ variantId: f.variantId, quantity: 2, properties: { note: 'x' } }).commit();
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ available: 8, committed: 2 });
    expect(f.sim.shop.events.some((e) => e.topic === 'orders/edited')).toBe(true);
  });

  it('cancel with and without restock, and without refund record', () => {
    const f = fixture();
    const a = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 2 }] }).cancel();
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ available: 10, committed: 0 });
    expect(a.refunds[0]?.lines[0]?.restockType).toBe('CANCEL');
    expect(a.fulfillmentOrders[0]?.status).toBe('CANCELLED');
    const b = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 2 }] }).cancel({ restock: false });
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ available: 8, committed: 0, on_hand: 8 });
    expect(b.refunds[0]?.lines[0]?.restockType).toBe('NO_RESTOCK');
    const c = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 1 }] }).cancel({ refund: false });
    expect(c.refunds).toHaveLength(0);
    expect(f.sim.shop.events.filter((e) => e.topic === 'orders/cancelled')).toHaveLength(3);
  });

  it('refund RETURN restocks fulfilled units at the given location', () => {
    const f = fixture();
    const o = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 2 }] }).fulfill();
    o.refund({ lines: [{ line: 0, quantity: 1, restockType: 'RETURN', locationId: f.loc2 }] });
    expect(level(f.sim, f.itemId, f.loc2)).toMatchObject({ available: 1 });
    expect(o.lines[0]).toMatchObject({ currentQuantity: 1, fulfilledQuantity: 1 });
  });

  it('move and split fulfillment orders, merge them back', () => {
    const f = fixture();
    const o = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 4 }] });
    const fo = o.fulfillmentOrders[0]!;
    o.splitFulfillmentOrder(fo.id, [{ line: 0, quantity: 1 }]);
    expect(o.fulfillmentOrders.map((x) => x.lines[0]?.remainingQuantity)).toEqual([3, 1]);
    o.moveFulfillmentOrder(o.fulfillmentOrders[1]!.id, f.loc2);
    expect(level(f.sim, f.itemId, f.loc2)).toMatchObject({ available: -1, committed: 1 });
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ available: 7, committed: 3 });
    expect(() => o.mergeFulfillmentOrders(o.fulfillmentOrders.map((x) => x.id))).toThrow(/cannot be merged/);
    o.moveFulfillmentOrder(o.fulfillmentOrders[1]!.id, f.loc);
    o.mergeFulfillmentOrders(o.fulfillmentOrders.map((x) => x.id));
    expect(o.fulfillmentOrders[0]?.lines[0]?.remainingQuantity).toBe(4);
    expect(topics(f)).toEqual(expect.arrayContaining(['fulfillment_orders/split', 'fulfillment_orders/moved', 'fulfillment_orders/merged']));
  });

  it('returns: request, approve, dispose, close, with restock effects', () => {
    const f = fixture();
    const o = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 2 }] }).fulfill();
    o.createReturn({ lines: [{ line: 0, quantity: 2, reason: 'DEFECTIVE' }], requested: true });
    const ret = o.returns[0]!;
    expect(ret.status).toBe('REQUESTED');
    expect(ret.reverseFulfillmentOrders).toHaveLength(0);
    o.approveReturn(ret.id);
    expect(ret.reverseFulfillmentOrders).toHaveLength(1);
    o.dispose(ret.id, [{ line: 0, quantity: 1, disposition: 'RESTOCKED', locationId: f.loc }, { line: 0, quantity: 1, disposition: 'PROCESSING_REQUIRED', locationId: f.loc }]);
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ available: 9 });
    expect(() => o.dispose(ret.id, [{ line: 0, quantity: 1, disposition: 'MISSING' }])).toThrow(/already disposed/);
    o.closeReturn(ret.id);
    expect(topics(f)).toEqual(expect.arrayContaining(['returns/request', 'returns/approve', 'reverse_fulfillment_orders/dispose', 'returns/close']));
    expect(() => o.createReturn({ lines: [{ line: 0, quantity: 1 }] })).toThrow(/Cannot return/);
  });

  it('PROCESSING_REQUIRED stock behaviour is switchable (PV-3)', () => {
    const f = fixture({ merchant: { processingRequiredStock: 'available' } });
    const o = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 1 }] }).fulfill();
    o.createReturn({ lines: [{ line: 0, quantity: 1 }] });
    o.dispose(o.returns[0]!.id, [{ line: 0, quantity: 1, disposition: 'PROCESSING_REQUIRED' }]);
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ available: 10 });
  });

  it('POS sale arrives fulfilled with _serialis_units', () => {
    const f = fixture();
    const o = f.sim.merchant.posSale({ locationId: f.loc, lines: [{ variantId: f.variantId, quantity: 2, units: ['tok1', 'tok2'] }] });
    expect(o.data.sourceName).toBe('pos');
    expect(o.lines[0]?.customAttributes).toEqual([{ key: '_serialis_units', value: 'tok1,tok2' }]);
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ available: 8, committed: 0, on_hand: 8 });
    const created = f.sim.shop.events.find((e) => e.topic === 'orders/create')!.payload as { fulfillment_status: string; source_name: string };
    expect(created.fulfillment_status).toBe('fulfilled');
    expect(topics(f)).toContain('fulfillments/create');
  });

  it('manual adjustment emits inventory_levels/update only when available moves', () => {
    const f = fixture();
    f.sim.merchant.adjustInventory({ itemId: f.itemId, locationId: f.loc, delta: -2 });
    f.sim.merchant.adjustInventory({ itemId: f.itemId, locationId: f.loc, delta: 1, name: 'damaged' });
    expect(topics(f)).toEqual(['inventory_levels/update']);
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ available: 8, damaged: 1, on_hand: 9 });
  });

  it('cancelFulfillment puts quantities back to committed', () => {
    const f = fixture();
    const o = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 2 }] }).fulfill();
    o.cancelFulfillment(o.fulfillments[0]!.id);
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ available: 8, committed: 2, on_hand: 10 });
    expect(o.fulfillmentOrders[0]?.status).toBe('OPEN');
  });
});
