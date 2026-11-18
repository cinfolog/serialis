/**
 * Shopify reads of the domain (spec 12.3 step 1, 13.3). Every query asks for identifiers,
 * quantities and statuses only: no customer data (P8).
 */
import type {
  DispositionType,
  FulfillmentOrderStatus,
  FulfillmentStatus,
  OrderChannel,
  OrderSnapshot,
  RestockType,
  ReturnStatus,
} from '@serialis/core';
import type { AdminGraphqlClient } from '@serialis/shopify';
import { toMillis } from './util.js';

/**
 * One query for the whole order (12.3 step 1). Page sizes keep the requested cost under 800 points
 * (single query ceiling 1 000): 50 lines, 5 fulfillment orders of 15 lines, 5 fulfillments, 3 returns.
 * A truncated page makes the read fail (`order_too_large`) rather than plan on partial data.
 */
export const ORDER_QUERY = `query SerialisOrder($id: ID!) {
  order(id: $id) {
    id name createdAt updatedAt cancelledAt test sourceName
    retailLocation { id }
    metafield(namespace: "serialis", key: "units") { value }
    lineItems(first: 50) { pageInfo { hasNextPage } nodes { id title quantity currentQuantity variant { id } customAttributes { key value } } }
    fulfillmentOrders(first: 5) {
      pageInfo { hasNextPage }
      nodes {
        id status
        assignedLocation { location { id } }
        lineItems(first: 15) { pageInfo { hasNextPage } nodes { id totalQuantity remainingQuantity lineItem { id } } }
      }
    }
    fulfillments(first: 5) {
      id status createdAt
      location { id }
      fulfillmentLineItems(first: 15) { nodes { quantity lineItem { id } } }
    }
    refunds {
      id createdAt
      refundLineItems(first: 15) { nodes { quantity restockType location { id } lineItem { id } } }
    }
    returns(first: 3) {
      nodes {
        id status
        returnLineItems(first: 5) { nodes { id quantity ... on ReturnLineItem { fulfillmentLineItem { lineItem { id } } } } }
        reverseFulfillmentOrders(first: 2) {
          nodes { lineItems(first: 5) { nodes { dispositions { type quantity location { id } } fulfillmentLineItem { lineItem { id } } } } }
        }
      }
    }
  }
}`;

type Id = { id: string } | null;
type Conn<T> = { pageInfo?: { hasNextPage: boolean }; nodes: T[] };

interface OrderData {
  order: null | {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    cancelledAt: string | null;
    test: boolean;
    sourceName: string | null;
    retailLocation: Id;
    metafield: { value: string } | null;
    lineItems: Conn<{ id: string; title: string; quantity: number; currentQuantity: number; variant: Id; customAttributes: { key: string; value: string | null }[] }>;
    fulfillmentOrders: Conn<{
      id: string;
      status: string;
      assignedLocation: { location: Id } | null;
      lineItems: Conn<{ id: string; totalQuantity: number; remainingQuantity: number; lineItem: Id }>;
    }>;
    fulfillments: { id: string; status: string; createdAt: string; location: Id; fulfillmentLineItems: Conn<{ quantity: number; lineItem: Id }> }[];
    refunds: { id: string; createdAt: string; refundLineItems: Conn<{ quantity: number; restockType: string; location: Id; lineItem: Id }> }[];
    returns: Conn<{
      id: string;
      status: string;
      returnLineItems: Conn<{ id: string; quantity: number; fulfillmentLineItem?: { lineItem: Id } | null }>;
      reverseFulfillmentOrders: Conn<{
        lineItems: Conn<{ dispositions: { type: string; quantity: number; location: Id }[] | null; fulfillmentLineItem: { lineItem: Id } | null }>;
      }>;
    }>;
  };
}

export interface OrderRead {
  snapshot: OrderSnapshot;
  /** Titles and quantities of the lines, for display (no customer data). */
  lines: { gid: string; title: string; variantGid: string | null; quantity: number; currentQuantity: number }[];
  returnLines: { gid: string; returnGid: string; lineItemGid: string; quantity: number }[];
  fulfillmentOrders: { gid: string; locationId: string; status: string }[];
}

export class OrderTooLargeError extends Error {
  override readonly name = 'OrderTooLargeError';
}

function channelOf(sourceName: string | null): OrderChannel {
  switch (sourceName) {
    case 'web':
    case 'shopify_draft_order':
      return sourceName === 'web' ? 'online_store' : 'draft_order';
    case 'pos':
      return 'pos';
    case null:
    case undefined:
      return 'other';
    default:
      return /^\d+$/.test(sourceName) ? 'marketplace' : 'other';
  }
}

/** Reads the order and maps it to core's `OrderSnapshot` (locations: GID = `LocationId`, D-21). Null when Shopify has no such order. */
export async function readOrder(client: AdminGraphqlClient, orderGid: string, edits: OrderSnapshot['edits']): Promise<OrderRead | null> {
  const { data } = await client.request<OrderData>(ORDER_QUERY, { variables: { id: orderGid }, estimatedCost: 120 });
  const o = data.order;
  if (!o) return null;
  const truncated =
    o.lineItems.pageInfo?.hasNextPage ||
    o.fulfillmentOrders.pageInfo?.hasNextPage ||
    o.fulfillmentOrders.nodes.some((fo) => fo.lineItems.pageInfo?.hasNextPage);
  if (truncated) throw new OrderTooLargeError(`order ${orderGid} exceeds the page sizes of the sync query`);

  const fos = o.fulfillmentOrders.nodes
    .filter((fo) => fo.assignedLocation?.location?.id)
    .map((fo) => ({
      gid: fo.id,
      status: fo.status as FulfillmentOrderStatus,
      locationId: fo.assignedLocation!.location!.id,
      lineItems: fo.lineItems.nodes
        .filter((l) => l.lineItem)
        .map((l) => ({ gid: l.id, lineItemGid: l.lineItem!.id, totalQuantity: l.totalQuantity, remainingQuantity: l.remainingQuantity })),
    }));

  const returnLines: OrderRead['returnLines'] = [];
  const returns = o.returns.nodes.map((r) => {
    const lineItems = r.returnLineItems.nodes
      .filter((l) => l.fulfillmentLineItem?.lineItem)
      .map((l) => ({ gid: l.id, lineItemGid: l.fulfillmentLineItem!.lineItem!.id, quantity: l.quantity }));
    for (const l of lineItems) returnLines.push({ gid: l.gid, returnGid: r.id, lineItemGid: l.lineItemGid, quantity: l.quantity });
    // Reverse fulfillment order lines point to the order line; the return line is found through it.
    const dispositions: OrderSnapshot['returns'][number]['dispositions'][number][] = [];
    for (const rfo of r.reverseFulfillmentOrders.nodes) {
      for (const rl of rfo.lineItems.nodes) {
        const lineItemGid = rl.fulfillmentLineItem?.lineItem?.id;
        const target = lineItems.find((l) => l.lineItemGid === lineItemGid);
        if (!target) continue;
        for (const d of rl.dispositions ?? []) {
          if (!d.location?.id) continue;
          dispositions.push({ returnLineItemGid: target.gid, type: d.type as DispositionType, quantity: d.quantity, locationId: d.location.id });
        }
      }
    }
    return { gid: r.id, status: r.status as ReturnStatus, lineItems, dispositions };
  });

  const snapshot: OrderSnapshot = {
    orderGid: o.id,
    name: o.name,
    createdAt: toMillis(o.createdAt) ?? 0,
    updatedAt: toMillis(o.updatedAt) ?? 0,
    cancelledAt: toMillis(o.cancelledAt),
    test: o.test,
    channel: channelOf(o.sourceName),
    retailLocationId: o.retailLocation?.id ?? null,
    metafieldValue: o.metafield?.value ?? null,
    lineItems: o.lineItems.nodes.map((l) => ({
      gid: l.id,
      variantGid: l.variant?.id ?? null,
      quantity: l.quantity,
      currentQuantity: l.currentQuantity,
      serialisUnitsProperty: l.customAttributes.find((a) => a.key === '_serialis_units')?.value ?? null,
    })),
    fulfillmentOrders: fos,
    fulfillments: o.fulfillments
      .filter((f) => f.location?.id)
      .map((f) => ({
        gid: f.id,
        status: f.status as FulfillmentStatus,
        locationId: f.location!.id,
        createdAt: toMillis(f.createdAt) ?? 0,
        lineItems: f.fulfillmentLineItems.nodes.filter((l) => l.lineItem).map((l) => ({ lineItemGid: l.lineItem!.id, quantity: l.quantity })),
      })),
    refunds: o.refunds.map((r) => ({
      gid: r.id,
      createdAt: toMillis(r.createdAt) ?? 0,
      lineItems: r.refundLineItems.nodes
        .filter((l) => l.lineItem)
        .map((l) => ({ lineItemGid: l.lineItem!.id, quantity: l.quantity, restockType: l.restockType as RestockType, locationId: l.location?.id ?? null })),
    })),
    edits,
    returns,
  };
  return {
    snapshot,
    lines: o.lineItems.nodes.map((l) => ({ gid: l.id, title: l.title, variantGid: l.variant?.id ?? null, quantity: l.quantity, currentQuantity: l.currentQuantity })),
    returnLines,
    fulfillmentOrders: fos.map((fo) => ({ gid: fo.gid, locationId: fo.locationId, status: fo.status })),
  };
}

// -------------------------------------------------------------------------------------------- levels

export const QUANTITY_NAMES = ['available', 'committed', 'reserved', 'damaged', 'quality_control', 'safety_stock', 'on_hand'] as const;
export type LevelQuantities = Record<(typeof QUANTITY_NAMES)[number], number>;

export interface LevelRead {
  /** False when the item has no level at the location, or an inactive one (2026-04, spec 8). */
  active: boolean;
  exists: boolean;
  tracked: boolean;
  q: LevelQuantities;
}

const LEVEL_QUERY = `query SerialisLevel($item: ID!, $location: ID!) {
  inventoryItem(id: $item) {
    id tracked
    inventoryLevel(locationId: $location) { isActive quantities(names: ["available", "committed", "reserved", "damaged", "quality_control", "safety_stock", "on_hand"]) { name quantity } }
  }
}`;

function quantities(list: { name: string; quantity: number }[] | undefined): LevelQuantities {
  const q = Object.fromEntries(QUANTITY_NAMES.map((n) => [n, 0])) as LevelQuantities;
  for (const e of list ?? []) if ((QUANTITY_NAMES as readonly string[]).includes(e.name)) q[e.name as keyof LevelQuantities] = e.quantity;
  return q;
}

/** Reads one inventory level (spec 12.4 "relit le niveau"). */
export async function readLevel(client: AdminGraphqlClient, inventoryItemGid: string, locationGid: string): Promise<LevelRead | null> {
  const { data } = await client.request<{
    inventoryItem: null | { tracked: boolean; inventoryLevel: null | { isActive: boolean; quantities: { name: string; quantity: number }[] } };
  }>(LEVEL_QUERY, { variables: { item: inventoryItemGid, location: locationGid }, estimatedCost: 5 });
  if (!data.inventoryItem) return null;
  const lv = data.inventoryItem.inventoryLevel;
  return { exists: lv !== null, active: lv?.isActive ?? false, tracked: data.inventoryItem.tracked, q: quantities(lv?.quantities) };
}

// -------------------------------------------------------------------------------------------- variants

const VARIANTS_QUERY = `query SerialisVariants($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id title sku
      product { id title }
      inventoryItem {
        id tracked
        inventoryLevels(first: 20) { nodes { isActive location { id name isActive } quantities(names: ["available", "committed", "reserved", "damaged", "quality_control", "safety_stock", "on_hand"]) { name quantity } } }
      }
    }
  }
}`;

export interface VariantRead {
  variantGid: string;
  title: string | null;
  sku: string | null;
  productGid: string;
  productTitle: string;
  inventoryItemGid: string;
  tracked: boolean;
  levels: { locationId: string; locationName: string; locationActive: boolean; active: boolean; q: LevelQuantities }[];
}

export async function readVariants(client: AdminGraphqlClient, variantGids: readonly string[]): Promise<Map<string, VariantRead>> {
  const out = new Map<string, VariantRead>();
  for (let i = 0; i < variantGids.length; i += 25) {
    const ids = variantGids.slice(i, i + 25);
    const { data } = await client.request<{
      nodes: Array<null | {
        id?: string;
        title: string;
        sku: string | null;
        product: { id: string; title: string };
        inventoryItem: { id: string; tracked: boolean; inventoryLevels: Conn<{ isActive: boolean; location: { id: string; name: string; isActive: boolean }; quantities: { name: string; quantity: number }[] }> };
      }>;
    }>(VARIANTS_QUERY, { variables: { ids }, estimatedCost: 60 });
    for (const n of data.nodes) {
      if (!n?.id) continue;
      out.set(n.id, {
        variantGid: n.id,
        title: n.title ?? null,
        sku: n.sku ?? null,
        productGid: n.product.id,
        productTitle: n.product.title,
        inventoryItemGid: n.inventoryItem.id,
        tracked: n.inventoryItem.tracked,
        levels: n.inventoryItem.inventoryLevels.nodes.map((l) => ({
          locationId: l.location.id,
          locationName: l.location.name,
          locationActive: l.location.isActive,
          active: l.isActive,
          q: quantities(l.quantities),
        })),
      });
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------- order lists

const ORDERS_QUERY = `query SerialisOrders($after: String, $query: String!) {
  orders(first: 25, after: $after, sortKey: UPDATED_AT, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes { id createdAt updatedAt lineItems(first: 10) { nodes { id variant { id } } } }
  }
}`;

export interface OrderListItem {
  orderGid: string;
  createdAt: number;
  updatedAt: number;
  lines: { gid: string; variantGid: string | null }[];
}

/** Orders matching a search (`status:open`, `updated_at:>=…`), page by page (R1, activation of tracking). */
export async function listOrders(client: AdminGraphqlClient, query: string, maxPages = 20): Promise<{ orders: OrderListItem[]; complete: boolean }> {
  const orders: OrderListItem[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const resp: { data: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string; createdAt: string; updatedAt: string; lineItems: Conn<{ id: string; variant: Id }> }[] } } } =
      await client.request(ORDERS_QUERY, { variables: { after, query }, estimatedCost: 60 });
    for (const n of resp.data.orders.nodes) {
      orders.push({
        orderGid: n.id,
        createdAt: toMillis(n.createdAt) ?? 0,
        updatedAt: toMillis(n.updatedAt) ?? 0,
        lines: n.lineItems.nodes.map((l) => ({ gid: l.id, variantGid: l.variant?.id ?? null })),
      });
    }
    if (!resp.data.orders.pageInfo.hasNextPage) return { orders, complete: true };
    after = resp.data.orders.pageInfo.endCursor;
  }
  return { orders, complete: false };
}

// -------------------------------------------------------------------------------------------- locations

const LOCATIONS_QUERY = `query SerialisLocations($after: String) {
  locations(first: 100, after: $after, includeInactive: true) { pageInfo { hasNextPage endCursor } nodes { id name isActive } }
}`;

export async function readLocations(client: AdminGraphqlClient): Promise<{ id: string; name: string; isActive: boolean }[]> {
  const out: { id: string; name: string; isActive: boolean }[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const resp: { data: { locations: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string; name: string; isActive: boolean }[] } } } =
      await client.request(LOCATIONS_QUERY, { variables: { after }, estimatedCost: 20 });
    out.push(...resp.data.locations.nodes);
    if (!resp.data.locations.pageInfo.hasNextPage) break;
    after = resp.data.locations.pageInfo.endCursor;
  }
  return out;
}
