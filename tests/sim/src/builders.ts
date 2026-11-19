import type {
  Fulfillment,
  FulfillmentOrder,
  InventoryItem,
  InventoryLevel,
  LineItem,
  Location,
  Metafield,
  Order,
  Product,
  Refund,
  Return,
  Variant,
} from './model.js';
import { ON_HAND_COMPONENTS } from './model.js';
import type { Ctx } from './engine.js';
import { SimFieldError, AccessDenied, connection, matchQuery } from './engine.js';
import { displayFulfillmentStatus, unfulfilledQuantity } from './payloads.js';
import { numericId } from './util.js';

type Obj = Record<string, unknown>;

const FO_SCOPES = ['read_merchant_managed_fulfillment_orders', 'read_third_party_fulfillment_orders'];
const SIXTY_DAYS = 60 * 24 * 3600 * 1000;

export function orderVisible(ctx: Ctx, order: Order): boolean {
  if (ctx.scopes.has('read_all_orders')) return true;
  return Date.parse(order.createdAt) >= ctx.shop.clock.now() - SIXTY_DAYS;
}

function requireOrders(ctx: Ctx): void {
  ctx.requireAny(['read_orders', 'read_all_orders']);
}

function metafieldNode(m: Metafield): Obj {
  return { __typename: 'Metafield', id: m.id, namespace: m.namespace, key: m.key, type: m.type, value: m.value, createdAt: m.createdAt, updatedAt: m.updatedAt };
}

function metafieldFields(list: Metafield[]): Obj {
  return {
    metafield: (a: Obj) => {
      const m = list.find((x) => x.namespace === a['namespace'] && x.key === a['key']);
      return m ? metafieldNode(m) : null;
    },
    metafields: (a: Obj) =>
      connection('Metafield', 'metafields', list.filter((x) => a['namespace'] === undefined || a['namespace'] === null || x.namespace === a['namespace']).map(metafieldNode), a),
  };
}

export function gqlLocation(ctx: Ctx, l: Location): Obj {
  return {
    __typename: 'Location',
    id: l.id,
    name: l.name,
    isActive: l.isActive,
    createdAt: l.createdAt,
    legacyResourceId: String(numericId(l.id)),
  };
}

export function locationNode(ctx: Ctx, id: string | null): Obj | null {
  if (!id) return null;
  const l = ctx.shop.locations.get(id);
  return l ? gqlLocation(ctx, l) : null;
}

export function gqlLevel(ctx: Ctx, lv: InventoryLevel): Obj {
  return {
    __typename: 'InventoryLevel',
    id: lv.id,
    isActive: lv.isActive,
    updatedAt: lv.updatedAt,
    canDeactivate: true,
    location: () => ctx.requireAny(['read_locations', 'read_inventory']) ?? locationNode(ctx, lv.locationId),
    item: () => gqlItem(ctx, ctx.shop.items.get(lv.itemId) as InventoryItem),
    quantities: (a: Obj) => {
      const names = a['names'];
      if (!Array.isArray(names)) throw new SimFieldError("Field 'quantities' is missing required arguments: names", 'missingRequiredArguments');
      return names.map((n) => {
        if (n !== 'on_hand' && !(n in lv.q)) throw new SimFieldError(`Invalid inventory quantity name '${String(n)}'`, 'INVALID_QUANTITY_NAME');
        const q = n === 'on_hand' ? ON_HAND_COMPONENTS.reduce((s, c) => s + lv.q[c], 0) : lv.q[n as keyof typeof lv.q];
        return { __typename: 'InventoryQuantity', name: n, quantity: q, updatedAt: lv.updatedAt };
      });
    },
  };
}

export function gqlItem(ctx: Ctx, it: InventoryItem): Obj {
  return {
    __typename: 'InventoryItem',
    id: it.id,
    sku: it.sku,
    tracked: it.tracked,
    legacyResourceId: String(numericId(it.id)),
    variant: () => {
      ctx.requireAny(['read_products']);
      const v = ctx.shop.variants.get(it.variantId);
      return v ? gqlVariant(ctx, v) : null;
    },
    inventoryLevels: (a: Obj) => {
      ctx.requireAny(['read_inventory']);
      const items = ctx.shop.levelsOfItem(it.id).filter((l) => matchQuery(a['query'], { location_id: () => numericId(l.locationId) }));
      return connection('InventoryLevel', 'inventoryLevels', items.map((l) => gqlLevel(ctx, l)), a);
    },
    inventoryLevel: (a: Obj) => {
      ctx.requireAny(['read_inventory']);
      const l = ctx.shop.getLevel(it.id, String(a['locationId']));
      return l ? gqlLevel(ctx, l) : null;
    },
  };
}

export function gqlVariant(ctx: Ctx, v: Variant): Obj {
  return {
    __typename: 'ProductVariant',
    id: v.id,
    title: v.title,
    sku: v.sku,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    legacyResourceId: String(numericId(v.id)),
    product: () => {
      const p = ctx.shop.products.get(v.productId);
      return p ? gqlProduct(ctx, p) : null;
    },
    inventoryItem: () => gqlItem(ctx, ctx.shop.items.get(v.inventoryItemId) as InventoryItem),
    inventoryQuantity: () =>
      ctx.shop.levelsOfItem(v.inventoryItemId).reduce((s, l) => s + l.q.available, 0),
    ...metafieldFields(v.metafields),
  };
}

export function gqlProduct(ctx: Ctx, p: Product): Obj {
  return {
    __typename: 'Product',
    id: p.id,
    title: p.title,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    legacyResourceId: String(numericId(p.id)),
    variants: (a: Obj) => connection('ProductVariant', 'variants', p.variantIds.flatMap((id) => { const v = ctx.shop.variants.get(id); return v ? [gqlVariant(ctx, v)] : []; }), a),
  };
}

function gqlLine(ctx: Ctx, l: LineItem): Obj {
  return {
    __typename: 'LineItem',
    id: l.id,
    title: l.title,
    quantity: l.quantity,
    currentQuantity: l.currentQuantity,
    unfulfilledQuantity: unfulfilledQuantity(l),
    fulfillableQuantity: unfulfilledQuantity(l),
    nonFulfillableQuantity: Math.max(0, l.quantity - l.currentQuantity),
    refundableQuantity: l.currentQuantity,
    customAttributes: l.customAttributes.map((a) => ({ __typename: 'Attribute', key: a.key, value: a.value })),
    variant: () => {
      const v = l.variantId ? ctx.shop.variants.get(l.variantId) : undefined;
      return v ? gqlVariant(ctx, v) : null;
    },
    product: () => {
      const v = l.variantId ? ctx.shop.variants.get(l.variantId) : undefined;
      const p = v ? ctx.shop.products.get(v.productId) : undefined;
      return p ? gqlProduct(ctx, p) : null;
    },
  };
}

function lineById(ctx: Ctx, orderId: string, lineItemId: string): Obj | null {
  const l = ctx.shop.orders.get(orderId)?.lines.find((x) => x.id === lineItemId);
  return l ? gqlLine(ctx, l) : null;
}

export function gqlFulfillmentOrder(ctx: Ctx, fo: FulfillmentOrder): Obj {
  return {
    __typename: 'FulfillmentOrder',
    id: fo.id,
    status: fo.status,
    requestStatus: 'UNSUBMITTED',
    fulfillAt: fo.fulfillAt,
    createdAt: fo.createdAt,
    updatedAt: fo.updatedAt,
    order: () => {
      requireOrders(ctx);
      return { __typename: 'Order', id: fo.orderId };
    },
    assignedLocation: () => {
      ctx.requireAny(FO_SCOPES);
      const loc = ctx.shop.locations.get(fo.locationId);
      return { __typename: 'FulfillmentOrderAssignedLocation', name: loc?.name ?? null, location: locationNode(ctx, fo.locationId) };
    },
    fulfillmentHolds: fo.holds.map((h) => ({ __typename: 'FulfillmentHold', id: h.id, handle: h.handle, reason: h.reason, reasonNotes: h.reasonNotes, heldByRequestingApp: true })),
    lineItems: (a: Obj) =>
      connection(
        'FulfillmentOrderLineItem',
        'lineItems',
        fo.lines.map((l) => ({
          __typename: 'FulfillmentOrderLineItem',
          id: l.id,
          totalQuantity: l.totalQuantity,
          remainingQuantity: l.remainingQuantity,
          lineItem: () => lineById(ctx, fo.orderId, l.lineItemId),
        })),
        a,
      ),
  };
}

function gqlFulfillment(ctx: Ctx, f: Fulfillment): Obj {
  return {
    __typename: 'Fulfillment',
    id: f.id,
    status: f.status,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    location: () => locationNode(ctx, f.locationId),
    fulfillmentLineItems: (a: Obj) =>
      connection(
        'FulfillmentLineItem',
        'fulfillmentLineItems',
        f.lines.map((l) => ({ __typename: 'FulfillmentLineItem', id: `${f.id}/${numericId(l.lineItemId)}`, quantity: l.quantity, lineItem: () => lineById(ctx, f.orderId, l.lineItemId) })),
        a,
      ),
  };
}

function gqlRefund(ctx: Ctx, r: Refund): Obj {
  return {
    __typename: 'Refund',
    id: r.id,
    createdAt: r.createdAt,
    refundLineItems: (a: Obj) =>
      connection(
        'RefundLineItem',
        'refundLineItems',
        r.lines.map((l) => ({ __typename: 'RefundLineItem', id: l.id, quantity: l.quantity, restockType: l.restockType, location: () => locationNode(ctx, l.locationId), lineItem: () => lineById(ctx, r.orderId, l.lineItemId) })),
        a,
      ),
  };
}

export function gqlReturn(ctx: Ctx, r: Return): Obj {
  const fulfillmentLineItem = (lineItemId: string, quantity: number): Obj => ({ __typename: 'FulfillmentLineItem', id: `gid://shopify/FulfillmentLineItem/${numericId(lineItemId)}`, quantity, lineItem: () => lineById(ctx, r.orderId, lineItemId) });
  return {
    __typename: 'Return',
    id: r.id,
    name: r.name,
    status: r.status,
    createdAt: r.createdAt,
    order: () => ({ __typename: 'Order', id: r.orderId }),
    returnLineItems: (a: Obj) =>
      connection(
        'ReturnLineItem',
        'returnLineItems',
        r.lines.map((l) => ({
          __typename: 'ReturnLineItem',
          id: l.id,
          quantity: l.quantity,
          returnReason: l.returnReason,
          processedQuantity: l.processedQuantity,
          unprocessedQuantity: l.quantity - l.processedQuantity,
          processableQuantity: l.quantity - l.processedQuantity,
          fulfillmentLineItem: () => fulfillmentLineItem(l.lineItemId, l.quantity),
        })),
        a,
      ),
    reverseFulfillmentOrders: (a: Obj) =>
      connection(
        'ReverseFulfillmentOrder',
        'reverseFulfillmentOrders',
        r.reverseFulfillmentOrders.map((o) => gqlReverseFulfillmentOrder(ctx, r, o)),
        a,
      ),
  };
}

export function gqlReverseFulfillmentOrder(ctx: Ctx, r: Return, o: Return['reverseFulfillmentOrders'][number]): Obj {
  const fulfillmentLineItem = (lineItemId: string, quantity: number): Obj => ({ __typename: 'FulfillmentLineItem', id: `gid://shopify/FulfillmentLineItem/${numericId(lineItemId)}`, quantity, lineItem: () => lineById(ctx, r.orderId, lineItemId) });
  return {
    __typename: 'ReverseFulfillmentOrder',
    id: o.id,
    status: o.status,
    order: () => ({ __typename: 'Order', id: r.orderId }),
    lineItems: (b: Obj) =>
      connection(
        'ReverseFulfillmentOrderLineItem',
        'lineItems',
        o.lines.map((l) => ({
          __typename: 'ReverseFulfillmentOrderLineItem',
          id: l.id,
          totalQuantity: l.totalQuantity,
          dispositions: l.dispositions.map((d) => ({ __typename: 'ReverseFulfillmentOrderDisposition', type: d.type, quantity: d.quantity, location: () => locationNode(ctx, d.locationId) })),
          fulfillmentLineItem: () => (l.unlinked ? null : fulfillmentLineItem(l.lineItemId, l.totalQuantity)),
        })),
        b,
      ),
  };
}

export function gqlOrder(ctx: Ctx, o: Order): Obj {
  const { shop } = ctx;
  return {
    __typename: 'Order',
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    cancelledAt: o.cancelledAt,
    cancelReason: o.cancelReason,
    closedAt: o.closedAt,
    test: o.test,
    sourceName: o.sourceName,
    displayFulfillmentStatus: displayFulfillmentStatus(o),
    displayFinancialStatus: 'PAID',
    legacyResourceId: String(numericId(o.id)),
    retailLocation: () => locationNode(ctx, o.retailLocationId),
    customAttributes: [],
    lineItems: (a: Obj) => connection('LineItem', 'lineItems', o.lines.map((l) => gqlLine(ctx, l)), a),
    fulfillmentOrders: (a: Obj) => {
      ctx.requireAny(FO_SCOPES);
      return connection('FulfillmentOrder', 'fulfillmentOrders', shop.fulfillmentOrdersOf(o.id).map((f) => gqlFulfillmentOrder(ctx, f)), a);
    },
    fulfillments: (a: Obj) => {
      ctx.requireAny(['read_fulfillments', 'read_orders', 'read_all_orders']);
      const list = shop.fulfillmentsOf(o.id).map((f) => gqlFulfillment(ctx, f));
      return typeof a['first'] === 'number' ? list.slice(0, a['first']) : list;
    },
    refunds: shop.refundsOf(o.id).map((r) => gqlRefund(ctx, r)),
    returns: (a: Obj) => {
      ctx.requireAny(['read_returns']);
      return connection('Return', 'returns', shop.returnsOf(o.id).map((r) => gqlReturn(ctx, r)), a);
    },
    ...metafieldFields(o.metafields),
  };
}

/** Resolves any gid handled by `node` / `nodes`. */
export function nodeById(ctx: Ctx, id: string): Obj | null {
  const { shop } = ctx;
  const type = /^gid:\/\/shopify\/([A-Za-z]+)\//.exec(id)?.[1];
  switch (type) {
    case 'Order': {
      requireOrdersOrThrow(ctx);
      const o = shop.orders.get(id);
      return o && orderVisible(ctx, o) ? gqlOrder(ctx, o) : null;
    }
    case 'ProductVariant': {
      ctx.requireAny(['read_products']);
      const v = shop.variants.get(id);
      return v ? gqlVariant(ctx, v) : null;
    }
    case 'Product': {
      ctx.requireAny(['read_products']);
      const p = shop.products.get(id);
      return p ? gqlProduct(ctx, p) : null;
    }
    case 'InventoryItem': {
      ctx.requireAny(['read_inventory']);
      const i = shop.items.get(id);
      return i ? gqlItem(ctx, i) : null;
    }
    case 'InventoryLevel': {
      ctx.requireAny(['read_inventory']);
      const l = [...shop.levels.values()].find((x) => x.id === id);
      return l ? gqlLevel(ctx, l) : null;
    }
    case 'Location': {
      ctx.requireAny(['read_locations']);
      return locationNode(ctx, id);
    }
    case 'FulfillmentOrder': {
      ctx.requireAny(FO_SCOPES);
      const f = shop.fulfillmentOrders.get(id);
      return f ? gqlFulfillmentOrder(ctx, f) : null;
    }
    case 'Return': {
      ctx.requireAny(['read_returns']);
      const r = shop.returns.get(id);
      return r ? gqlReturn(ctx, r) : null;
    }
    case 'ReverseFulfillmentOrder': {
      ctx.requireAny(['read_returns']);
      for (const r of shop.returns.values()) {
        const o = r.reverseFulfillmentOrders.find((x) => x.id === id);
        if (o) return gqlReverseFulfillmentOrder(ctx, r, o);
      }
      return null;
    }
    default:
      return null;
  }
}

function requireOrdersOrThrow(ctx: Ctx): void {
  if (!ctx.scopes.has('read_orders') && !ctx.scopes.has('read_all_orders')) throw new AccessDenied(['read_orders']);
}

/** Query root (field -> resolver). */
export function queryRoot(ctx: Ctx): Obj {
  const { shop } = ctx;
  return {
    __typename: 'QueryRoot',
    order: (a: Obj) => nodeByTyped(ctx, String(a['id']), 'Order'),
    orders: (a: Obj) => {
      requireOrdersOrThrow(ctx);
      let list = [...shop.orders.values()].filter((o) => orderVisible(ctx, o));
      list = list.filter((o) =>
        matchQuery(a['query'], {
          updated_at: () => o.updatedAt,
          created_at: () => o.createdAt,
          name: () => o.name,
          id: () => numericId(o.id),
          status: () => (o.cancelledAt ? 'cancelled' : 'open'),
          source_name: () => o.sourceName,
        }),
      );
      const key = a['sortKey'] === 'UPDATED_AT' ? 'updatedAt' : 'createdAt';
      list.sort((x, y) => (x[key] < y[key] ? -1 : x[key] > y[key] ? 1 : 0));
      if (a['reverse'] === true) list.reverse();
      return connection('Order', 'orders', list.map((o) => gqlOrder(ctx, o)), a);
    },
    node: (a: Obj) => nodeById(ctx, String(a['id'])),
    nodes: (a: Obj) => {
      const ids = a['ids'];
      if (!Array.isArray(ids)) throw new SimFieldError("Field 'nodes' is missing required arguments: ids", 'missingRequiredArguments');
      if (ids.length > 250) throw new SimFieldError('Maximum of 250 ids per nodes query', 'BAD_REQUEST');
      return ids.map((i) => nodeById(ctx, String(i)));
    },
    inventoryItem: (a: Obj) => nodeByTyped(ctx, String(a['id']), 'InventoryItem'),
    inventoryItems: (a: Obj) => {
      ctx.requireAny(['read_inventory']);
      const list = [...shop.items.values()].filter((i) => matchQuery(a['query'], { sku: () => i.sku, id: () => numericId(i.id), tracked: () => String(i.tracked) }));
      return connection('InventoryItem', 'inventoryItems', list.map((i) => gqlItem(ctx, i)), a);
    },
    inventoryLevel: (a: Obj) => nodeByTyped(ctx, String(a['id']), 'InventoryLevel'),
    productVariant: (a: Obj) => nodeByTyped(ctx, String(a['id']), 'ProductVariant'),
    productVariants: (a: Obj) => {
      ctx.requireAny(['read_products']);
      const list = [...shop.variants.values()].filter((v) => matchQuery(a['query'], { sku: () => v.sku, id: () => numericId(v.id), product_id: () => numericId(v.productId), updated_at: () => v.updatedAt }));
      return connection('ProductVariant', 'productVariants', list.map((v) => gqlVariant(ctx, v)), a);
    },
    product: (a: Obj) => nodeByTyped(ctx, String(a['id']), 'Product'),
    products: (a: Obj) => {
      ctx.requireAny(['read_products']);
      const list = [...shop.products.values()].filter((p) => matchQuery(a['query'], { id: () => numericId(p.id), title: () => p.title, updated_at: () => p.updatedAt }));
      return connection('Product', 'products', list.map((p) => gqlProduct(ctx, p)), a);
    },
    location: (a: Obj) => nodeByTyped(ctx, String(a['id']), 'Location'),
    locations: (a: Obj) => {
      ctx.requireAny(['read_locations']);
      const list = [...shop.locations.values()].filter((l) => a['includeInactive'] === true || l.isActive);
      return connection('Location', 'locations', list.map((l) => gqlLocation(ctx, l)), a);
    },
    fulfillmentOrder: (a: Obj) => nodeByTyped(ctx, String(a['id']), 'FulfillmentOrder'),
    return: (a: Obj) => nodeByTyped(ctx, String(a['id']), 'Return'),
    reverseFulfillmentOrder: (a: Obj) => nodeByTyped(ctx, String(a['id']), 'ReverseFulfillmentOrder'),
    metafieldDefinitions: (a: Obj) => {
      const list = [...shop.metafieldDefinitions.values()].filter(
        (d) => d.ownerType === a['ownerType'] && (a['namespace'] === undefined || d.namespace === a['namespace']) && (a['key'] === undefined || d.key === a['key']),
      );
      return connection('MetafieldDefinition', 'metafieldDefinitions', list.map(gqlMetafieldDefinition), a);
    },
    shop: { __typename: 'Shop', id: 'gid://shopify/Shop/1', name: 'Sim Shop', myshopifyDomain: shop.domain },
    currentAppInstallation: {
      __typename: 'AppInstallation',
      id: 'gid://shopify/AppInstallation/1',
      accessScopes: shop.scopes.map((h) => ({ __typename: 'AccessScope', handle: h })),
    },
    currentBulkOperation: () => {
      const all = [...shop.bulkOperations.values()];
      const last = all[all.length - 1];
      return last ? gqlBulk(last) : null;
    },
    bulkOperation: (a: Obj) => {
      const b = shop.bulkOperations.get(String(a['id']));
      return b ? gqlBulk(b) : null;
    },
  };
}

function nodeByTyped(ctx: Ctx, id: string, type: string): Obj | null {
  if (!id.startsWith(`gid://shopify/${type}/`)) {
    throw new SimFieldError(`Invalid global id '${id}'`, 'INVALID_GLOBAL_ID');
  }
  return nodeById(ctx, id);
}

export function gqlBulk(b: import('./model.js').BulkOperation): Obj {
  return { __typename: 'BulkOperation', id: b.id, status: b.status, type: b.type, query: b.query, createdAt: b.createdAt, completedAt: b.completedAt, url: b.url, objectCount: String(b.objectCount), errorCode: null };
}

export function gqlMetafieldDefinition(d: import('./model.js').MetafieldDefinition): Obj {
  return { __typename: 'MetafieldDefinition', id: d.id, ownerType: d.ownerType, namespace: d.namespace, key: d.key, name: d.name, description: d.description, type: { __typename: 'MetafieldDefinitionType', name: d.type } };
}
