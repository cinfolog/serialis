import { anomalyFingerprint, severityOf, type AnomalyType } from '../anomalies.js';
import { buildUnitsMetafield, compareAllocations, sameMetafieldContent, serializeMetafield } from '../metafield.js';
import { resolveSetting, type SettingValues, type StoredSetting } from '../settings.js';
import {
  ALLOCATABLE_FO_STATUSES,
  SHIPPED_FULFILLMENT_STATUSES,
  type DispositionType,
  type LineItemSnapshot,
  type OrderSnapshot,
  type ReturnSnapshot,
} from '../snapshot.js';
import type { UnitState } from '../states.js';
import type {
  Allocation,
  AnomalyDetails,
  AnomalySubject,
  Gid,
  LocationId,
  Millis,
  ReleaseKind,
  StockWriteIntent,
  TrackedItem,
  Unit,
} from '../types.js';
import type { AnomalyDraft, ExplainedQuantityDraft, SyncPlan, SyncState, UncoveredLine } from './plan.js';
import { Workspace } from './workspace.js';

/**
 * Order synchronization — spec 12.3 (MVP scope of 19.4: no holds, S-01 and S-24 fixed, no
 * POS extension). Pure: reads a Shopify snapshot and the current state, returns a plan.
 * Replaying the plan's result with the same snapshot yields an empty plan (T-IDEM-01).
 */

export interface PlanOptions {
  /** Identifier factory; must produce lexicographically increasing ids within a call (UUID v7 does). */
  readonly newId?: () => string;
  /**
   * PV-3: Shopify adds a `PROCESSING_REQUIRED` return to `available`. Default false: Shopify
   * adds nothing and the app writes `quality_control` +1 (7.2).
   */
  readonly processingRequiredAddsAvailable?: boolean;
}

/** Anomaly types whose open/resolved state follows the desired state of the order. */
export const SYNC_MANAGED_ANOMALIES: ReadonlySet<AnomalyType> = new Set<AnomalyType>([
  'awaiting_unit',
  'insufficient_units',
  'shipped_without_unit',
  'pos_sold_without_unit',
  'preexisting_sale_to_designate',
  'shipped_unit_to_confirm',
  'return_unidentified',
]);

/** Disposition → unit state (7.2). NOT_RESTOCKED: S-19 is not an MVP setting, its default (scrap) applies. */
const DISPOSITION_TARGET: Record<DispositionType, UnitState> = {
  RESTOCKED: 'AVAILABLE',
  PROCESSING_REQUIRED: 'QUALITY_CONTROL',
  NOT_RESTOCKED: 'SCRAPPED',
  MISSING: 'LOST',
};

interface TrackedLine {
  readonly line: LineItemSnapshot;
  readonly item: TrackedItem;
}

interface PendingLine extends TrackedLine {
  readonly preexisting: boolean;
  readonly foLines: readonly OpenFoLine[];
  /** FO line → units linked to it after re-attachment. */
  readonly used: Map<Gid, number>;
  readonly locations: readonly LocationId[];
}

interface OpenFoLine {
  readonly foGid: Gid;
  readonly gid: Gid;
  readonly locationId: LocationId;
  readonly remaining: number;
}

interface Ctx {
  readonly snapshot: OrderSnapshot;
  readonly state: SyncState;
  readonly settings: readonly StoredSetting[];
  readonly now: Millis;
  readonly newId: () => string;
  readonly options: PlanOptions;
  readonly ws: Workspace;
  readonly desired: Map<string, Omit<AnomalyDraft, 'id'>>;
  readonly manual: Omit<AnomalyDraft, 'id'>[];
  readonly stockWrites: StockWriteIntent[];
  readonly uncovered: UncoveredLine[];
  readonly explained: ExplainedQuantityDraft[];
}

export function defaultIdFactory(seed: string, now: Millis): () => string {
  let n = 0;
  const stamp = now.toString(36).padStart(10, '0');
  return () => `${stamp}-${seed}-${(n++).toString(36).padStart(6, '0')}`;
}

export function planOrderSync(
  snapshot: OrderSnapshot,
  state: SyncState,
  settings: readonly StoredSetting[],
  now: Millis,
  options: PlanOptions = {},
): SyncPlan {
  const ctx: Ctx = {
    snapshot,
    state,
    settings,
    now,
    newId: options.newId ?? defaultIdFactory(snapshot.orderGid, now),
    options,
    ws: new Workspace(state.units, state.allocations),
    desired: new Map(),
    manual: [],
    stockWrites: [],
    uncovered: [],
    explained: [],
  };

  const lines = trackedLines(snapshot, state);
  if (lines.length === 0) return finish(ctx, 'ignored', lines);

  if (snapshot.test && resolveSetting('S-11', {}, settings) === 'ignore') {
    releaseIgnoredOrder(ctx, lines);
    return finish(ctx, 'ignored', lines);
  }

  // Phases (each over every line): shipments and releases, returns, then allocation, so that a
  // unit freed anywhere in the order is visible to every allocation of the same pass.
  const pending = lines.map((tracked) => syncLineShipmentsAndReleases(ctx, tracked));
  syncReturns(ctx, lines);
  for (const p of pending) allocateLine(ctx, p);
  for (const p of pending) lineAnomalies(ctx, p);
  return finish(ctx, ctx.uncovered.length > 0 ? 'short' : 'ok', lines);
}

// ---------------------------------------------------------------------------------------------
// Tracked lines (12.3 step 2)

function trackedLines(snapshot: OrderSnapshot, state: SyncState): TrackedLine[] {
  const byVariant = new Map<Gid, TrackedItem>();
  const byId = new Map<string, TrackedItem>();
  for (const item of state.trackedItems) {
    byId.set(item.id, item);
    if (item.active && item.mode === 'pooled') byVariant.set(item.variantGid, item);
  }
  const unitItem = new Map(state.units.map((u) => [u.id, u.trackedItemId]));
  const result: TrackedLine[] = [];
  for (const line of snapshot.lineItems) {
    let item = line.variantGid === null ? undefined : byVariant.get(line.variantGid);
    if (!item) {
      // A line stays tracked through an existing allocation (variant deleted, item paused).
      const alloc = state.allocations.find((a) => a.orderGid === snapshot.orderGid && a.lineItemGid === line.gid);
      const itemId = alloc ? unitItem.get(alloc.unitId) : undefined;
      item = itemId === undefined ? undefined : byId.get(itemId);
    }
    if (item && item.mode === 'pooled') result.push({ line, item });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// One line: shipments, then open quantity (12.3 steps 3-4, F1, F3, F4, F13)

function syncLineShipmentsAndReleases(ctx: Ctx, { line, item }: TrackedLine): PendingLine {
  const { snapshot, ws, state } = ctx;
  const orderGid = snapshot.orderGid;
  const preexisting = state.preexistingLineItemGids.includes(line.gid);

  const shipped = new Map<LocationId, number>();
  const lastShippedAt = new Map<LocationId, Millis>();
  for (const f of snapshot.fulfillments) {
    // Shipments made before the activation never have to be covered (EF-01).
    if (!SHIPPED_FULFILLMENT_STATUSES.has(f.status) || f.createdAt < item.activatedAt) continue;
    for (const l of f.lineItems) {
      if (l.lineItemGid !== line.gid) continue;
      shipped.set(f.locationId, (shipped.get(f.locationId) ?? 0) + l.quantity);
      lastShippedAt.set(f.locationId, Math.max(lastShippedAt.get(f.locationId) ?? 0, f.createdAt));
    }
  }
  for (const a of ws.lineAllocations(orderGid, line.gid, 'returned')) {
    shipped.set(a.locationId, (shipped.get(a.locationId) ?? 0) - 1);
  }

  const foLines = openFoLines(snapshot, line.gid);
  const locations = new Set<LocationId>([...shipped.keys(), ...foLines.map((l) => l.locationId)]);
  for (const a of ws.lineAllocations(orderGid, line.gid)) {
    if (a.status === 'active' || a.status === 'fulfilled') locations.add(a.locationId);
  }

  for (const loc of [...locations].sort()) {
    const demand = Math.max(0, shipped.get(loc) ?? 0);
    undoCancelledShipments(ctx, line, loc, demand);
    const capacity = foLines.filter((l) => l.locationId === loc).reduce((sum, l) => sum + l.remaining, 0);
    shipAllocatedUnits(ctx, line, item, loc, { demand, capacity, lastShippedAt: lastShippedAt.get(loc) ?? -Infinity }, preexisting);
  }

  const used = relinkAndRelease(ctx, line, foLines);
  return { line, item, preexisting, foLines, used, locations: [...locations].sort() };
}

function lineAnomalies(ctx: Ctx, { line, locations }: PendingLine): void {
  const { ws, snapshot } = ctx;
  const orderGid = snapshot.orderGid;
  for (const loc of locations) {
    const toConfirm = ws.lineAllocations(orderGid, line.gid, 'fulfilled', loc).filter((a) => a.toConfirm);
    if (toConfirm.length > 0) {
      desire(ctx, 'shipped_unit_to_confirm', { orderGid, lineItemGid: line.gid, locationId: loc }, {
        quantity: toConfirm.length,
        unitIds: toConfirm.map((a) => a.unitId).sort(),
      });
    }
  }

  if (line.serialisUnitsProperty !== null && line.serialisUnitsProperty.trim() !== '') {
    // MVP: no POS extension, so no token can be authentic (F8 step 4, 19.4); the line follows F1.
    addManual(ctx, 'invalid_serial_property', { orderGid, lineItemGid: line.gid }, { reason: 'pos_extension_not_installed' });
  }
}

function openFoLines(snapshot: OrderSnapshot, lineItemGid: Gid): OpenFoLine[] {
  if (snapshot.cancelledAt !== null) return [];
  const result: OpenFoLine[] = [];
  for (const fo of snapshot.fulfillmentOrders) {
    // SCHEDULED orders are only allocated when due (F13, fixed rule of 6.6.3).
    if (!ALLOCATABLE_FO_STATUSES.has(fo.status)) continue;
    for (const l of fo.lineItems) {
      if (l.lineItemGid === lineItemGid && l.remainingQuantity > 0) {
        result.push({ foGid: fo.gid, gid: l.gid, locationId: fo.locationId, remaining: l.remainingQuantity });
      }
    }
  }
  return result.sort((a, b) => cmp(a.foGid, b.foGid) || cmp(a.gid, b.gid));
}

function countsAsSale(a: Allocation): boolean {
  // Migration allocations cover shipments made before tracking; they are outside the demand.
  return a.source !== 'migration';
}

/** F4: cancelled shipment → SHIPPED → ALLOCATED on the same allocation (guarded transition of 7.2). */
function undoCancelledShipments(ctx: Ctx, line: LineItemSnapshot, loc: LocationId, demand: number): void {
  const { ws, snapshot } = ctx;
  const fulfilled = ws.lineAllocations(snapshot.orderGid, line.gid, 'fulfilled', loc).filter(countsAsSale);
  const excess = fulfilled.length - demand;
  if (excess <= 0) return;
  const candidates = fulfilled
    .filter((a) => !a.returnExpected)
    .sort((a, b) => (b.fulfilledAt ?? 0) - (a.fulfilledAt ?? 0) || cmp(b.id, a.id))
    .slice(0, excess);
  for (const a of candidates) {
    if (ws.transition(a.unitId, 'SHIPPED', 'ALLOCATED', 'shipment_cancelled', { allocationId: a.id })) {
      ws.patchAllocation(a.id, { status: 'active', fulfilledAt: null, toConfirm: false });
    }
  }
}

/**
 * F4: allocated units leave; partial shipment of a line → first allocated, to confirm (S-07
 * default). A unit can only be the shipped one if it was allocated before the last shipment
 * of the line at this location, or if the open quantity no longer needs it (DECISIONS.md, D-04);
 * a unit allocated later covers the open quantity, never an older shipment.
 */
function shipAllocatedUnits(
  ctx: Ctx,
  line: LineItemSnapshot,
  item: TrackedItem,
  loc: LocationId,
  { demand, capacity, lastShippedAt }: { demand: number; capacity: number; lastShippedAt: Millis },
  preexisting: boolean,
): void {
  const { ws, snapshot, now } = ctx;
  const orderGid = snapshot.orderGid;
  const need = demand - ws.lineAllocations(orderGid, line.gid, 'fulfilled', loc).filter(countsAsSale).length;
  if (need <= 0) return;

  const actives = ws.lineAllocations(orderGid, line.gid, 'active', loc).sort(compareAllocations);
  const surplus = new Set(actives.slice(0, Math.max(0, actives.length - capacity)).map((a) => a.id));
  const eligible = actives.filter((a) => a.allocatedAt <= lastShippedAt || surplus.has(a.id));
  const toShip = eligible.slice(0, need);
  const partial = eligible.length > toShip.length;
  for (const a of toShip) {
    if (ws.transition(a.unitId, 'ALLOCATED', 'SHIPPED', 'shipped', { allocationId: a.id })) {
      ws.patchAllocation(a.id, { status: 'fulfilled', fulfilledAt: now, toConfirm: partial });
    }
  }
  if (!partial && toShip.length > 0) {
    // The whole line has left: the provisional designation is no longer ambiguous.
    for (const a of ws.lineAllocations(orderGid, line.gid, 'fulfilled', loc)) {
      if (a.toConfirm) ws.patchAllocation(a.id, { toConfirm: false });
    }
  }

  const missing = need - toShip.length;
  if (missing <= 0) return;
  // Never auto-pick a unit for a quantity that already left (F4, F15 exception a).
  const type: AnomalyType = preexisting
    ? 'preexisting_sale_to_designate'
    : snapshot.channel === 'pos'
      ? 'pos_sold_without_unit'
      : 'shipped_without_unit';
  desire(ctx, type, { orderGid, lineItemGid: line.gid, locationId: loc }, { quantity: missing, variantGid: item.variantGid });
  ctx.explained.push({
    sourceType: preexisting ? 'preexisting_sale' : 'sale_without_unit',
    sourceRef: `${orderGid}|${line.gid}`,
    trackedItemId: item.id,
    locationId: loc,
    inventoryState: 'available',
    direction: 'surplus',
    quantity: missing,
  });
}

/** Re-attaches active allocations to open FO lines and releases the excess (F3, F5, F13, EF-16). */
function relinkAndRelease(ctx: Ctx, line: LineItemSnapshot, foLines: readonly OpenFoLine[]): Map<Gid, number> {
  const { ws, snapshot } = ctx;
  const orderGid = snapshot.orderGid;
  const byLoc = groupBy(foLines, (l) => l.locationId);
  const locations = new Set<LocationId>(byLoc.keys());
  for (const a of ws.lineAllocations(orderGid, line.gid, 'active')) locations.add(a.locationId);
  const sortedLocations = [...locations].sort();

  // 1. Re-attach existing allocations by line and location (stable across FO splits, F13).
  // Allocations kept first are the ones S-08 releases last.
  const releaseFirstAllocated = resolveSetting('S-08', {}, ctx.settings) === 'first';
  const keepOrder = (a: Allocation, b: Allocation) => (releaseFirstAllocated ? -1 : 1) * compareAllocations(a, b);
  const used = new Map<Gid, number>();
  const excess: Allocation[] = [];
  let activeTotal = 0;
  for (const loc of sortedLocations) {
    const fls = byLoc.get(loc) ?? [];
    const actives = ws.lineAllocations(orderGid, line.gid, 'active', loc).sort(keepOrder);
    activeTotal += actives.length;
    const unlinked: Allocation[] = [];
    for (const a of actives) {
      const fl = fls.find((l) => l.gid === a.fulfillmentOrderLineItemGid);
      if (fl && (used.get(fl.gid) ?? 0) < fl.remaining) used.set(fl.gid, (used.get(fl.gid) ?? 0) + 1);
      else unlinked.push(a);
    }
    for (const a of unlinked) {
      const fl = fls.find((l) => (used.get(l.gid) ?? 0) < l.remaining);
      if (!fl) {
        excess.push(a);
        continue;
      }
      used.set(fl.gid, (used.get(fl.gid) ?? 0) + 1);
      if (a.fulfillmentOrderLineItemGid !== fl.gid || a.fulfillmentOrderGid !== fl.foGid) {
        ws.patchAllocation(a.id, { fulfillmentOrderGid: fl.foGid, fulfillmentOrderLineItemGid: fl.gid });
      }
    }
  }

  // 2. Release what is no longer wanted (F3, F5, EF-16).
  const capacity = foLines.reduce((s, l) => s + l.remaining, 0);
  const removedNet = Math.max(0, activeTotal - capacity);
  releaseExcess(ctx, line, excess, excess.length - removedNet);
  return used;
}

/** Unfulfilled quantity of open FOs → ALLOCATED units (F1, S-05). */
function allocateLine(ctx: Ctx, { line, item, foLines, used, preexisting }: PendingLine): void {
  if (preexisting) return; // Lines older than the tracking are neither allocated nor counted as waiting (EF-01).
  const byLoc = groupBy(foLines, (l) => l.locationId);
  for (const loc of [...byLoc.keys()].sort()) {
    allocateAtLocation(ctx, line, item, loc, byLoc.get(loc) ?? [], used);
  }
}

function releaseExcess(ctx: Ctx, line: LineItemSnapshot, excess: Allocation[], relocatable: number): void {
  if (excess.length === 0) return;
  const { ws, snapshot, now, settings } = ctx;
  const orderGid = snapshot.orderGid;
  const sorted = excess.slice().sort(compareAllocations);
  if (resolveSetting('S-08', {}, settings) === 'last') sorted.reverse();

  let relocations = Math.max(0, relocatable);
  let restockBudget =
    restockedQuantity(snapshot, line.gid) -
    ws.lineAllocations(orderGid, line.gid, 'released').filter((a) => a.releaseKind === 'restocked').length;

  for (const a of sorted) {
    let kind: ReleaseKind;
    if (relocations > 0) {
      kind = 'relocated';
      relocations--;
    } else if (restockBudget > 0) {
      kind = 'restocked';
      restockBudget--;
    } else {
      // No restock established (NO_RESTOCK, edit without restock, unknown): unit to verify (F3, F5).
      kind = 'not_restocked';
    }
    const to: UnitState = kind === 'not_restocked' ? 'TO_VERIFY' : 'AVAILABLE';
    const event = to === 'TO_VERIFY' ? 'to_verify' : 'released';
    if (!ws.transition(a.unitId, 'ALLOCATED', to, event, { allocationId: a.id, data: { releaseKind: kind } })) continue;
    ws.patchAllocation(a.id, { status: 'released', releasedAt: now, releaseKind: kind, toConfirm: false });
    if (to === 'TO_VERIFY') {
      addManual(ctx, 'unit_to_verify', { orderGid, unitId: a.unitId, locationId: a.locationId }, {
        lineItemGid: line.gid,
        allocationId: a.id,
      });
    }
  }
}

/** Quantities of the line whose restock Shopify established: CANCEL and LEGACY_RESTOCK refunds, restocking edits. */
function restockedQuantity(snapshot: OrderSnapshot, lineItemGid: Gid): number {
  let qty = 0;
  for (const r of snapshot.refunds) {
    for (const l of r.lineItems) {
      if (l.lineItemGid === lineItemGid && (l.restockType === 'CANCEL' || l.restockType === 'LEGACY_RESTOCK')) qty += l.quantity;
    }
  }
  for (const e of snapshot.edits) if (e.lineItemGid === lineItemGid && e.restock === true) qty += e.quantity;
  return qty;
}

function allocateAtLocation(
  ctx: Ctx,
  line: LineItemSnapshot,
  item: TrackedItem,
  loc: LocationId,
  fls: readonly OpenFoLine[],
  used: Map<Gid, number>,
): void {
  const { ws, snapshot, state, settings, now } = ctx;
  const orderGid = snapshot.orderGid;
  const policy = resolveSetting('S-05', { trackedItemId: item.id, locationId: loc }, settings);
  const automatic = !state.automationPaused && policy !== 'manual';
  const candidates = automatic ? allocationCandidates(ctx, item, loc, policy) : [];

  let next = 0;
  let uncoveredQty = 0;
  for (const fl of fls) {
    let missing = fl.remaining - (used.get(fl.gid) ?? 0);
    while (missing > 0 && next < candidates.length) {
      const unit = candidates[next++] as Unit;
      const id = ctx.newId();
      if (!ws.transition(unit.id, 'AVAILABLE', 'ALLOCATED', 'allocated', { allocationId: id, data: { source: 'auto' } })) continue;
      ws.createAllocation({
        id,
        unitId: unit.id,
        variantGid: item.variantGid,
        orderGid,
        lineItemGid: line.gid,
        fulfillmentOrderGid: fl.foGid,
        fulfillmentOrderLineItemGid: fl.gid,
        locationId: loc,
        status: 'active',
        source: 'auto',
        returnExpected: false,
        toConfirm: false,
        allocationVersion: 1,
        allocatedAt: now,
        fulfilledAt: null,
        releasedAt: null,
        returnedAt: null,
        releaseKind: null,
        returnLineItemGid: null,
      });
      used.set(fl.gid, (used.get(fl.gid) ?? 0) + 1);
      missing--;
    }
    if (missing > 0) {
      ctx.uncovered.push({
        foLineItemGid: fl.gid,
        foGid: fl.foGid,
        orderGid,
        lineItemGid: line.gid,
        trackedItemId: item.id,
        locationId: loc,
        quantity: missing,
      });
      uncoveredQty += missing;
    }
  }
  if (uncoveredQty === 0) return;

  // 19.4: awaiting_unit while a unit could still be allocated (locked, manual rule, emergency
  // stop), insufficient_units when none is left (DECISIONS.md, D-03).
  const stillAllocatable = ws
    .allUnits()
    .some((u) => isFreeAvailable(ws, u, item, loc));
  const type: AnomalyType = stillAllocatable ? 'awaiting_unit' : 'insufficient_units';
  desire(ctx, type, { orderGid, lineItemGid: line.gid, locationId: loc }, { quantity: uncoveredQty, variantGid: item.variantGid });
}

function isFreeAvailable(ws: Workspace, u: Unit, item: TrackedItem, loc: LocationId): boolean {
  return u.trackedItemId === item.id && u.status === 'AVAILABLE' && u.locationId === loc && !u.packedForShipment && !ws.isEngaged(u.id);
}

/** AVAILABLE units of the variant at the FO location, not locked, not packed, not engaged; sorted by S-05. */
function allocationCandidates(ctx: Ctx, item: TrackedItem, loc: LocationId, policy: SettingValues['S-05']): Unit[] {
  const locked = new Set(ctx.state.locks.filter((l) => l.expiresAt > ctx.now).map((l) => l.unitId));
  const units = ctx.ws.allUnits().filter((u) => isFreeAvailable(ctx.ws, u, item, loc) && !locked.has(u.id));
  const fifo = (a: Unit, b: Unit) => nullsLast(a.receivedAt, b.receivedAt) || cmp(a.id, b.id);
  if (policy === 'fefo') {
    const due = (u: Unit) => {
      const dates = [u.warrantyEndsAt, u.expiresAt].filter((d): d is number => d !== null);
      return dates.length === 0 ? null : Math.min(...dates);
    };
    return units.sort((a, b) => nullsLast(due(a), due(b)) || fifo(a, b));
  }
  return units.sort(fifo);
}

// ---------------------------------------------------------------------------------------------
// Test orders ignored (S-11, F13)

function releaseIgnoredOrder(ctx: Ctx, lines: TrackedLine[]): void {
  const { ws, snapshot, now } = ctx;
  for (const { line, item } of lines) {
    for (const a of ws.lineAllocations(snapshot.orderGid, line.gid, 'active').sort(compareAllocations)) {
      if (ws.transition(a.unitId, 'ALLOCATED', 'AVAILABLE', 'released', { allocationId: a.id, data: { releaseKind: 'ignored_order' } })) {
        ws.patchAllocation(a.id, { status: 'released', releasedAt: now, releaseKind: 'ignored_order' });
      }
    }
    // 8.1: the gap left by an ignored test order that shipped is explained.
    const shipped = new Map<LocationId, number>();
    for (const f of snapshot.fulfillments) {
      if (!SHIPPED_FULFILLMENT_STATUSES.has(f.status) || f.createdAt < item.activatedAt) continue;
      for (const l of f.lineItems) {
        if (l.lineItemGid === line.gid) shipped.set(f.locationId, (shipped.get(f.locationId) ?? 0) + l.quantity);
      }
    }
    for (const [loc, qty] of [...shipped].sort(([a], [b]) => cmp(a, b))) {
      const covered = ws.lineAllocations(snapshot.orderGid, line.gid, 'fulfilled', loc).length;
      if (qty - covered > 0) {
        ctx.explained.push({
          sourceType: 'test_order_shipment',
          sourceRef: `${snapshot.orderGid}|${line.gid}`,
          trackedItemId: item.id,
          locationId: loc,
          inventoryState: 'available',
          direction: 'surplus',
          quantity: qty - covered,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Simple returns (F6, S-17, 19.4)

function syncReturns(ctx: Ctx, lines: TrackedLine[]): void {
  const byGid = new Map(lines.map((l) => [l.line.gid, l]));
  for (const r of [...ctx.snapshot.returns, ...refundReturns(ctx.snapshot)]) {
    for (const rl of r.lineItems) {
      const tracked = byGid.get(rl.lineItemGid);
      if (!tracked) continue;
      if (r.status === 'DECLINED' || r.status === 'CANCELED') {
        cancelExpectedReturn(ctx, rl.gid);
      } else if (r.status === 'OPEN' || r.status === 'CLOSED') {
        syncReturnLine(ctx, tracked, rl, r.dispositions.filter((d) => d.returnLineItemGid === rl.gid));
      }
    }
  }
}

/**
 * Refund with restock `RETURN` outside any Shopify return (EF-23, F5): handled as a restocked
 * disposition at the refund location, on a synthetic return line (DECISIONS.md, D-06).
 */
function refundReturns(snapshot: OrderSnapshot): ReturnSnapshot[] {
  const inReturns = new Set(snapshot.returns.flatMap((r) => r.lineItems.map((l) => l.lineItemGid)));
  const result: ReturnSnapshot[] = [];
  for (const refund of snapshot.refunds) {
    for (const l of refund.lineItems) {
      if (l.restockType !== 'RETURN' || l.locationId === null || inReturns.has(l.lineItemGid)) continue;
      const gid = `${refund.gid}#${l.lineItemGid}`;
      result.push({
        gid,
        status: 'CLOSED',
        lineItems: [{ gid, lineItemGid: l.lineItemGid, quantity: l.quantity }],
        dispositions: [{ returnLineItemGid: gid, type: 'RESTOCKED', quantity: l.quantity, locationId: l.locationId }],
      });
    }
  }
  return result;
}

function cancelExpectedReturn(ctx: Ctx, returnLineItemGid: Gid): void {
  const { ws, snapshot } = ctx;
  for (const a of ws.allAllocations()) {
    if (a.orderGid !== snapshot.orderGid || a.status !== 'fulfilled' || !a.returnExpected || a.returnLineItemGid !== returnLineItemGid) continue;
    if (ws.transition(a.unitId, 'RETURN_PENDING', 'SHIPPED', 'return_cancelled', { allocationId: a.id })) {
      ws.patchAllocation(a.id, { returnExpected: false, returnLineItemGid: null });
    }
  }
}

function syncReturnLine(
  ctx: Ctx,
  { line, item }: TrackedLine,
  rl: ReturnSnapshot['lineItems'][number],
  dispositions: ReturnSnapshot['dispositions'],
): void {
  const { ws, snapshot, state, settings } = ctx;
  const orderGid = snapshot.orderGid;
  const sold = ws
    .lineAllocations(orderGid, line.gid)
    .filter((a) => a.status === 'fulfilled' || (a.status === 'returned' && a.returnLineItemGid === rl.gid));
  const soldUnits = new Set(sold.map((a) => a.unitId));

  // 1 bis. Identification by typed ref (15.5); a ref of another unit opens return_unit_mismatch.
  const identified: string[] = [];
  for (const idn of state.returnIdentifications) {
    if (idn.returnLineItemGid !== rl.gid) continue;
    if (idn.unitId !== null && soldUnits.has(idn.unitId)) {
      if (!identified.includes(idn.unitId)) identified.push(idn.unitId);
      continue;
    }
    const subject: AnomalySubject =
      idn.unitId === null ? { orderGid, returnLineItemGid: rl.gid } : { orderGid, returnLineItemGid: rl.gid, unitId: idn.unitId };
    addManual(ctx, 'return_unit_mismatch', subject, { typedRef: idn.typedRef, expectedUnitIds: [...soldUnits].sort() });
  }

  const single = line.quantity === 1;
  const fulfilled = sold.filter((a) => a.status === 'fulfilled');
  if (!resolveSetting('S-17', {}, settings) && single && identified.length === 0 && fulfilled.length === 1 && sold.length === 1) {
    identified.push((fulfilled[0] as Allocation).unitId); // S-17 = no: the allocated unit is deemed returned.
  }
  const capped = identified.slice(0, rl.quantity);

  // 1. Approval: a single-unit line goes RETURN_PENDING at once; otherwise once identified.
  const expected = new Set<string>(capped);
  if (single && fulfilled.length === 1) expected.add((fulfilled[0] as Allocation).unitId);
  for (const a of fulfilled) if (expected.has(a.unitId)) markReturnPending(ctx, a, rl.gid);

  // 2-3. Dispositions apply to identified units only; the rest waits for identification.
  const slots = dispositions.flatMap((d) => Array.from({ length: d.quantity }, () => d));
  const consumed = ws.allAllocations().filter((a) => a.orderGid === orderGid && a.status === 'returned' && a.returnLineItemGid === rl.gid).length;
  const open = slots.slice(consumed);
  const ready = capped
    .map((unitId) => ws.allAllocations().find((a) => a.orderGid === orderGid && a.unitId === unitId && a.status === 'fulfilled'))
    .filter((a): a is Allocation => a !== undefined && a.returnExpected && a.returnLineItemGid === rl.gid);

  let applied = 0;
  for (const a of ready) {
    const slot = open[applied];
    if (!slot) break;
    if (applyDisposition(ctx, item, a, slot)) applied++;
  }

  const unidentified = open.slice(applied);
  if (unidentified.length === 0) return;
  desire(ctx, 'return_unidentified', { orderGid, lineItemGid: line.gid, returnLineItemGid: rl.gid }, { quantity: unidentified.length });
  const restockedByLoc = new Map<LocationId, number>();
  for (const s of unidentified) if (s.type === 'RESTOCKED') restockedByLoc.set(s.locationId, (restockedByLoc.get(s.locationId) ?? 0) + 1);
  for (const [loc, qty] of [...restockedByLoc].sort(([a], [b]) => cmp(a, b))) {
    ctx.explained.push({
      sourceType: 'return_unidentified',
      sourceRef: rl.gid,
      trackedItemId: item.id,
      locationId: loc,
      inventoryState: 'available',
      direction: 'deficit',
      quantity: qty,
    });
  }
}

function markReturnPending(ctx: Ctx, a: Allocation, returnLineItemGid: Gid): void {
  if (a.returnExpected) return; // Already expected (on this or another return line).
  if (ctx.ws.transition(a.unitId, 'SHIPPED', 'RETURN_PENDING', 'return_pending', { allocationId: a.id })) {
    ctx.ws.patchAllocation(a.id, { returnExpected: true, returnLineItemGid });
  }
}

function applyDisposition(ctx: Ctx, item: TrackedItem, a: Allocation, slot: ReturnSnapshot['dispositions'][number]): boolean {
  const to = DISPOSITION_TARGET[slot.type];
  const ok = ctx.ws.transition(a.unitId, 'RETURN_PENDING', to, 'returned', {
    allocationId: a.id,
    locationId: slot.locationId,
    data: { disposition: slot.type },
  });
  if (!ok) return false;
  ctx.ws.patchAllocation(a.id, { status: 'returned', returnedAt: ctx.now, returnExpected: false });
  if (to === 'QUALITY_CONTROL') {
    const base = { inventoryItemGid: item.inventoryItemGid, locationId: slot.locationId, delta: 1, unitId: a.unitId, reason: 'return_processing_required' };
    ctx.stockWrites.push(
      ctx.options.processingRequiredAddsAvailable
        ? { ...base, kind: 'move', fromQuantityName: 'available', quantityName: 'quality_control' }
        : { ...base, kind: 'adjust', quantityName: 'quality_control' },
    );
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Anomalies and result

function desire(ctx: Ctx, type: AnomalyType, subject: AnomalySubject, details: AnomalyDetails): void {
  const fingerprint = anomalyFingerprint(type, subject);
  ctx.desired.set(fingerprint, { type, severity: severityOf(type), subject, fingerprint, details });
}

/** Anomalies resolved by a person: opened once per cause, never re-opened by a replay. */
function addManual(ctx: Ctx, type: AnomalyType, subject: AnomalySubject, details: AnomalyDetails): void {
  const fingerprint = anomalyFingerprint(type, subject);
  if (ctx.manual.some((m) => m.fingerprint === fingerprint)) return;
  ctx.manual.push({ type, severity: severityOf(type), subject, fingerprint, details });
}

function sameDetails(a: AnomalyDetails, b: AnomalyDetails): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}

function finish(ctx: Ctx, status: SyncPlan['status'], lines: TrackedLine[]): SyncPlan {
  const { snapshot, state, ws, settings } = ctx;
  const orderGid = snapshot.orderGid;

  const ofOrder = state.anomalies.filter((a) => a.subject.orderGid === orderGid);
  const live = ofOrder.filter((a) => a.status === 'open' || a.status === 'acknowledged');
  const anomaliesToOpen: AnomalyDraft[] = [];
  const anomaliesToUpdate: { id: string; details: AnomalyDetails }[] = [];
  const anomaliesToResolve: string[] = [];
  for (const a of live) {
    if (!SYNC_MANAGED_ANOMALIES.has(a.type)) continue;
    const wanted = ctx.desired.get(a.fingerprint);
    if (!wanted) anomaliesToResolve.push(a.id);
    else if (!sameDetails(a.details, wanted.details)) anomaliesToUpdate.push({ id: a.id, details: wanted.details });
  }
  for (const d of ctx.desired.values()) {
    if (!live.some((a) => a.fingerprint === d.fingerprint)) anomaliesToOpen.push({ id: ctx.newId(), ...d });
  }
  for (const m of ctx.manual) {
    if (!ofOrder.some((a) => a.fingerprint === m.fingerprint)) anomaliesToOpen.push({ id: ctx.newId(), ...m });
  }

  let metafield: SyncPlan['metafield'];
  if (lines.length === 0) {
    metafield = { value: snapshot.metafieldValue, write: false }; // Untracked order: never touched.
  } else {
    const value = resolveSetting('S-38', {}, settings)
      ? serializeMetafield(
          buildUnitsMetafield(
            lines.map((l) => l.line.gid),
            ws.allAllocations().filter((a) => a.orderGid === orderGid),
            new Map(ws.allUnits().map((u) => [u.id, u])),
          ),
        )
      : null;
    metafield = { value, write: !sameMetafieldContent(value, snapshot.metafieldValue) };
  }

  return {
    orderGid,
    status,
    allocationsToCreate: ws.createdAllocations(),
    allocationUpdates: ws.allocationUpdates(),
    unitTransitions: ws.transitions,
    anomaliesToOpen,
    anomaliesToUpdate,
    anomaliesToResolve,
    stockWrites: ctx.stockWrites,
    uncoveredLines: ctx.uncovered,
    explainedQuantities: ctx.explained,
    metafield,
    rejected: ws.rejected,
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function groupBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}
