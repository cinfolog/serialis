import type { Fulfillment, FulfillmentOrder, Order, Refund, Return } from './model.js';
import type { Shop } from './shop.js';
import { numericId } from './util.js';

export type DisplayFulfillmentStatus = 'UNFULFILLED' | 'PARTIALLY_FULFILLED' | 'FULFILLED';

export function unfulfilledQuantity(line: { currentQuantity: number; fulfilledQuantity: number }): number {
  return Math.max(0, line.currentQuantity - line.fulfilledQuantity);
}

export function displayFulfillmentStatus(order: Order): DisplayFulfillmentStatus {
  const current = order.lines.reduce((s, l) => s + l.currentQuantity, 0);
  const fulfilled = order.lines.reduce((s, l) => s + Math.min(l.fulfilledQuantity, l.currentQuantity), 0);
  if (current > 0 && fulfilled >= current) return 'FULFILLED';
  if (fulfilled > 0) return 'PARTIALLY_FULFILLED';
  return 'UNFULFILLED';
}

/*
 * Webhook payloads are REST-style (snake_case, numeric ids plus `admin_graphql_api_id`). They carry the fields the
 * Serialis sync reads; extra Shopify fields are intentionally not reproduced.
 */

export function orderPayload(shop: Shop, order: Order): Record<string, unknown> {
  const status = displayFulfillmentStatus(order);
  return {
    id: numericId(order.id),
    admin_graphql_api_id: order.id,
    name: order.name,
    order_number: Number(order.name.replace(/\D/g, '')),
    created_at: order.createdAt,
    updated_at: order.updatedAt,
    cancelled_at: order.cancelledAt,
    cancel_reason: order.cancelReason?.toLowerCase() ?? null,
    closed_at: order.closedAt,
    test: order.test,
    source_name: order.sourceName,
    location_id: order.retailLocationId ? numericId(order.retailLocationId) : null,
    financial_status: 'paid',
    fulfillment_status: status === 'FULFILLED' ? 'fulfilled' : status === 'PARTIALLY_FULFILLED' ? 'partial' : null,
    line_items: order.lines.map((l) => ({
      id: numericId(l.id),
      admin_graphql_api_id: l.id,
      variant_id: l.variantId ? numericId(l.variantId) : null,
      title: l.title,
      quantity: l.quantity,
      current_quantity: l.currentQuantity,
      fulfillable_quantity: unfulfilledQuantity(l),
      fulfillment_status: l.fulfilledQuantity === 0 ? null : l.fulfilledQuantity >= l.currentQuantity ? 'fulfilled' : 'partial',
      properties: l.customAttributes.map((a) => ({ name: a.key, value: a.value })),
    })),
    shop_domain: shop.domain,
  };
}

export function fulfillmentOrderPayload(fo: FulfillmentOrder): Record<string, unknown> {
  return {
    id: numericId(fo.id),
    admin_graphql_api_id: fo.id,
    order_id: numericId(fo.orderId),
    assigned_location_id: numericId(fo.locationId),
    status: fo.status.toLowerCase(),
    request_status: 'unsubmitted',
    fulfill_at: fo.fulfillAt,
    fulfillment_holds: fo.holds.map((h) => ({ id: numericId(h.id), handle: h.handle, reason: h.reason.toLowerCase(), reason_notes: h.reasonNotes })),
    line_items: fo.lines.map((l) => ({
      id: numericId(l.id),
      fulfillment_order_id: numericId(fo.id),
      line_item_id: numericId(l.lineItemId),
      quantity: l.totalQuantity,
      fulfillable_quantity: l.remainingQuantity,
    })),
  };
}

export function fulfillmentPayload(f: Fulfillment): Record<string, unknown> {
  return {
    id: numericId(f.id),
    admin_graphql_api_id: f.id,
    order_id: numericId(f.orderId),
    fulfillment_order_id: numericId(f.fulfillmentOrderId),
    status: f.status.toLowerCase(),
    location_id: numericId(f.locationId),
    line_items: f.lines.map((l) => ({ id: numericId(l.lineItemId), quantity: l.quantity })),
    created_at: f.createdAt,
    updated_at: f.updatedAt,
  };
}

export function refundPayload(r: Refund): Record<string, unknown> {
  return {
    id: numericId(r.id),
    admin_graphql_api_id: r.id,
    order_id: numericId(r.orderId),
    created_at: r.createdAt,
    refund_line_items: r.lines.map((l) => ({
      id: numericId(l.id),
      line_item_id: numericId(l.lineItemId),
      quantity: l.quantity,
      restock_type: l.restockType.toLowerCase(),
      location_id: l.locationId ? numericId(l.locationId) : null,
    })),
  };
}

export function returnPayload(r: Return): Record<string, unknown> {
  return {
    admin_graphql_api_id: r.id,
    id: numericId(r.id),
    name: r.name,
    status: r.status.toLowerCase(),
    order: { admin_graphql_api_id: r.orderId, id: numericId(r.orderId) },
    return_line_items: r.lines.map((l) => ({
      admin_graphql_api_id: l.id,
      quantity: l.quantity,
      return_reason: l.returnReason,
      line_item: { admin_graphql_api_id: l.lineItemId, id: numericId(l.lineItemId) },
    })),
    reverse_fulfillment_orders: r.reverseFulfillmentOrders.map((o) => ({ admin_graphql_api_id: o.id, status: o.status.toLowerCase() })),
  };
}
