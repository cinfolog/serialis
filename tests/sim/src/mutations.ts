import type { Ctx } from './engine.js';
import { SimAbort } from './engine.js';
import { gqlBulk, gqlFulfillmentOrder, gqlItem, gqlLevel, gqlMetafieldDefinition } from './builders.js';
import type { InventoryItem, InventoryLevel, Metafield, StoredQuantityName } from './model.js';
import { ON_HAND_COMPONENTS, WRITABLE_QUANTITY_NAMES } from './model.js';
import { orderPayload } from './payloads.js';
import { numericId } from './util.js';

type Obj = Record<string, unknown>;

export interface UserError {
  field: (string | number)[] | null;
  message: string;
  code: string;
}

export interface MutationEnv {
  ctx: Ctx;
  /** Contract breaches by the caller (null `changeFromQuantity`, ...); tests can assert it stays empty. */
  violations: string[];
  /** Max simultaneous bulk operations. */
  maxBulkOperations: number;
}

export interface MutationResult {
  payload: Obj;
  /** True when the payload carries userErrors (nothing applied). */
  failed: boolean;
}

/** GraphQL `field` paths are lists of strings (indexes included). */
const ue = (errors: UserError[]): Obj[] => errors.map((e) => ({ __typename: 'UserError', field: e.field ? e.field.map(String) : null, message: e.message, code: e.code }));
const fail = (errors: UserError[], extra: Obj = {}): MutationResult => ({ payload: { __typename: 'Payload', ...extra, userErrors: ue(errors) }, failed: errors.length > 0 });

function asObj(v: unknown): Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}
function asArr(v: unknown): Obj[] {
  return Array.isArray(v) ? v.map(asObj) : [];
}

/** `changeFromQuantity` must be present (nullable but required since 2026-04); `null` disables the check and is recorded. */
function readChangeFrom(obj: Obj, where: string, env: MutationEnv): number | null {
  if (!('changeFromQuantity' in obj)) {
    throw new SimAbort([{ message: `${where}: 'changeFromQuantity' is required (pass the expected quantity, or null to skip the check)`, extensions: { code: 'INVALID_VARIABLE' } }]);
  }
  const v = obj['changeFromQuantity'];
  if (v === null || v === undefined) {
    env.violations.push(`${where}: changeFromQuantity null (compare-and-set disabled)`);
    return null;
  }
  return Number(v);
}

function stale(path: (string | number)[]): UserError {
  return { field: path, message: 'The specified changeFromQuantity does not match the current quantity.', code: 'CHANGE_FROM_QUANTITY_STALE' };
}

interface Target {
  item: InventoryItem;
  location: string;
}

function resolveTarget(env: MutationEnv, itemId: unknown, locationId: unknown, path: (string | number)[], errs: UserError[]): Target | null {
  const item = env.ctx.shop.items.get(String(itemId));
  if (!item) {
    errs.push({ field: [...path, 'inventoryItemId'], message: "The specified inventory item couldn't be found.", code: 'INVENTORY_ITEM_NOT_FOUND' });
    return null;
  }
  if (!env.ctx.shop.locations.has(String(locationId))) {
    errs.push({ field: [...path, 'locationId'], message: "The specified location couldn't be found.", code: 'LOCATION_NOT_FOUND' });
    return null;
  }
  return { item, location: String(locationId) };
}

function ledgerRules(env: MutationEnv, name: string, uri: unknown, path: (string | number)[], errs: UserError[], seen: Set<string>): void {
  if (name === 'available') {
    if (uri) errs.push({ field: path, message: 'A ledgerDocumentUri is not allowed for the available quantity.', code: 'INVALID_AVAILABLE_DOCUMENT' });
    return;
  }
  if (typeof uri !== 'string' || uri === '') {
    errs.push({ field: path, message: `A ledgerDocumentUri is required to change the ${name} quantity.`, code: 'INVALID_LEDGER_DOCUMENT' });
    return;
  }
  if (uri.startsWith('gid://shopify/')) {
    errs.push({ field: path, message: 'The ledgerDocumentUri cannot reference a Shopify resource.', code: 'INTERNAL_LEDGER_DOCUMENT' });
    return;
  }
  seen.add(uri);
}

function ledgerSingle(seen: Set<string>, errs: UserError[]): void {
  if (seen.size > 1) errs.push({ field: ['input'], message: 'Only one ledgerDocumentUri is allowed per mutation.', code: 'MAX_ONE_LEDGER_DOCUMENT' });
}

function levelQty(env: MutationEnv, t: Target, name: string): number {
  const lv = env.ctx.shop.getLevel(t.item.id, t.location);
  if (!lv) return 0;
  return env.ctx.shop.quantity(lv, name as StoredQuantityName | 'on_hand');
}

function applyWrite(env: MutationEnv, t: Target, name: StoredQuantityName, delta: number): InventoryLevel {
  const shop = env.ctx.shop;
  // Since 2026-04 a quantity write at a location where the item is not stocked creates an inactive level.
  const existed = shop.getLevel(t.item.id, t.location) !== undefined;
  return shop.changeQuantity(t.item.id, t.location, name, delta, { activeIfCreated: existed });
}

function groupPayload(env: MutationEnv, input: Obj, changes: Obj[]): Obj {
  const shop = env.ctx.shop;
  return {
    __typename: 'InventoryAdjustmentGroup',
    id: shop.nextId('InventoryAdjustmentGroup'),
    createdAt: shop.stamp(),
    reason: input['reason'] ?? null,
    referenceDocumentUri: input['referenceDocumentUri'] ?? null,
    changes,
  };
}

function changeEntry(env: MutationEnv, lv: InventoryLevel, name: string, delta: number, ledger: unknown): Obj {
  return {
    __typename: 'InventoryChange',
    name,
    delta,
    quantityAfterChange: null,
    ledgerDocumentUri: typeof ledger === 'string' ? ledger : null,
    item: () => gqlItem(env.ctx, env.ctx.shop.items.get(lv.itemId) as InventoryItem),
    location: () => ({ __typename: 'Location', id: lv.locationId }),
    ...{ _q: env.ctx.shop.quantity(lv, name as StoredQuantityName | 'on_hand') },
  };
}

function withAfter(entry: Obj): Obj {
  const q = entry['_q'];
  delete entry['_q'];
  entry['quantityAfterChange'] = q;
  return entry;
}

export function inventoryAdjustQuantities(env: MutationEnv, args: Obj): MutationResult {
  env.ctx.requireAny(['write_inventory']);
  const input = asObj(args['input']);
  const errs: UserError[] = [];
  const name = String(input['name']);
  if (!WRITABLE_QUANTITY_NAMES.includes(name)) errs.push({ field: ['input', 'name'], message: `The quantity name '${name}' is not valid for this operation.`, code: 'INVALID_NAME' });
  const changes = asArr(input['changes']);
  if (changes.length === 0) errs.push({ field: ['input', 'changes'], message: 'At least one change is required.', code: 'NO_CHANGES' });
  const seen = new Set<string>();
  const planned: { t: Target; delta: number; ledger: unknown }[] = [];
  changes.forEach((c, i) => {
    const path = ['input', 'changes', i];
    const t = resolveTarget(env, c['inventoryItemId'], c['locationId'], path, errs);
    const from = readChangeFrom(c, `inventoryAdjustQuantities.changes[${i}]`, env);
    if (WRITABLE_QUANTITY_NAMES.includes(name)) ledgerRules(env, name, c['ledgerDocumentUri'], [...path, 'ledgerDocumentUri'], errs, seen);
    if (!t) return;
    if (from !== null && levelQty(env, t, name) !== from) errs.push(stale([...path, 'changeFromQuantity']));
    planned.push({ t, delta: Number(c['delta']), ledger: c['ledgerDocumentUri'] });
  });
  ledgerSingle(seen, errs);
  if (errs.length > 0) return fail(errs, { inventoryAdjustmentGroup: null });
  const out: Obj[] = [];
  env.ctx.shop.batchLevels(() => {
    for (const p of planned) {
      const lv = applyWrite(env, p.t, name as StoredQuantityName, p.delta);
      out.push(withAfter(changeEntry(env, lv, name, p.delta, p.ledger)));
      if (ON_HAND_COMPONENTS.includes(name as StoredQuantityName)) out.push(withAfter(changeEntry(env, lv, 'on_hand', p.delta, null)));
    }
  });
  return { payload: { __typename: 'Payload', inventoryAdjustmentGroup: groupPayload(env, input, out), userErrors: [] }, failed: false };
}

export function inventorySetQuantities(env: MutationEnv, args: Obj): MutationResult {
  env.ctx.requireAny(['write_inventory']);
  const input = asObj(args['input']);
  const errs: UserError[] = [];
  const name = String(input['name']);
  if (name !== 'available' && name !== 'on_hand') errs.push({ field: ['input', 'name'], message: `The quantity name '${name}' is not valid for this operation.`, code: 'INVALID_NAME' });
  const rows = asArr(input['quantities']);
  if (rows.length === 0) errs.push({ field: ['input', 'quantities'], message: 'At least one quantity is required.', code: 'NO_CHANGES' });
  const planned: { t: Target; delta: number }[] = [];
  rows.forEach((r, i) => {
    const path = ['input', 'quantities', i];
    const t = resolveTarget(env, r['inventoryItemId'], r['locationId'], path, errs);
    const from = readChangeFrom(r, `inventorySetQuantities.quantities[${i}]`, env);
    if (!t) return;
    const current = levelQty(env, t, name);
    if (from !== null && current !== from) errs.push(stale([...path, 'changeFromQuantity']));
    planned.push({ t, delta: Number(r['quantity']) - current });
  });
  if (errs.length > 0) return fail(errs, { inventoryAdjustmentGroup: null });
  const out: Obj[] = [];
  env.ctx.shop.batchLevels(() => {
    for (const p of planned) {
      const lv = applyWrite(env, p.t, 'available', p.delta);
      out.push(withAfter(changeEntry(env, lv, name, p.delta, null)));
      if (name === 'available') out.push(withAfter(changeEntry(env, lv, 'on_hand', p.delta, null)));
    }
  });
  return { payload: { __typename: 'Payload', inventoryAdjustmentGroup: groupPayload(env, input, out), userErrors: [] }, failed: false };
}

export function inventoryMoveQuantities(env: MutationEnv, args: Obj): MutationResult {
  env.ctx.requireAny(['write_inventory']);
  const input = asObj(args['input']);
  const errs: UserError[] = [];
  const changes = asArr(input['changes']);
  if (changes.length === 0) errs.push({ field: ['input', 'changes'], message: 'At least one change is required.', code: 'NO_CHANGES' });
  const seen = new Set<string>();
  const planned: { from: Target; to: Target; fromName: string; toName: string; qty: number; fromLedger: unknown; toLedger: unknown }[] = [];
  changes.forEach((c, i) => {
    const path = ['input', 'changes', i];
    const f = asObj(c['from']);
    const t = asObj(c['to']);
    const qty = Number(c['quantity']);
    const fromT = resolveTarget(env, c['inventoryItemId'], f['locationId'], [...path, 'from'], errs);
    const toT = resolveTarget(env, c['inventoryItemId'], t['locationId'], [...path, 'to'], errs);
    const fromName = String(f['name']);
    const toName = String(t['name']);
    for (const [side, n] of [['from', fromName], ['to', toName]] as const) {
      if (!WRITABLE_QUANTITY_NAMES.includes(n)) errs.push({ field: [...path, side, 'name'], message: `The quantity name '${n}' is not valid for this operation.`, code: 'INVALID_NAME' });
    }
    if (!(qty > 0)) errs.push({ field: [...path, 'quantity'], message: 'The quantity must be positive.', code: 'INVALID_QUANTITY_NEGATIVE' });
    const fromChange = readChangeFrom(f, `inventoryMoveQuantities.changes[${i}].from`, env);
    const toChange = readChangeFrom(t, `inventoryMoveQuantities.changes[${i}].to`, env);
    ledgerRules(env, fromName, f['ledgerDocumentUri'], [...path, 'from', 'ledgerDocumentUri'], errs, seen);
    ledgerRules(env, toName, t['ledgerDocumentUri'], [...path, 'to', 'ledgerDocumentUri'], errs, seen);
    if (!fromT || !toT) return;
    if (fromT.location === toT.location && fromName === toName) errs.push({ field: path, message: 'The from and to quantities must differ.', code: 'SAME_QUANTITY_NAME' });
    if (fromChange !== null && levelQty(env, fromT, fromName) !== fromChange) errs.push(stale([...path, 'from', 'changeFromQuantity']));
    if (toChange !== null && levelQty(env, toT, toName) !== toChange) errs.push(stale([...path, 'to', 'changeFromQuantity']));
    planned.push({ from: fromT, to: toT, fromName, toName, qty, fromLedger: f['ledgerDocumentUri'], toLedger: t['ledgerDocumentUri'] });
  });
  ledgerSingle(seen, errs);
  if (errs.length > 0) return fail(errs, { inventoryAdjustmentGroup: null });
  const out: Obj[] = [];
  env.ctx.shop.batchLevels(() => {
    for (const p of planned) {
      const a = applyWrite(env, p.from, p.fromName as StoredQuantityName, -p.qty);
      const b = applyWrite(env, p.to, p.toName as StoredQuantityName, p.qty);
      out.push(withAfter(changeEntry(env, a, p.fromName, -p.qty, p.fromLedger)));
      out.push(withAfter(changeEntry(env, b, p.toName, p.qty, p.toLedger)));
    }
  });
  return { payload: { __typename: 'Payload', inventoryAdjustmentGroup: groupPayload(env, input, out), userErrors: [] }, failed: false };
}

export function inventoryActivate(env: MutationEnv, args: Obj): MutationResult {
  env.ctx.requireAny(['write_inventory']);
  const errs: UserError[] = [];
  const t = resolveTarget(env, args['inventoryItemId'], args['locationId'], [], errs);
  if (!t) return fail(errs, { inventoryLevel: null });
  const shop = env.ctx.shop;
  const lv = shop.ensureLevel(t.item.id, t.location, true);
  shop.batchLevels(() => {
    lv.isActive = true;
    if (typeof args['available'] === 'number') shop.changeQuantity(t.item.id, t.location, 'available', args['available'] - lv.q.available);
  });
  return { payload: { __typename: 'Payload', inventoryLevel: gqlLevel(env.ctx, lv), userErrors: [] }, failed: false };
}

export function inventoryItemUpdate(env: MutationEnv, args: Obj): MutationResult {
  env.ctx.requireAny(['write_inventory']);
  const shop = env.ctx.shop;
  const item = shop.items.get(String(args['id']));
  if (!item) return fail([{ field: ['id'], message: "Inventory item couldn't be found.", code: 'INVENTORY_ITEM_NOT_FOUND' }], { inventoryItem: null });
  const input = asObj(args['input']);
  if (typeof input['tracked'] === 'boolean' && input['tracked'] !== item.tracked) {
    item.tracked = input['tracked'];
    shop.emit('inventory_items/update', { id: numericId(item.id), admin_graphql_api_id: item.id, sku: item.sku, tracked: item.tracked });
  }
  return { payload: { __typename: 'Payload', inventoryItem: gqlItem(env.ctx, item), userErrors: [] }, failed: false };
}

export function metafieldsSet(env: MutationEnv, args: Obj): MutationResult {
  const shop = env.ctx.shop;
  const inputs = asArr(args['metafields']);
  const errs: UserError[] = [];
  if (inputs.length > 25) errs.push({ field: ['metafields'], message: 'Too many metafields (max 25).', code: 'LESS_THAN_OR_EQUAL_TO' });
  const plan: { owner: { metafields: Metafield[] }; kind: 'order' | 'variant'; orderId?: string; row: Obj }[] = [];
  inputs.forEach((m, i) => {
    const ownerId = String(m['ownerId']);
    const order = shop.orders.get(ownerId);
    const variant = shop.variants.get(ownerId);
    if (order) env.ctx.requireAny(['write_orders']);
    else if (variant) env.ctx.requireAny(['write_products']);
    else {
      errs.push({ field: ['metafields', i, 'ownerId'], message: 'Owner not found.', code: 'INVALID_OWNER' });
      return;
    }
    if (m['type'] === 'json') {
      try {
        JSON.parse(String(m['value']));
      } catch {
        errs.push({ field: ['metafields', i, 'value'], message: 'Value must be valid JSON.', code: 'INVALID_VALUE' });
        return;
      }
    }
    if (!m['namespace'] || !m['key'] || !m['type']) {
      errs.push({ field: ['metafields', i], message: 'namespace, key and type are required.', code: 'BLANK' });
      return;
    }
    plan.push(order ? { owner: order, kind: 'order', orderId: order.id, row: m } : { owner: variant as unknown as { metafields: Metafield[] }, kind: 'variant', row: m });
  });
  if (errs.length > 0) return fail(errs, { metafields: [] });
  const out: Obj[] = [];
  const touched = new Set<string>();
  for (const p of plan) {
    const ns = String(p.row['namespace']);
    const key = String(p.row['key']);
    let mf = p.owner.metafields.find((x) => x.namespace === ns && x.key === key);
    const value = String(p.row['value']);
    const type = String(p.row['type']);
    if (!mf) {
      const now = shop.stamp();
      mf = { id: shop.nextId('Metafield'), namespace: ns, key, type, value, createdAt: now, updatedAt: now };
      p.owner.metafields.push(mf);
      if (p.orderId) touched.add(p.orderId);
    } else if (mf.value !== value || mf.type !== type) {
      mf.value = value;
      mf.type = type;
      mf.updatedAt = shop.stamp();
      if (p.orderId) touched.add(p.orderId);
    }
    out.push({ __typename: 'Metafield', id: mf.id, namespace: mf.namespace, key: mf.key, type: mf.type, value: mf.value, createdAt: mf.createdAt, updatedAt: mf.updatedAt });
  }
  // An order metafield write bumps the order and fires orders/updated (spec 13.4); an unchanged value does not.
  for (const id of touched) {
    const order = shop.order(id);
    shop.touchOrder(order);
    shop.emit('orders/updated', orderPayload(shop, order));
  }
  return { payload: { __typename: 'Payload', metafields: out, userErrors: [] }, failed: false };
}

/** `metafieldsDelete`: removes order or variant metafields; an order change fires `orders/updated`, a missing one is a no-op. */
export function metafieldsDelete(env: MutationEnv, args: Obj): MutationResult {
  const shop = env.ctx.shop;
  const inputs = asArr(args['metafields']);
  const deleted: Obj[] = [];
  const touched = new Set<string>();
  for (const m of inputs) {
    const ownerId = String(m['ownerId']);
    const order = shop.orders.get(ownerId);
    const variant = shop.variants.get(ownerId);
    if (order) env.ctx.requireAny(['write_orders']);
    else if (variant) env.ctx.requireAny(['write_products']);
    const owner = (order ?? variant) as { metafields: Metafield[] } | undefined;
    const idx = owner ? owner.metafields.findIndex((x) => x.namespace === m['namespace'] && x.key === m['key']) : -1;
    if (!owner || idx < 0) {
      deleted.push(null as unknown as Obj);
      continue;
    }
    owner.metafields.splice(idx, 1);
    deleted.push({ __typename: 'MetafieldIdentifier', ownerId, namespace: m['namespace'], key: m['key'] });
    if (order) touched.add(order.id);
  }
  for (const id of touched) {
    const order = shop.order(id);
    shop.touchOrder(order);
    shop.emit('orders/updated', orderPayload(shop, order));
  }
  return { payload: { __typename: 'Payload', deletedMetafields: deleted, userErrors: [] }, failed: false };
}

const HOLD_LIMIT = 10;

export function fulfillmentOrderHold(env: MutationEnv, args: Obj): MutationResult {
  env.ctx.requireAny(['write_merchant_managed_fulfillment_orders', 'write_third_party_fulfillment_orders']);
  const shop = env.ctx.shop;
  const fo = shop.fulfillmentOrders.get(String(args['id']));
  if (!fo) return fail([{ field: ['id'], message: 'Fulfillment order does not exist.', code: 'FULFILLMENT_ORDER_NOT_FOUND' }], { fulfillmentHold: null, fulfillmentOrder: null });
  const h = asObj(args['fulfillmentHold']);
  if (fo.status !== 'OPEN' && fo.status !== 'IN_PROGRESS' && fo.status !== 'ON_HOLD') {
    return fail([{ field: ['id'], message: `The fulfillment order is ${fo.status} and cannot be held.`, code: 'FULFILLMENT_ORDER_NOT_HOLDABLE' }], { fulfillmentHold: null, fulfillmentOrder: null });
  }
  if (fo.holds.length >= HOLD_LIMIT) return fail([{ field: ['id'], message: 'Too many holds on this fulfillment order.', code: 'FULFILLMENT_ORDER_HOLD_LIMIT_REACHED' }], { fulfillmentHold: null, fulfillmentOrder: null });
  const handle = typeof h['handle'] === 'string' ? h['handle'] : '';
  if (fo.holds.some((x) => x.handle === handle)) return fail([{ field: ['fulfillmentHold', 'handle'], message: 'A hold with this handle already exists.', code: 'DUPLICATE_FULFILLMENT_HOLD_HANDLE' }], { fulfillmentHold: null, fulfillmentOrder: null });
  const hold = { id: shop.nextId('FulfillmentHold'), handle, reason: String(h['reason'] ?? 'OTHER'), reasonNotes: typeof h['reasonNotes'] === 'string' ? h['reasonNotes'] : null };
  fo.holds.push(hold);
  fo.status = 'ON_HOLD';
  fo.updatedAt = shop.stamp();
  return {
    payload: { __typename: 'Payload', fulfillmentHold: { __typename: 'FulfillmentHold', id: hold.id, handle: hold.handle, reason: hold.reason, reasonNotes: hold.reasonNotes }, fulfillmentOrder: gqlFulfillmentOrder(env.ctx, fo), remainingFulfillmentOrder: null, userErrors: [] },
    failed: false,
  };
}

export function fulfillmentOrderReleaseHold(env: MutationEnv, args: Obj): MutationResult {
  env.ctx.requireAny(['write_merchant_managed_fulfillment_orders', 'write_third_party_fulfillment_orders']);
  const shop = env.ctx.shop;
  const fo = shop.fulfillmentOrders.get(String(args['id']));
  if (!fo) return fail([{ field: ['id'], message: 'Fulfillment order does not exist.', code: 'FULFILLMENT_ORDER_NOT_FOUND' }], { fulfillmentOrder: null });
  if (fo.holds.length === 0) return fail([{ field: ['id'], message: 'The fulfillment order is not on hold.', code: 'FULFILLMENT_ORDER_NOT_ON_HOLD' }], { fulfillmentOrder: null });
  const holdIds = Array.isArray(args['holdIds']) ? (args['holdIds'] as unknown[]).map(String) : null;
  const handles = Array.isArray(args['handles']) ? (args['handles'] as unknown[]).map(String) : null;
  fo.holds = fo.holds.filter((x) => !((holdIds === null && handles === null) || holdIds?.includes(x.id) || handles?.includes(x.handle)));
  if (fo.holds.length === 0) {
    const fulfilledSome = shop.fulfillmentsOf(fo.orderId).some((f) => f.fulfillmentOrderId === fo.id && f.status === 'SUCCESS');
    fo.status = fulfilledSome ? 'IN_PROGRESS' : 'OPEN';
    shop.emit('fulfillment_orders/hold_released', { fulfillment_order: { id: numericId(fo.id), order_id: numericId(fo.orderId), assigned_location_id: numericId(fo.locationId), status: fo.status.toLowerCase() } });
  }
  fo.updatedAt = shop.stamp();
  return { payload: { __typename: 'Payload', fulfillmentOrder: gqlFulfillmentOrder(env.ctx, fo), userErrors: [] }, failed: false };
}

/** Stub: the operation is created RUNNING; the test completes it with `sim.completeBulkOperation`. */
export function bulkOperationRunQuery(env: MutationEnv, args: Obj): MutationResult {
  env.ctx.requireAny(['read_products', 'read_orders', 'read_inventory']);
  const shop = env.ctx.shop;
  const running = [...shop.bulkOperations.values()].filter((b) => b.status === 'CREATED' || b.status === 'RUNNING');
  if (running.length >= env.maxBulkOperations) {
    return fail([{ field: null, message: 'A bulk operation for this app and shop is already in progress.', code: 'OPERATION_IN_PROGRESS' }], { bulkOperation: null });
  }
  const op = { id: shop.nextId('BulkOperation'), status: 'RUNNING' as const, type: 'QUERY' as const, query: String(args['query']), createdAt: shop.stamp(), completedAt: null, url: null, objectCount: 0 };
  shop.bulkOperations.set(op.id, op);
  return { payload: { __typename: 'Payload', bulkOperation: gqlBulk(op), userErrors: [] }, failed: false };
}

export function bulkOperationCancel(env: MutationEnv, args: Obj): MutationResult {
  env.ctx.requireAny(['read_products', 'read_orders', 'read_inventory']);
  const op = env.ctx.shop.bulkOperations.get(String(args['id']));
  if (!op) return fail([{ field: ['id'], message: 'Bulk operation not found.', code: 'NOT_FOUND' }], { bulkOperation: null });
  if (op.status === 'RUNNING' || op.status === 'CREATED') op.status = 'CANCELED';
  return { payload: { __typename: 'Payload', bulkOperation: gqlBulk(op), userErrors: [] }, failed: false };
}

const DEFINITION_SCOPES: Record<string, string> = { ORDER: 'write_orders', PRODUCTVARIANT: 'write_products', PRODUCT: 'write_products' };

/** `metafieldDefinitionCreate`: one definition per owner type, namespace and key (`TAKEN` otherwise). */
export function metafieldDefinitionCreate(env: MutationEnv, args: Obj): MutationResult {
  const shop = env.ctx.shop;
  const d = asObj(args['definition']);
  const ownerType = String(d['ownerType'] ?? '');
  const scope = DEFINITION_SCOPES[ownerType];
  if (!scope) return fail([{ field: ['definition', 'ownerType'], message: 'Owner type is not supported.', code: 'INVALID' }], { createdDefinition: null });
  env.ctx.requireAny([scope]);
  const namespace = String(d['namespace'] ?? '');
  const key = String(d['key'] ?? '');
  if (!d['name'] || !namespace || !key || !d['type']) return fail([{ field: ['definition'], message: 'name, namespace, key and type are required.', code: 'BLANK' }], { createdDefinition: null });
  if ([...shop.metafieldDefinitions.values()].some((x) => x.ownerType === ownerType && x.namespace === namespace && x.key === key)) {
    return fail([{ field: ['definition', 'key'], message: 'Key is in use for Order metafields on the \'' + namespace + '\' namespace.', code: 'TAKEN' }], { createdDefinition: null });
  }
  const def = { id: shop.nextId('MetafieldDefinition'), ownerType, namespace, key, type: String(d['type']), name: String(d['name']), description: d['description'] == null ? null : String(d['description']) };
  shop.metafieldDefinitions.set(def.id, def);
  return { payload: { __typename: 'Payload', createdDefinition: gqlMetafieldDefinition(def), userErrors: [] }, failed: false };
}

export const MUTATIONS: Record<string, (env: MutationEnv, args: Obj) => MutationResult> = {
  metafieldDefinitionCreate,
  inventoryAdjustQuantities,
  inventorySetQuantities,
  inventoryMoveQuantities,
  inventoryActivate,
  inventoryItemUpdate,
  metafieldsSet,
  metafieldsDelete,
  fulfillmentOrderHold,
  fulfillmentOrderReleaseHold,
  bulkOperationRunQuery,
  bulkOperationCancel,
};

/** Mutations that must carry `@idempotent` (spec 12.4, API 2026-04). */
export const IDEMPOTENT_REQUIRED = new Set(['inventoryAdjustQuantities', 'inventorySetQuantities', 'inventoryMoveQuantities', 'inventoryActivate']);
/** Mutations that change stock quantities (target of `staleChange` faults). */
export const STOCK_MUTATIONS = new Set(['inventoryAdjustQuantities', 'inventorySetQuantities', 'inventoryMoveQuantities']);

const GROUP_NULL = { inventoryAdjustmentGroup: null };
/** Payload skeleton (all fields null) per mutation, used for injected user errors. */
export const NULL_PAYLOAD: Record<string, Obj> = {
  inventoryAdjustQuantities: GROUP_NULL,
  inventorySetQuantities: GROUP_NULL,
  inventoryMoveQuantities: GROUP_NULL,
  inventoryActivate: { inventoryLevel: null },
  inventoryItemUpdate: { inventoryItem: null },
  metafieldsSet: { metafields: [] },
  metafieldsDelete: { deletedMetafields: [] },
  metafieldDefinitionCreate: { createdDefinition: null },
  fulfillmentOrderHold: { fulfillmentHold: null, fulfillmentOrder: null, remainingFulfillmentOrder: null },
  fulfillmentOrderReleaseHold: { fulfillmentOrder: null },
  bulkOperationRunQuery: { bulkOperation: null },
  bulkOperationCancel: { bulkOperation: null },
};

export function userErrorResult(mutation: string, error: UserError): MutationResult {
  return fail([error], NULL_PAYLOAD[mutation] ?? {});
}
