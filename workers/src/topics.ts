/**
 * Webhook topic → action (spec 12.1, 12.2, 13.2). Pure: works on the parsed body only.
 * Fulfillment-order and some return topics do not carry the order id: they schedule a light
 * `resolve:<gid>` task that will find the order (spec 12.1, last paragraph).
 */
import { TASK_PRIORITY, type TaskKind } from './task-kinds.js';

export const COMPLIANCE_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'] as const;
export type ComplianceTopic = (typeof COMPLIANCE_TOPICS)[number];

export function isComplianceTopic(topic: string): topic is ComplianceTopic {
  return (COMPLIANCE_TOPICS as readonly string[]).includes(topic);
}

export interface TaskAction {
  type: 'task';
  key: string;
  kind: TaskKind;
  priority: number;
  payload: Record<string, unknown>;
}

export type TopicAction =
  | TaskAction
  | { type: 'compliance'; topic: ComplianceTopic; orderGids: string[]; dataRequestId: string | null }
  | { type: 'uninstall' }
  | { type: 'none'; reason: string };

type Body = Record<string, unknown>;

/** Delay before a task triggered by a webhook runs, so that a burst gives one run (spec 12.1 step 3). */
export const WEBHOOK_TASK_DELAY_MS = 2_000;

export function topicAction(topic: string, body: unknown): TopicAction {
  const b: Body = body && typeof body === 'object' ? (body as Body) : {};

  if (topic === 'app/uninstalled') return { type: 'uninstall' };
  if (isComplianceTopic(topic)) {
    const orders = Array.isArray(b.orders_requested) ? b.orders_requested : Array.isArray(b.orders_to_redact) ? b.orders_to_redact : [];
    const dataRequest = b.data_request && typeof b.data_request === 'object' ? (b.data_request as Body).id : null;
    return {
      type: 'compliance',
      topic,
      orderGids: orders.map((o) => gid('Order', o)).filter((g): g is string => g !== null),
      dataRequestId: dataRequest == null ? null : String(dataRequest),
    };
  }

  const [resource] = topic.split('/');
  switch (resource) {
    case 'orders':
      return syncOrder(gid('Order', b.admin_graphql_api_id ?? b.id), topic);
    case 'fulfillments':
    case 'refunds':
      return syncOrder(gid('Order', b.order_id), topic);
    case 'returns':
      return syncOrderOrResolve(orderOf(b), gid('Return', b.admin_graphql_api_id ?? b.id), topic);
    case 'reverse_fulfillment_orders':
      return syncOrderOrResolve(orderOf(b), gid('ReverseFulfillmentOrder', b.admin_graphql_api_id ?? b.id), topic);
    case 'fulfillment_orders': {
      const fo = firstObject(b, ['fulfillment_order', 'original_fulfillment_order', 'moved_fulfillment_order', 'remaining_fulfillment_order']);
      return syncOrderOrResolve(orderOf(fo ?? {}), gid('FulfillmentOrder', fo?.id ?? fo?.admin_graphql_api_id), topic);
    }
    case 'inventory_levels': {
      const item = numericId(b.inventory_item_id);
      const location = numericId(b.location_id);
      if (!item || !location) return { type: 'none', reason: 'missing_ids' };
      return task(`inv:${item}:${location}`, 'sync_inventory_level', { inventoryItemId: item, locationId: location, topic });
    }
    case 'inventory_items': {
      const item = numericId(b.id);
      return item ? task(`inventory_item:${item}`, 'sync_inventory_item', { inventoryItemId: item, topic }) : { type: 'none', reason: 'missing_ids' };
    }
    case 'products': {
      const product = numericId(b.id);
      return product ? task(`product:${product}`, 'sync_product', { productId: product, topic }) : { type: 'none', reason: 'missing_ids' };
    }
    case 'locations': {
      const location = numericId(b.id);
      return location ? task(`location:${location}`, 'sync_location', { locationId: location, topic }) : { type: 'none', reason: 'missing_ids' };
    }
    default:
      // draft_orders/* (lot 1), inventory_transfers/* (lot 2), bulk_operations/finish, app_subscriptions/update…
      return { type: 'none', reason: 'not_handled_yet' };
  }
}

function task(key: string, kind: TaskKind, payload: Record<string, unknown>): TaskAction {
  return { type: 'task', key, kind, priority: TASK_PRIORITY[kind], payload };
}

function syncOrder(orderGid: string | null, topic: string): TopicAction {
  if (!orderGid) return { type: 'none', reason: 'missing_order_id' };
  return task(`sync_order:${orderGid}`, 'sync_order', { orderGid, topic });
}

function syncOrderOrResolve(orderGid: string | null, subjectGid: string | null, topic: string): TopicAction {
  if (orderGid) return syncOrder(orderGid, topic);
  if (!subjectGid) return { type: 'none', reason: 'missing_ids' };
  return task(`resolve:${subjectGid}`, 'resolve', { gid: subjectGid, topic });
}

function orderOf(b: Body): string | null {
  if (b.order_id != null) return gid('Order', b.order_id);
  const order = b.order;
  if (order && typeof order === 'object') {
    const o = order as Body;
    return gid('Order', o.admin_graphql_api_id ?? o.id);
  }
  return null;
}

function firstObject(b: Body, keys: string[]): Body | null {
  for (const k of keys) {
    const v = b[k];
    if (v && typeof v === 'object') return v as Body;
  }
  return null;
}

/** Numeric id from a number, a numeric string or a gid. */
function numericId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string') {
    const m = /^(?:gid:\/\/shopify\/[A-Za-z]+\/)?(\d+)$/.exec(value);
    if (m) return m[1]!;
  }
  return null;
}

/** `gid://shopify/<Type>/<id>` from a number, a numeric string or a gid of that type. */
export function gid(type: string, value: unknown): string | null {
  if (typeof value === 'string' && value.startsWith(`gid://shopify/${type}/`)) {
    return /^gid:\/\/shopify\/[A-Za-z]+\/\d+$/.test(value) ? value : null;
  }
  const id = typeof value === 'string' && value.startsWith('gid://') ? null : numericId(value);
  return id ? `gid://shopify/${type}/${id}` : null;
}

/** Body kept in the inbox for a compliance topic: identifiers only, never customer details (P8). */
export function minimalCompliancePayload(action: Extract<TopicAction, { type: 'compliance' }>): string {
  return JSON.stringify({ orders: action.orderGids, data_request_id: action.dataRequestId });
}
