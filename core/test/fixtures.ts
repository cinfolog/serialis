import { expect } from 'vitest';
import type { StoredSetting } from '../src/settings.js';
import type {
  FulfillmentOrderSnapshot,
  FulfillmentSnapshot,
  LineItemSnapshot,
  OrderSnapshot,
  RefundSnapshot,
  ReturnSnapshot,
} from '../src/snapshot.js';
import type { UnitState } from '../src/states.js';
import type { TrackedItem, Unit } from '../src/types.js';
import { applyPlan } from '../src/sync/applyPlan.js';
import { isEmptyPlan, type SyncPlan, type SyncState } from '../src/sync/plan.js';
import { planOrderSync, type PlanOptions } from '../src/sync/planOrderSync.js';

/** Fictitious fixtures only (no real shop or customer names). */

export const T0 = Date.UTC(2026, 10, 1);
export const LOC_A = 'loc-a';
export const LOC_B = 'loc-b';
export const ORDER = 'gid://shopify/Order/1001';

export function item(n: number, overrides: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: `item-${n}`,
    productGid: `gid://shopify/Product/${n}`,
    variantGid: `gid://shopify/ProductVariant/${n}`,
    inventoryItemGid: `gid://shopify/InventoryItem/${n}`,
    mode: 'pooled',
    activatedAt: T0 - 86_400_000,
    initializing: false,
    active: true,
    ...overrides,
  };
}

export function unit(
  id: string,
  trackedItemId: string,
  locationId: string | null,
  overrides: Partial<Unit> = {},
): Unit {
  return {
    id,
    trackedItemId,
    status: 'AVAILABLE',
    locationId,
    identifiers: [{ type: 'serial', value: `SN-${id.toUpperCase()}`, primary: true }],
    receivedAt: T0 - 1_000_000,
    expiresAt: null,
    warrantyEndsAt: null,
    holdMovedStock: false,
    packedForShipment: false,
    version: 1,
    ...overrides,
  };
}

/** `n` units of an item at a location, received in id order (u1 first). */
export function units(prefix: string, trackedItemId: string, locationId: string, n: number, status: UnitState = 'AVAILABLE'): Unit[] {
  return Array.from({ length: n }, (_, i) =>
    unit(`${prefix}${i + 1}`, trackedItemId, locationId, { status, receivedAt: T0 - 1_000_000 + i }),
  );
}

export function state(overrides: Partial<SyncState> = {}): SyncState {
  return {
    trackedItems: [],
    units: [],
    allocations: [],
    anomalies: [],
    locks: [],
    preexistingLineItemGids: [],
    returnIdentifications: [],
    automationPaused: false,
    ...overrides,
  };
}

export function line(n: number, variantN: number | null, quantity: number, overrides: Partial<LineItemSnapshot> = {}): LineItemSnapshot {
  return {
    gid: `gid://shopify/LineItem/${n}`,
    variantGid: variantN === null ? null : `gid://shopify/ProductVariant/${variantN}`,
    quantity,
    currentQuantity: quantity,
    serialisUnitsProperty: null,
    ...overrides,
  };
}

export function fo(
  n: number,
  locationId: string,
  lines: readonly { line: number; remaining: number; total?: number }[],
  status: FulfillmentOrderSnapshot['status'] = 'OPEN',
): FulfillmentOrderSnapshot {
  return {
    gid: `gid://shopify/FulfillmentOrder/${n}`,
    status,
    locationId,
    lineItems: lines.map((l) => ({
      gid: `gid://shopify/FulfillmentOrderLineItem/${n}-${l.line}`,
      lineItemGid: `gid://shopify/LineItem/${l.line}`,
      totalQuantity: l.total ?? l.remaining,
      remainingQuantity: l.remaining,
    })),
  };
}

export function fulfillment(
  n: number,
  locationId: string,
  lines: readonly { line: number; quantity: number }[],
  overrides: Partial<FulfillmentSnapshot> = {},
): FulfillmentSnapshot {
  return {
    gid: `gid://shopify/Fulfillment/${n}`,
    status: 'SUCCESS',
    locationId,
    // After the first sync of the fixtures (T0 + 10 s): the shipment follows the allocation.
    createdAt: T0 + 15_000,
    lineItems: lines.map((l) => ({ lineItemGid: `gid://shopify/LineItem/${l.line}`, quantity: l.quantity })),
    ...overrides,
  };
}

export function refund(
  n: number,
  lines: readonly { line: number; quantity: number; restockType: RefundSnapshot['lineItems'][number]['restockType']; locationId?: string | null }[],
): RefundSnapshot {
  return {
    gid: `gid://shopify/Refund/${n}`,
    createdAt: T0 + 2000,
    lineItems: lines.map((l) => ({
      lineItemGid: `gid://shopify/LineItem/${l.line}`,
      quantity: l.quantity,
      restockType: l.restockType,
      locationId: l.locationId ?? null,
    })),
  };
}

export function ret(
  n: number,
  status: ReturnSnapshot['status'],
  lines: readonly { line: number; quantity: number; processed?: number }[],
  dispositions: readonly { line: number; type: ReturnSnapshot['dispositions'][number]['type']; quantity: number; locationId: string | null }[] = [],
): ReturnSnapshot {
  const rlGid = (l: number) => `gid://shopify/ReturnLineItem/${n}-${l}`;
  return {
    gid: `gid://shopify/Return/${n}`,
    status,
    lineItems: lines.map((l) => ({
      gid: rlGid(l.line),
      lineItemGid: `gid://shopify/LineItem/${l.line}`,
      quantity: l.quantity,
      ...(l.processed !== undefined ? { processedQuantity: l.processed } : {}),
    })),
    dispositions: dispositions.map((d) => ({ returnLineItemGid: rlGid(d.line), type: d.type, quantity: d.quantity, locationId: d.locationId })),
  };
}

export function order(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    orderGid: ORDER,
    name: '#1001',
    createdAt: T0,
    updatedAt: T0,
    cancelledAt: null,
    test: false,
    channel: 'online_store',
    retailLocationId: null,
    metafieldValue: null,
    lineItems: [],
    fulfillmentOrders: [],
    fulfillments: [],
    refunds: [],
    edits: [],
    returns: [],
    ...overrides,
  };
}

export interface SyncResult {
  plan: SyncPlan;
  state: SyncState;
  snapshot: OrderSnapshot;
}

/**
 * Plans, checks that every transition was accepted, applies, writes the metafield back into
 * the snapshot (as Shopify would), and checks that a replay is empty (T-IDEM-01, T-IDEM-02).
 */
export function sync(
  snapshot: OrderSnapshot,
  current: SyncState,
  now = T0 + 10_000,
  settings: readonly StoredSetting[] = [],
  options: PlanOptions = {},
): SyncResult {
  const plan = planOrderSync(snapshot, current, settings, now, options);
  expect(plan.rejected).toEqual([]);
  const next = applyPlan(current, plan, now);
  const written = plan.metafield.write ? { ...snapshot, metafieldValue: plan.metafield.value } : snapshot;
  const replay = planOrderSync(written, next, settings, now + 1, options);
  expect(replay.rejected).toEqual([]);
  expect(isEmptyPlan(replay), `replay not empty: ${JSON.stringify(replay, null, 1)}`).toBe(true);
  return { plan, state: next, snapshot: written };
}

export function unitStatus(s: SyncState, id: string): UnitState | undefined {
  return s.units.find((u) => u.id === id)?.status;
}

export function openAnomalies(s: SyncState, type?: string) {
  return s.anomalies.filter((a) => (a.status === 'open' || a.status === 'acknowledged') && (type === undefined || a.type === type));
}

export function activeUnitIds(s: SyncState, lineN?: number): string[] {
  return s.allocations
    .filter((a) => a.status === 'active' && (lineN === undefined || a.lineItemGid === `gid://shopify/LineItem/${lineN}`))
    .map((a) => a.unitId)
    .sort();
}
