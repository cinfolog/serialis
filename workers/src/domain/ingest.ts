/**
 * Domain side of webhook ingestion (spec 12.1), inside the `ingest` transaction:
 *  - a task is scheduled only when the event may concern a tracked item (order with a tracked
 *    variant or already known as tracked, level of a tracked item);
 *  - `orders/edited` removals are kept with their restock flag when Shopify sends it (F3, PV-14);
 *  - order activity drives the R1 cadence (12.5).
 */
import type { TaskAction } from '../topics.js';
import type { DomainContext } from './context.js';

type Body = Record<string, unknown>;

/** Return topics that may add exchange lines to an ignored order (12.1). */
const REEVALUATE_IGNORED = new Set(['orders/edited', 'returns/approve', 'returns/update', 'returns/process']);

function variantGidOf(v: unknown): string | null {
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) return `gid://shopify/ProductVariant/${v}`;
  if (typeof v === 'string' && v.startsWith('gid://shopify/ProductVariant/')) return v;
  return null;
}

function orderVariants(topic: string, body: Body): string[] {
  const lines: unknown[] = [];
  if (Array.isArray(body.line_items)) lines.push(...body.line_items);
  if (topic === 'orders/edited') {
    const edit = (body.order_edit ?? {}) as Body;
    const li = (edit.line_items ?? {}) as Body;
    if (Array.isArray(li.additions)) lines.push(...li.additions);
  }
  return lines.map((l) => variantGidOf((l as Body | null)?.variant_id)).filter((v): v is string => v !== null);
}

export function shouldSchedule(ctx: DomainContext, action: TaskAction, topic: string, body: Body, now: number): boolean {
  const { sql, repo } = ctx;
  if (action.kind === 'sync_inventory_level') {
    return repo.itemByInventoryItem(`gid://shopify/InventoryItem/${String(action.payload.inventoryItemId)}`)?.active === true;
  }
  if (action.kind !== 'sync_order') return true;
  if (!repo.hasActiveItems() && !sql.exec('SELECT 1 FROM order_sync WHERE has_tracked_lines = 1 LIMIT 1').toArray().length) return false;

  const orderGid = String(action.payload.orderGid);
  if (topic.startsWith('orders/') || topic.startsWith('fulfillments/') || topic.startsWith('refunds/')) repo.setMeta('last_activity_at', String(now));
  const known = sql.exec<{ has_tracked_lines: number }>('SELECT has_tracked_lines FROM order_sync WHERE order_gid = ?', orderGid).toArray()[0];
  if (known?.has_tracked_lines === 1) return true;
  const variants = orderVariants(topic, body);
  if (variants.length > 0 && repo.itemsByVariants(variants).length > 0) return true;
  if (topic.startsWith('orders/')) {
    // The body lists the lines: no tracked variant means nothing to do, unless the edit may have added one.
    return Array.isArray(body.line_items) ? false : REEVALUATE_IGNORED.has(topic) || !known;
  }
  if (known) return REEVALUATE_IGNORED.has(topic);
  return true; // unknown order without its lines in the body: the sync decides
}

/** Keeps the removals of an order edit (restock flag when present). */
export function recordOrderEdit(ctx: DomainContext, body: Body, now: number): void {
  const edit = (body.order_edit ?? null) as Body | null;
  if (!edit || edit.order_id == null || edit.id == null) return;
  const orderGid = `gid://shopify/Order/${String(edit.order_id)}`;
  const removals = (((edit.line_items ?? {}) as Body).removals ?? []) as Body[];
  for (const r of removals) {
    if (r.id == null || typeof r.delta !== 'number') continue;
    ctx.sql.exec(
      'INSERT INTO order_edit_removals (order_gid, edit_id, line_item_gid, quantity, restock, received_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      orderGid,
      String(edit.id),
      `gid://shopify/LineItem/${String(r.id)}`,
      Math.abs(r.delta),
      typeof r.restock === 'boolean' ? (r.restock ? 1 : 0) : null,
      now,
    );
  }
}
