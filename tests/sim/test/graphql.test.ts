import { describe, expect, it } from 'vitest';
import { ADJUST, fixture, gql, level } from './helpers.js';

const ORDER_QUERY = `query ($id: ID!) {
  order(id: $id) {
    id name cancelledAt displayFulfillmentStatus sourceName
    lineItems(first: 3) { nodes { id quantity currentQuantity unfulfilledQuantity customAttributes { key value } variant { id inventoryItem { id tracked } } } }
    fulfillmentOrders(first: 3) { nodes { id status assignedLocation { location { id } } fulfillmentHolds { handle } lineItems(first: 3) { nodes { totalQuantity remainingQuantity lineItem { id } } } } }
    fulfillments(first: 3) { id status fulfillmentLineItems(first: 3) { nodes { quantity lineItem { id } } } }
    refunds { id refundLineItems(first: 3) { nodes { quantity restockType location { id } lineItem { id } } } }
    returns(first: 3) { nodes { id status returnLineItems(first: 3) { nodes { quantity returnReason } } reverseFulfillmentOrders(first: 5) { nodes { id lineItems(first: 5) { nodes { totalQuantity dispositions { type quantity location { id } } } } } } } }
    metafield(namespace: "serialis", key: "units") { value }
  }
}`;

describe('read path', () => {
  it('reads an order with fulfillment orders, fulfillments, refunds, returns', async () => {
    const f = fixture();
    const o = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 3, properties: { _serialis_units: 'a,b' } }] });
    o.fulfill({ lines: [{ line: 0, quantity: 2 }] });
    o.refund({ lines: [{ line: 0, quantity: 1, restockType: 'CANCEL' }] });
    o.createReturn({ lines: [{ line: 0, quantity: 1, reason: 'WRONG_ITEM' }] });
    o.dispose(o.returns[0]!.id, [{ line: 0, quantity: 1, disposition: 'RESTOCKED', locationId: f.loc }]);
    const r = await gql(f.sim, ORDER_QUERY, { id: o.id });
    expect(r.errors).toBeUndefined();
    const ord = r.data.order;
    expect(ord.displayFulfillmentStatus).toBe('FULFILLED');
    expect(ord.lineItems.nodes[0]).toMatchObject({ quantity: 3, currentQuantity: 2, unfulfilledQuantity: 0, customAttributes: [{ key: '_serialis_units', value: 'a,b' }] });
    expect(ord.fulfillmentOrders.nodes[0]).toMatchObject({ status: 'CLOSED', assignedLocation: { location: { id: f.loc } } });
    expect(ord.fulfillments[0].fulfillmentLineItems.nodes[0].quantity).toBe(2);
    expect(ord.refunds[0].refundLineItems.nodes[0]).toMatchObject({ quantity: 1, restockType: 'CANCEL', location: { id: f.loc } });
    expect(ord.returns.nodes[0].reverseFulfillmentOrders.nodes[0].lineItems.nodes[0].dispositions).toEqual([{ type: 'RESTOCKED', quantity: 1, location: { id: f.loc } }]);
    expect(ord.metafield).toBeNull();
    expect(r.extensions.cost.throttleStatus.maximumAvailable).toBe(1000);
    expect(r.extensions.cost.requestedQueryCost).toBeGreaterThan(r.extensions.cost.actualQueryCost);
  });

  it('reads inventory levels by item ids with named quantities', async () => {
    const f = fixture();
    f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 2 }] });
    const r = await gql(f.sim, `query ($ids: [ID!]!) { nodes(ids: $ids) { ... on InventoryItem { id inventoryLevels(first: 5) { nodes { location { id } quantities(names: ["available","committed","on_hand","quality_control"]) { name quantity } } } } } }`, { ids: [f.itemId, 'gid://shopify/InventoryItem/999999'] });
    expect(r.data.nodes[1]).toBeNull();
    const q = Object.fromEntries(r.data.nodes[0].inventoryLevels.nodes[0].quantities.map((x: { name: string; quantity: number }) => [x.name, x.quantity]));
    expect(q).toEqual({ available: 8, committed: 2, on_hand: 10, quality_control: 0 });
    const bad = await gql(f.sim, `{ inventoryItem(id: "${f.itemId}") { inventoryLevels(first: 5) { nodes { quantities { name } } } } }`);
    expect(bad.data.inventoryItem.inventoryLevels.nodes[0].quantities).toBeNull();
    expect(bad.errors[0].message).toMatch(/names/);
  });

  it('variants and products, query filters, pagination', async () => {
    const f = fixture();
    const r = await gql(f.sim, `{ productVariants(first: 1, query: "sku:BIKE-L") { nodes { id sku product { title } inventoryItem { id } } pageInfo { hasNextPage endCursor } } }`);
    expect(r.data.productVariants.nodes[0]).toMatchObject({ sku: 'BIKE-L', product: { title: 'Bike' } });
    const p1 = await gql(f.sim, `{ productVariants(first: 1) { nodes { sku } pageInfo { hasNextPage endCursor } } }`);
    expect(p1.data.productVariants.pageInfo.hasNextPage).toBe(true);
    const p2 = await gql(f.sim, `query($c: String) { productVariants(first: 1, after: $c) { nodes { sku } pageInfo { hasNextPage } } }`, { c: p1.data.productVariants.pageInfo.endCursor });
    expect(p2.data.productVariants.nodes[0].sku).toBe('BIKE-L');
    expect(p2.data.productVariants.pageInfo.hasNextPage).toBe(false);
    const noFirst = await gql(f.sim, `{ productVariants { nodes { sku } } }`);
    expect(noFirst.errors[0].message).toMatch(/first/);
  });

  it('orders by updated_at window (R1) and 60-day visibility without read_all_orders', async () => {
    const f = fixture({ scopes: ['read_orders', 'read_products', 'read_inventory', 'read_locations'] });
    const o1 = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 1 }] });
    const cut = f.sim.clock.iso();
    f.sim.clock.advance(1000);
    const o2 = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 1 }] });
    const r = await gql(f.sim, `query($q: String) { orders(first: 10, query: $q, sortKey: UPDATED_AT) { nodes { id } } }`, { q: `updated_at:>${cut}` });
    expect(r.data.orders.nodes.map((n: { id: string }) => n.id)).toEqual([o2.id]);
    f.sim.clock.advance(61 * 24 * 3600 * 1000);
    const old = await gql(f.sim, `{ order(id: "${o1.id}") { id } }`);
    expect(old.data.order).toBeNull();
    f.sim.shop.scopes.push('read_all_orders');
    expect((await gql(f.sim, `{ order(id: "${o1.id}") { id } }`)).data.order.id).toBe(o1.id);
  });

  it('missing scope gives ACCESS_DENIED on that field only', async () => {
    const f = fixture({ scopes: ['read_orders', 'read_products'] });
    const o = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 1 }] });
    const r = await gql(f.sim, `{ order(id: "${o.id}") { id returns(first: 1) { nodes { id } } } }`);
    expect(r.data.order.id).toBe(o.id);
    expect(r.data.order.returns).toBeNull();
    expect(r.errors[0]).toMatchObject({ path: ['order', 'returns'], extensions: { code: 'ACCESS_DENIED' } });
  });

  it('currentAppInstallation exposes scopes; unknown fields fail validation', async () => {
    const f = fixture();
    const r = await gql(f.sim, `{ currentAppInstallation { accessScopes { handle } } }`);
    expect(r.data.currentAppInstallation.accessScopes.map((s: { handle: string }) => s.handle)).toContain('write_inventory');
    const o = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 1 }] });
    const bad = await gql(f.sim, `{ order(id: "${o.id}") { nope } }`);
    expect(bad.data).toBeUndefined();
    expect(bad.errors[0].extensions.code).toBe('undefinedField');
  });

  it('rejects syntax errors, wrong host and wrong API version', async () => {
    const f = fixture();
    const r = await gql(f.sim, '{ order(');
    expect(r.errors[0].message).toMatch(/Syntax/);
    expect((await f.sim.fetch('https://other.myshopify.com/admin/api/2026-10/graphql.json', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await f.sim.fetch('https://sim-shop.myshopify.com/admin/api/2025-01/graphql.json', { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('metafieldsSet writes order and variant metafields; order write fires orders/updated once', async () => {
    const f = fixture();
    const o = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 1 }] });
    const before = f.sim.shop.events.length;
    const q = `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { namespace key value } userErrors { field code } } }`;
    const m = [{ ownerId: o.id, namespace: 'serialis', key: 'units', type: 'json', value: '{"version":1}' }, { ownerId: f.variantId, namespace: 'serialis', key: 'x', type: 'single_line_text_field', value: 'y' }];
    const r1 = await gql(f.sim, q, { m });
    expect(r1.data.metafieldsSet.userErrors).toEqual([]);
    expect(f.sim.shop.events.slice(before).map((e) => e.topic)).toEqual(['orders/updated']);
    await gql(f.sim, q, { m });
    expect(f.sim.shop.events.length).toBe(before + 1);
    const read = await gql(f.sim, `{ order(id: "${o.id}") { metafield(namespace: "serialis", key: "units") { value type } } }`);
    expect(read.data.order.metafield).toEqual({ value: '{"version":1}', type: 'json' });
    const bad = await gql(f.sim, q, { m: [{ ...m[0], value: '{nope' }] });
    expect(bad.data.metafieldsSet.userErrors[0].code).toBe('INVALID_VALUE');
  });

  it('holds: hold, duplicate handle, release emits hold_released, refused when closed', async () => {
    const f = fixture();
    const o = f.sim.merchant.createOrder({ lines: [{ variantId: f.variantId, quantity: 1 }] });
    const fo = o.fulfillmentOrders[0]!;
    const hold = `mutation($id: ID!) { fulfillmentOrderHold(id: $id, fulfillmentHold: { reason: OTHER, handle: "serialis" }) { fulfillmentOrder { status } userErrors { code } } }`;
    expect((await gql(f.sim, hold, { id: fo.id })).data.fulfillmentOrderHold.fulfillmentOrder.status).toBe('ON_HOLD');
    expect((await gql(f.sim, hold, { id: fo.id })).data.fulfillmentOrderHold.userErrors[0].code).toBe('DUPLICATE_FULFILLMENT_HOLD_HANDLE');
    expect(() => o.fulfill()).toThrow(/on hold/);
    const rel = await gql(f.sim, `mutation($id: ID!) { fulfillmentOrderReleaseHold(id: $id) { fulfillmentOrder { status } userErrors { code } } }`, { id: fo.id });
    expect(rel.data.fulfillmentOrderReleaseHold.fulfillmentOrder.status).toBe('OPEN');
    expect(f.sim.shop.events.at(-1)?.topic).toBe('fulfillment_orders/hold_released');
    o.fulfill();
    expect((await gql(f.sim, hold, { id: fo.id })).data.fulfillmentOrderHold.userErrors[0].code).toBe('FULFILLMENT_ORDER_NOT_HOLDABLE');
  });

  it('bulk operation stub: run, complete, download JSONL, finish webhook', async () => {
    const f = fixture();
    const run = `mutation { bulkOperationRunQuery(query: "{ inventoryItems { edges { node { id } } } }") { bulkOperation { id status } userErrors { code } } }`;
    const r = await gql(f.sim, run);
    expect(r.data.bulkOperationRunQuery.bulkOperation.status).toBe('RUNNING');
    const done = f.sim.completeBulkOperation();
    const cur = await gql(f.sim, `{ currentBulkOperation(type: QUERY) { id status url } }`);
    expect(cur.data.currentBulkOperation.status).toBe('COMPLETED');
    const text = await (await f.sim.fetch(done.url!)).text();
    const lines = text.split('\n').map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.__parentId === f.itemId)[0].quantities.find((q: { name: string }) => q.name === 'available').quantity).toBe(10);
    expect(f.sim.shop.events.at(-1)?.topic).toBe('bulk_operations/finish');
  });

  it('adjustment keeps level helper consistent', () => {
    const f = fixture();
    expect(ADJUST).toContain('@idempotent');
    expect(level(f.sim, f.itemId, f.loc).on_hand).toBe(10);
  });
});
