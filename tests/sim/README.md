# @serialis/shopify-sim

In-memory, deterministic fake of one Shopify shop and of its Admin GraphQL API, for tests (spec 12.8, 18.1, 18.3).
Only standard `fetch` / `Request` / `Response` / WebCrypto APIs are used, so it runs in Node and inside workerd tests.
Shop domain: `sim-shop.myshopify.com`, API version `2026-10`.

```ts
import { createShopifySim } from '@serialis/shopify-sim';

const sim = createShopifySim({ webhookSecret: 'test-secret' });
const loc = sim.addLocation('Main');
const { variantIds, itemIds } = sim.addProduct('Bike', [{ sku: 'B-M', stock: { [loc]: 10 } }]);

// Give the code under test the sim as its fetch:
const res = await sim.fetch('https://sim-shop.myshopify.com/admin/api/2026-10/graphql.json', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: '{ shop { name } }' }),
});
```

Everything is virtual: time is `sim.clock` (advance it with `sim.clock.advance(ms)`), randomness is seeded, ids are sequential.

## Seeding

`sim.addLocation(name, { active? })` and `sim.addProduct(title, [{ sku, tracked?, stock: { [locationId]: available } }])` create data without webhooks.
`sim.shop` exposes the raw state (maps of `orders`, `fulfillmentOrders`, `levels`, `returns`, ...), `sim.shop.scopes` the installation scopes
(an app without `read_all_orders` only sees orders from the last 60 days; a missing scope gives `ACCESS_DENIED` on that field).

## Merchant scenarios (state + webhooks)

`sim.merchant` acts like a merchant in the admin. Stock effects follow spec 7.2 (order: `available` -> `committed`; fulfilment: `committed` leaves `on_hand`; cancel/remove with
restock: back to `available`; without restock: gone; return restock: `available` +).

```ts
const order = sim.merchant.createOrder({ lines: [{ variantId: variantIds[0]!, quantity: 3, properties: { note: 'x' } }] });
order.fulfill({ lines: [{ line: 0, quantity: 1 }] });             // partial; fulfill() = everything left
order.edit().reduceLine(0, { by: 1 }, { restock: false }).addLine({ variantId, quantity: 1 }).commit();
order.cancel({ restock: false });                                  // { refund: false } for no refund record
order.refund({ lines: [{ line: 0, quantity: 1, restockType: 'RETURN', locationId: loc }] });
order.moveFulfillmentOrder(order.fulfillmentOrders[0]!.id, otherLoc);   // partial: pass `lines`
order.splitFulfillmentOrder(foId, [{ line: 0, quantity: 1 }]);
order.mergeFulfillmentOrders([foA, foB]);
order.createReturn({ lines: [{ line: 0, quantity: 1 }], requested: true }); // REQUESTED; omit `requested` for OPEN
order.approveReturn(order.returns[0]!.id);
order.dispose(returnId, [{ line: 0, quantity: 1, disposition: 'RESTOCKED', locationId: loc }]);
order.cancelFulfillment(order.fulfillments[0]!.id);

sim.merchant.posSale({ locationId: loc, lines: [{ variantId, quantity: 2, units: ['tok1', 'tok2'] }] }); // arrives fulfilled, `_serialis_units: "tok1,tok2"`
sim.merchant.adjustInventory({ itemId, locationId: loc, delta: -2 });        // also name: 'damaged' | ...
sim.merchant.setAvailable({ itemId, locationId: loc, quantity: 7 });
sim.merchant.deactivateLocation(loc); sim.merchant.untrackVariant(variantId); sim.merchant.deleteProduct(productId); sim.merchant.uninstallApp();
```

Lines are designated by index or gid. Action methods return the `OrderHandle`; read what was created from `order.lines / fulfillmentOrders / fulfillments / refunds / returns`.
Options: `merchant: { processingRequiredStock: 'none' | 'available' }` (spec gate PV-3: what Shopify adds for a `PROCESSING_REQUIRED` disposition), `editPayloadRestock` (adds `restock` to `orders/edited` removals; PV-14).

## GraphQL

`sim.fetch` serves `POST https://sim-shop.myshopify.com/admin/api/2026-10/graphql.json` (the `graphql` package parses; routing is by root field).

- Queries: `order`, `orders` (`query: "updated_at:>=..."`, `sortKey`, `reverse`), `node`, `nodes`, `inventoryItem(s)`, `inventoryLevel`, `productVariant(s)`, `product(s)`, `location(s)`, `fulfillmentOrder`, `return`, `shop`, `currentAppInstallation`, `currentBulkOperation`, `bulkOperation`. Orders expose line items (quantity, currentQuantity, `customAttributes`), fulfillment orders (status, location, holds, remaining quantity), fulfillments, refunds with `restockType`/location, returns with reverse fulfillment orders and dispositions, metafields. `quantities(names: [...])` is required, connections need `first`/`last`.
- Mutations: `inventoryAdjustQuantities`, `inventorySetQuantities`, `inventoryMoveQuantities`, `inventoryActivate`, `inventoryItemUpdate`, `metafieldsSet` (orders, variants; an order write fires `orders/updated`, an unchanged value does not), `metafieldsDelete`, `fulfillmentOrderHold`, `fulfillmentOrderReleaseHold`, `bulkOperationRunQuery` / `bulkOperationCancel` (stub: finish it with `sim.completeBulkOperation()`, which emits `bulk_operations/finish` and serves a JSONL file at `operation.url`).
- Stock mutations: `@idempotent(key: ...)` is required (on the mutation field, as Shopify documents it, or on the operation) (a missing directive is an error and is listed in `sim.violations`). `changeFromQuantity` is required: absent = request error, `null` = accepted but recorded in `sim.violations`, stale = `userErrors: [{ field: ["input","changes","0","changeFromQuantity"], code: "CHANGE_FROM_QUANTITY_STALE" }]` with nothing applied. Same key and payload = same stored result, not applied twice (24 h of sim time); same key with another payload = `IDEMPOTENCY_KEY_PARAMETER_MISMATCH`; replay of a failed attempt = `IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED` (`replayFailed: 'same_result'` to change). Ledger rules: non-`available` changes need a `ledgerDocumentUri`, `gid://shopify/...` gives `INTERNAL_LEDGER_DOCUMENT`, two different ones `MAX_ONE_LEDGER_DOCUMENT`, `committed` is not writable. A write where the item is not stocked creates an inactive level (2026-04) until `inventoryActivate`.
- Cost: `extensions.cost` with `requestedQueryCost`, `actualQueryCost`, `throttleStatus` (bucket `{ bucket: { maximumAvailable: 1000, restoreRate: 100 } }`, refilled by the sim clock). Objects cost 1, connections multiply by `first`; mutations add 10. Exceeding the bucket returns `THROTTLED`; a single query over 1000 returns `MAX_COST_EXCEEDED`. `sim.setBucket(n)`, `sim.throttleStatus()`.
- `sim.requests` logs every request (operations, status, fault, idempotency key, cost, error codes); `sim.callCount('inventoryAdjustQuantities')`.
- Auth: with `enforceAuth: true` `X-Shopify-Access-Token` must be a live token from the OAuth endpoint (401 otherwise).

### OAuth

`POST https://sim-shop.myshopify.com/admin/oauth/access_token` (JSON or form body): token exchange (`urn:ietf:params:oauth:grant-type:token-exchange`, offline token type) and `refresh_token` grants return `{ access_token, scope, expires_in: 3600, refresh_token, refresh_token_expires_in }`. Refresh rotates the pair; the previous refresh token stays valid until the new access token is first used (a lost refresh response can be retried, T-CH-07). `sim.oauth.expireAccessTokens()`.

## Faults

```ts
sim.faults.add({ operation: 'inventoryAdjustQuantities', calls: { from: 2, to: 3 }, fault: { kind: 'http', status: 503 } });
sim.faults.add({ operation: 'inventoryMoveQuantities', calls: 1, fault: { kind: 'timeout', applied: true } }); // lost response
sim.faults.add({ operation: 'inventoryAdjustQuantities', calls: 1, fault: { kind: 'staleChange' } });
```

`operation` is a root field name, `oauth`, or `*`; `calls` is a 1-based call number, a list or `{ from, to }`; `times` caps the firings. `add` returns a remover.
Kinds: `timeout` (rejects with a `TimeoutError`; `applied: true` runs the mutation first), `http` (any status, e.g. 502, 402), `throttled`, `staleChange` (a concurrent writer really moves the quantity first and `inventory_levels/update` fires, so `changeFromQuantity` is genuinely stale), `userError` (e.g. `SERVICE_UNAVAILABLE`), `graphqlError` (e.g. `IDEMPOTENCY_CONCURRENT_REQUEST`).

## Webhooks

Every scenario appends to `sim.shop.events`. Delivery is explicit, signed (HMAC-SHA256 base64 of the body, headers `X-Shopify-Hmac-Sha256`, `-Topic`, `-Shop-Domain`, `-Webhook-Id`, `-Triggered-At`, `-API-Version`):

```ts
import { SELF } from 'cloudflare:test';
await sim.webhooks.deliver({
  url: 'https://hooks.serialis.dev/webhooks/shopify',
  send: (req) => SELF.fetch(req),
  duplicate: 2,                       // extra copies, same webhook id
  delayMs: (e) => (e.topic === 'orders/create' ? 30_000 : 0), // late events arrive after later ones; the sim clock advances
  reorder: 'shuffle',                 // or 'reverse' or a function; `seed` makes it reproducible
  drop: 0.2,                          // lost webhooks (listed in report.dropped)
  concurrent: false,
});
sim.webhooks.pending(); await sim.webhooks.requests(url); // signed Requests without sending
```

Topics emitted: `orders/create|updated|edited|cancelled`, `fulfillments/create|update`, `fulfillment_orders/order_routing_complete|moved|split|merged|cancelled|hold_released`, `refunds/create`, `returns/request|approve|decline|cancel|close|update`, `reverse_fulfillment_orders/dispose`, `inventory_levels/update` (when `available` changes), `inventory_items/update`, `locations/deactivate`, `products/delete`, `bulk_operations/finish`, `app/uninstalled`.

## Limits

- Webhook payloads are REST-style approximations carrying the fields the sync reads (ids, quantities, locations, restock types, properties), not full Shopify payloads; `returns/process`, draft orders, transfers/shipments, scheduled fulfillment orders and fulfillment services are not modelled.
- The orders/edited payload has no restock flag unless `editPayloadRestock` is set (PV-14 unresolved); the stock effect of `PROCESSING_REQUIRED` is a switch (PV-3).
- Query validation is shallow: an unknown field is reported only when its parent object resolves; argument types are not checked. Costs are an approximation of Shopify's model, not a measurement.
- Some error codes (`FULFILLMENT_ORDER_NOT_HOLDABLE`, `INVALID_AVAILABLE_DOCUMENT`, ...) are plausible names, not recordings; those cited by the spec (`CHANGE_FROM_QUANTITY_STALE`, `INTERNAL_LEDGER_DOCUMENT`, `MAX_ONE_LEDGER_DOCUMENT`, `IDEMPOTENCY_*`, `THROTTLED`) are used as written.
