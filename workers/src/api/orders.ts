/**
 * Orders, allocations, returns and anomalies (spec 9.4, 9.6, 9.15, 12.7, 14.2; MVP 19.4 point 3).
 * Every manual change runs in one transaction (allocation first, then unit, 11.2) and schedules a
 * synchronization of the order, which refreshes the metafield and the anomalies.
 */
import { designateUnit, normalizeIdentifier, resolveSetting, type Allocation as CoreAllocation, type DesignationCandidate } from '@serialis/core';
import type {
  ConfirmShippedRequest,
  CreateAllocationRequest,
  IdentifyReturnRequest,
  OrderAllocationsResponse,
  ReplaceAllocationRequest,
  ResolveAnomalyRequest,
} from '@serialis/contract';
import type { UnitRecord } from '../domain/repo.js';
import { readLevel } from '../domain/shopify-read.js';
import { requestLevelCheck, requestOrderSync } from '../domain/sync-order.js';
import { newId } from '../domain/util.js';
import { stockWriteInput } from '../domain/writes.js';
import { evaluateLevel, storeLevel } from '../domain/levels.js';
import { allocationEtag, ApiError, checkIfMatch, decodeCursor, encodeCursor, iso, json, noContent, orderGidOf, pageLimit, parseBody, queryOne, type ApiResult } from './http.js';
import { presentAllocation, presentAnomaly, type ApiContext } from './present.js';
import { requireAdmin } from './users.js';

/** Released units are kept out of automatic allocation for a while, so that "remove" is not undone by the next sync (D-25). */
export const MANUAL_RELEASE_LOCK_MS = 15 * 60_000;

function normalization(ctx: ApiContext) {
  return resolveSetting('S-36', { identifierType: 'serial' }, ctx.d.repo.storedSettings());
}

// ------------------------------------------------------------------------------------- read

export function orderAllocations(ctx: ApiContext, orderParam: string): ApiResult {
  const orderGid = orderGidOf(orderParam);
  const { sql, repo } = ctx.d;
  const sync = sql.exec<{ status: string; last_synced_at: number | null }>('SELECT status, last_synced_at FROM order_sync WHERE order_gid = ?', orderGid).toArray()[0];
  if (!sync) {
    // Never synchronized (webhook still in flight, or created before the app): ask for it now.
    ctx.d.storage.transactionSync(() => requestOrderSync(ctx.d, orderGid, 0, ctx.now));
  }
  const lines = sql
    .exec<{ line_item_gid: string; variant_gid: string | null; title: string; quantity: number; current_quantity: number; tracked: number }>(
      'SELECT * FROM order_lines WHERE order_gid = ? ORDER BY position',
      orderGid,
    )
    .toArray();
  const allocations = repo.orderAllocations(orderGid);
  const units = new Map(repo.unitsByIds(allocations.map((a) => a.unitId)).map((u) => [u.id, u]));
  const missing = new Map(
    sql
      .exec<{ line_item_gid: string; q: number }>('SELECT line_item_gid, SUM(quantity) AS q FROM uncovered_lines WHERE order_gid = ? GROUP BY line_item_gid', orderGid)
      .toArray()
      .map((r) => [r.line_item_gid, r.q]),
  );
  // Quantities that left without a unit (to designate) also count as missing refs.
  for (const r of sql
    .exec<{ source_ref: string; q: number }>(
      "SELECT source_ref, SUM(quantity) AS q FROM explained_quantities WHERE order_gid = ? AND status = 'open' AND source_type IN ('sale_without_unit', 'preexisting_sale') GROUP BY source_ref",
      orderGid,
    )
    .toArray()) {
    const line = r.source_ref.split('|')[1] ?? '';
    missing.set(line, (missing.get(line) ?? 0) + r.q);
  }
  const statusOrder = { active: 0, fulfilled: 1, returned: 2, released: 3 } as const;
  const response: OrderAllocationsResponse = {
    orderGid,
    lines: lines.map((l) => ({
      lineItemGid: l.line_item_gid,
      variantGid: l.variant_gid ?? '',
      title: l.title,
      tracked: l.tracked === 1,
      quantity: l.current_quantity,
      orderedQuantity: l.quantity,
      allocations: allocations
        .filter((a) => a.lineItemGid === l.line_item_gid)
        .sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.allocatedAt - b.allocatedAt || (a.id < b.id ? -1 : 1))
        .map((a) => presentAllocation(ctx, a, units.get(a.unitId) ?? null)),
      missing: missing.get(l.line_item_gid) ?? 0,
    })),
    syncState: !sync ? 'pending' : sync.status === 'error' ? 'error' : sync.status === 'pending' ? 'pending' : 'synced',
    syncedAt: iso(sync?.last_synced_at ?? null),
  };
  return json(response);
}

// ------------------------------------------------------------------------------------- designation (15.5)

interface LineContext {
  orderGid: string;
  lineItemGid: string;
  variantGid: string;
  itemId: string;
}

function lineContext(ctx: ApiContext, orderGid: string, lineItemGid: string): LineContext {
  const line = ctx.d.sql
    .exec<{ variant_gid: string | null; tracked: number }>('SELECT variant_gid, tracked FROM order_lines WHERE order_gid = ? AND line_item_gid = ?', orderGid, lineItemGid)
    .toArray()[0];
  if (!line) throw new ApiError(404, 'not_found', 'unknown order line (order not synchronized yet?)');
  const anyAlloc = ctx.d.repo.orderAllocations(orderGid).find((a) => a.lineItemGid === lineItemGid);
  const item = (line.variant_gid ? ctx.d.repo.latestItemByVariant(line.variant_gid) : null) ?? (anyAlloc ? ctx.d.repo.itemsByIds([ctx.d.repo.unit(anyAlloc.unitId)?.trackedItemId ?? ''])[0] : null);
  if (!item || (line.tracked !== 1 && !anyAlloc)) throw new ApiError(422, 'not_tracked', 'this line is not tracked');
  return { orderGid, lineItemGid, variantGid: item.variantGid, itemId: item.id };
}

function candidatesOf(units: UnitRecord[]): DesignationCandidate[] {
  return units.map((u) => ({ unitId: u.id, identifiers: u.identifiers }));
}

/** Resolves a typed ref (full, or last 4 characters unique among the candidates) or a unit id. */
function resolveUnit(ctx: ApiContext, input: { unitId?: string | undefined; ref?: string | undefined }, candidates: UnitRecord[]): UnitRecord {
  const { repo } = ctx.d;
  if (input.unitId) {
    const u = repo.unit(input.unitId);
    if (!u) throw new ApiError(404, 'not_found', 'unknown unit');
    return u;
  }
  if (!input.ref || input.ref.trim() === '') throw new ApiError(400, 'validation_failed', 'unitId or ref required');
  const result = designateUnit(input.ref, candidatesOf(candidates), normalization(ctx));
  if (result.ok) return candidates.find((u) => u.id === result.unitId)!;
  if (result.reason === 'ambiguous') throw new ApiError(409, 'ambiguous_ref', `the ref designates ${result.unitIds.length} units: type it in full`);
  // Full ref anywhere in the shop: the checks below give a precise refusal (wrong variant, location, state).
  const exact = repo.lookup(normalizeIdentifier(input.ref, normalization(ctx)));
  if (exact.length === 1) return exact[0]!;
  throw new ApiError(404, 'unknown_ref', 'no unit with this ref');
}

function assertAllocatable(ctx: ApiContext, unit: UnitRecord, line: LineContext, locations: string[]): void {
  if (unit.variantGid !== line.variantGid || unit.trackedItemId !== line.itemId) throw new ApiError(409, 'variant_mismatch', 'the unit is of another variant');
  const engaged = ctx.d.repo.currentAllocationOf(unit.id);
  if (unit.status !== 'AVAILABLE' || engaged) {
    const detail = engaged ? `unit already engaged in order ${engaged.orderGid}` : `unit is ${unit.status}`;
    throw new ApiError(409, 'unit_not_available', detail);
  }
  if (!unit.locationId || !locations.includes(unit.locationId)) {
    throw new ApiError(409, 'location_mismatch', `the unit is at ${unit.locationId ?? 'no location'}, the line ships from ${locations.join(', ')}`);
  }
}

function availableUnitsOf(ctx: ApiContext, itemId: string, locations: string[] | null): UnitRecord[] {
  const rows = ctx.d.sql
    .exec<{ id: string }>(
      locations
        ? `SELECT id FROM units WHERE tracked_item_id = ? AND status = 'AVAILABLE' AND location_id IN (${locations.map(() => '?').join(', ')}) LIMIT 2000`
        : "SELECT id FROM units WHERE tracked_item_id = ? AND status = 'AVAILABLE' LIMIT 2000",
      itemId,
      ...(locations ?? []),
    )
    .toArray();
  return ctx.d.repo.unitsByIds(rows.map((r) => r.id));
}

// ------------------------------------------------------------------------------------- allocate (EF-12, late designation EF-17)

type Target =
  | { kind: 'open'; uncovered: Array<{ foLine: string; fo: string; locationId: string; quantity: number }> }
  | { kind: 'late'; shipped: Array<{ id: string; locationId: string; quantity: number; sourceType: string }> };

function targetOf(ctx: ApiContext, line: LineContext): Target {
  const { sql } = ctx.d;
  const uncovered = sql
    .exec<{ fo_line_item_gid: string; fo_gid: string; location_id: string; quantity: number }>(
      'SELECT fo_line_item_gid, fo_gid, location_id, quantity FROM uncovered_lines WHERE order_gid = ? AND line_item_gid = ? ORDER BY fo_line_item_gid',
      line.orderGid,
      line.lineItemGid,
    )
    .toArray();
  if (uncovered.length > 0) {
    return { kind: 'open', uncovered: uncovered.map((u) => ({ foLine: u.fo_line_item_gid, fo: u.fo_gid, locationId: u.location_id, quantity: u.quantity })) };
  }
  const shipped = sql
    .exec<{ id: string; location_id: string; quantity: number; source_type: string }>(
      "SELECT id, location_id, quantity, source_type FROM explained_quantities WHERE order_gid = ? AND source_ref = ? AND status = 'open' AND source_type IN ('sale_without_unit', 'preexisting_sale') AND quantity > 0",
      line.orderGid,
      `${line.orderGid}|${line.lineItemGid}`,
    )
    .toArray();
  if (shipped.length > 0) return { kind: 'late', shipped: shipped.map((s) => ({ id: s.id, locationId: s.location_id, quantity: s.quantity, sourceType: s.source_type })) };
  throw new ApiError(409, 'invalid_transition', 'every unit of this line already has a ref');
}

/** Manual allocation of a unit to a line (open quantity), or late designation of a unit that already left (AVAILABLE → SHIPPED, source `late`). */
export function allocateToLine(ctx: ApiContext, orderGid: string, lineItemGid: string, input: { unitId?: string | undefined; ref?: string | undefined }): CoreAllocation {
  const line = lineContext(ctx, orderGid, lineItemGid);
  const target = targetOf(ctx, line);
  const locations = target.kind === 'open' ? [...new Set(target.uncovered.map((u) => u.locationId))] : [...new Set(target.shipped.map((s) => s.locationId))];
  let candidates = availableUnitsOf(ctx, line.itemId, locations);
  if (input.ref && !input.unitId) {
    // Prefer the units of the right location; otherwise look at the whole variant to explain the refusal.
    const local = designateUnit(input.ref, candidatesOf(candidates), normalization(ctx));
    if (!local.ok && local.reason !== 'ambiguous') candidates = availableUnitsOf(ctx, line.itemId, null);
  }
  const unit = resolveUnit(ctx, input, candidates);
  const now = ctx.now;
  return ctx.d.storage.transactionSync(() => {
    const fresh = ctx.d.repo.unit(unit.id)!;
    assertAllocatable(ctx, fresh, line, locations);
    const { repo } = ctx.d;
    const id = newId(now);
    let allocation: CoreAllocation;
    if (target.kind === 'open') {
      const slot = target.uncovered.find((u) => u.locationId === fresh.locationId)!;
      allocation = baseAllocation(id, fresh, line, slot.locationId, now, { status: 'active', source: manualSource(ctx), fulfillmentOrderGid: slot.fo, fulfillmentOrderLineItemGid: slot.foLine });
      repo.insertAllocation(allocation);
      if (!repo.transitionUnit(fresh.id, 'AVAILABLE', 'ALLOCATED', fresh.locationId, now)) throw new ApiError(409, 'unit_not_available', 'unit changed');
      repo.insertEvent({ unitId: fresh.id, type: 'allocated', from: 'AVAILABLE', to: 'ALLOCATED', actor: ctx.call.principal.actor, cause: ctx.cause, orderGid, locationId: fresh.locationId, data: { source: manualSource(ctx), allocationId: id, stockWrite: false }, now });
      ctx.d.sql.exec('UPDATE uncovered_lines SET quantity = quantity - 1 WHERE fo_line_item_gid = ?', slot.foLine);
      ctx.d.sql.exec('DELETE FROM uncovered_lines WHERE fo_line_item_gid = ? AND quantity <= 0', slot.foLine);
    } else {
      const slot = target.shipped.find((s) => s.locationId === fresh.locationId)!;
      allocation = baseAllocation(id, fresh, line, slot.locationId, now, { status: 'fulfilled', source: 'late', fulfilledAt: now });
      repo.insertAllocation(allocation);
      if (!repo.transitionUnit(fresh.id, 'AVAILABLE', 'SHIPPED', fresh.locationId, now)) throw new ApiError(409, 'unit_not_available', 'unit changed');
      repo.insertEvent({ unitId: fresh.id, type: 'shipped', from: 'AVAILABLE', to: 'SHIPPED', actor: ctx.call.principal.actor, cause: ctx.cause, orderGid, locationId: fresh.locationId, data: { source: 'late', allocationId: id, stockWrite: false, reason: 'late_designation' }, now });
      ctx.d.sql.exec('UPDATE explained_quantities SET quantity = quantity - 1 WHERE id = ?', slot.id);
      ctx.d.sql.exec("UPDATE explained_quantities SET status = 'closed', closed_at = ? WHERE id = ? AND quantity <= 0", now, slot.id);
    }
    requestOrderSync(ctx.d, orderGid, 0, now);
    return allocation;
  });
}

/**
 * Source of an allocation made by a person (15.6, 11.2 `allocations.source`): `pick` (« Manuelle ») from the app
 * or an admin extension, `api` only through the public API with a key (recette 2: everything showed « API »).
 */
function manualSource(ctx: ApiContext): 'pick' | 'api' {
  return ctx.call.principal.surface === 'public' ? 'api' : 'pick';
}

function baseAllocation(id: string, unit: UnitRecord, line: LineContext, locationId: string, now: number, extra: Partial<CoreAllocation>): CoreAllocation {
  return {
    id,
    unitId: unit.id,
    variantGid: line.variantGid,
    orderGid: line.orderGid,
    lineItemGid: line.lineItemGid,
    fulfillmentOrderGid: null,
    fulfillmentOrderLineItemGid: null,
    locationId,
    status: 'active',
    source: 'api',
    returnExpected: false,
    toConfirm: false,
    allocationVersion: 1,
    allocatedAt: now,
    fulfilledAt: null,
    releasedAt: null,
    returnedAt: null,
    releaseKind: null,
    returnLineItemGid: null,
    ...extra,
  };
}

export function createAllocation(ctx: ApiContext): ApiResult {
  const body = parseBody<CreateAllocationRequest>(ctx.call);
  if (!body.orderGid || !body.lineItemGid) throw new ApiError(400, 'validation_failed', 'orderGid and lineItemGid required');
  const a = allocateToLine(ctx, orderGidOf(body.orderGid), body.lineItemGid, { unitId: body.unitId, ref: body.ref });
  return json(presentAllocation(ctx, a), 201, { ETag: allocationEtag(a.allocationVersion) });
}

function activeAllocation(ctx: ApiContext, id: string): CoreAllocation {
  const a = ctx.d.repo.allocation(id);
  if (!a) throw new ApiError(404, 'not_found', 'unknown allocation');
  checkIfMatch(ctx.call, allocationEtag(a.allocationVersion));
  if (a.status !== 'active') throw new ApiError(409, 'invalid_transition', `allocation is ${a.status}: only an allocation before shipment can change`);
  return a;
}

/** Removal before shipment (MVP 19.4 point 3): ALLOCATED → AVAILABLE, no stock write. */
export function deleteAllocation(ctx: ApiContext, id: string): ApiResult {
  const now = ctx.now;
  ctx.d.storage.transactionSync(() => {
    const a = activeAllocation(ctx, id);
    const { repo } = ctx.d;
    const unit = repo.unit(a.unitId)!;
    repo.patchAllocation(a.id, { status: 'released', releasedAt: now, releaseKind: 'manual', toConfirm: false });
    if (!repo.transitionUnit(unit.id, 'ALLOCATED', 'AVAILABLE', unit.locationId, now)) throw new ApiError(409, 'invalid_transition', 'unit changed');
    repo.insertEvent({ unitId: unit.id, type: 'released', from: 'ALLOCATED', to: 'AVAILABLE', actor: ctx.call.principal.actor, cause: ctx.cause, orderGid: a.orderGid, locationId: unit.locationId, data: { releaseKind: 'manual', allocationId: a.id, stockWrite: false }, now });
    repo.lockUnit(unit.id, 'api', `release:${a.id}`, now + MANUAL_RELEASE_LOCK_MS);
    requestOrderSync(ctx.d, a.orderGid, 0, now);
  });
  return noContent();
}

/** Replacement at packing (F4, 9.15 point 2): same line, same location, in one transaction, no stock write. */
export function replaceAllocation(ctx: ApiContext, id: string): ApiResult {
  const body = parseBody<ReplaceAllocationRequest>(ctx.call);
  const current = ctx.d.repo.allocation(id);
  if (!current) throw new ApiError(404, 'not_found', 'unknown allocation');
  const line = lineContext(ctx, current.orderGid, current.lineItemGid);
  let candidates = availableUnitsOf(ctx, line.itemId, [current.locationId]);
  if (body.ref && !body.unitId && !designateUnit(body.ref, candidatesOf(candidates), normalization(ctx)).ok) candidates = availableUnitsOf(ctx, line.itemId, null);
  const unit = resolveUnit(ctx, body, candidates);
  const now = ctx.now;
  const created = ctx.d.storage.transactionSync(() => {
    const a = activeAllocation(ctx, id);
    const fresh = ctx.d.repo.unit(unit.id)!;
    if (fresh.id === a.unitId) throw new ApiError(409, 'invalid_transition', 'this unit is already the allocated one');
    assertAllocatable(ctx, fresh, line, [a.locationId]);
    const { repo } = ctx.d;
    const old = repo.unit(a.unitId)!;
    repo.patchAllocation(a.id, { status: 'released', releasedAt: now, releaseKind: 'manual', toConfirm: false });
    if (!repo.transitionUnit(old.id, 'ALLOCATED', 'AVAILABLE', old.locationId, now)) throw new ApiError(409, 'invalid_transition', 'unit changed');
    repo.insertEvent({ unitId: old.id, type: 'released', from: 'ALLOCATED', to: 'AVAILABLE', actor: ctx.call.principal.actor, cause: ctx.cause, orderGid: a.orderGid, locationId: old.locationId, data: { releaseKind: 'manual', reason: 'replaced', allocationId: a.id, stockWrite: false }, now });
    const next = baseAllocation(newId(now), fresh, line, a.locationId, now, { status: 'active', source: manualSource(ctx), fulfillmentOrderGid: a.fulfillmentOrderGid, fulfillmentOrderLineItemGid: a.fulfillmentOrderLineItemGid });
    repo.insertAllocation(next);
    if (!repo.transitionUnit(fresh.id, 'AVAILABLE', 'ALLOCATED', fresh.locationId, now)) throw new ApiError(409, 'unit_not_available', 'unit changed');
    repo.insertEvent({ unitId: fresh.id, type: 'allocated', from: 'AVAILABLE', to: 'ALLOCATED', actor: ctx.call.principal.actor, cause: ctx.cause, orderGid: a.orderGid, locationId: fresh.locationId, data: { source: manualSource(ctx), reason: 'replacement', allocationId: next.id, stockWrite: false }, now });
    requestOrderSync(ctx.d, a.orderGid, 0, now);
    return next;
  });
  return json(presentAllocation(ctx, created), 201, { ETag: allocationEtag(created.allocationVersion) });
}

// ------------------------------------------------------------------------------------- shipment designation fix (F4, 7.2, T-MVP-10)

/**
 * Designates a unit really shipped on a line with provisionally shipped units (`toConfirm`):
 * a provisional one is confirmed, or an allocated one is swapped with a provisional one (each unit
 * keeps its allocation, the other columns are exchanged; no stock write).
 */
export function confirmShippedUnit(ctx: ApiContext, scope: { orderGid: string; lineItemGid: string; locationId: string; swapWith?: string }, ref: string): CoreAllocation {
  const now = ctx.now;
  return ctx.d.storage.transactionSync(() => {
    const { repo } = ctx.d;
    const lineAllocs = repo.orderAllocations(scope.orderGid).filter((a) => a.lineItemGid === scope.lineItemGid && a.locationId === scope.locationId);
    const provisional = lineAllocs.filter((a) => a.status === 'fulfilled' && a.toConfirm);
    if (provisional.length === 0) throw new ApiError(409, 'invalid_transition', 'no shipped unit to confirm on this line');
    const pool = lineAllocs.filter((a) => a.status === 'active' || (a.status === 'fulfilled' && a.toConfirm));
    const units = repo.unitsByIds(pool.map((a) => a.unitId));
    const result = designateUnit(ref, candidatesOf(units), normalization(ctx));
    if (!result.ok) {
      if (result.reason === 'ambiguous') throw new ApiError(409, 'ambiguous_ref', 'type the ref in full');
      throw new ApiError(404, 'unknown_ref', 'no unit of this line has this ref');
    }
    const chosen = pool.find((a) => a.unitId === result.unitId)!;
    if (chosen.status === 'fulfilled') {
      repo.patchAllocation(chosen.id, { toConfirm: false });
      repo.insertEvent({ unitId: chosen.unitId, type: 'shipment_confirmed', from: 'SHIPPED', to: 'SHIPPED', actor: ctx.call.principal.actor, cause: ctx.cause, orderGid: scope.orderGid, locationId: scope.locationId, data: { allocationId: chosen.id, stockWrite: false }, now });
      finishConfirmation(ctx, scope, now);
      return repo.allocation(chosen.id)!;
    }
    // Swap: the provisional unit X did not leave, the allocated unit Y did.
    const x = (scope.swapWith ? provisional.find((a) => a.id === scope.swapWith) : undefined) ?? provisional.sort((a, b) => b.allocatedAt - a.allocatedAt || (b.id < a.id ? -1 : 1))[0]!;
    const xUnit = repo.unit(x.unitId)!;
    const yUnit = repo.unit(chosen.unitId)!;
    repo.patchAllocation(x.id, { status: 'active', fulfilledAt: null, toConfirm: false, fulfillmentOrderGid: chosen.fulfillmentOrderGid, fulfillmentOrderLineItemGid: chosen.fulfillmentOrderLineItemGid });
    repo.patchAllocation(chosen.id, { status: 'fulfilled', fulfilledAt: x.fulfilledAt ?? now, toConfirm: false, fulfillmentOrderGid: x.fulfillmentOrderGid, fulfillmentOrderLineItemGid: x.fulfillmentOrderLineItemGid });
    if (!repo.transitionUnit(xUnit.id, 'SHIPPED', 'ALLOCATED', xUnit.locationId, now)) throw new ApiError(409, 'invalid_transition', 'unit changed');
    if (!repo.transitionUnit(yUnit.id, 'ALLOCATED', 'SHIPPED', yUnit.locationId, now)) throw new ApiError(409, 'invalid_transition', 'unit changed');
    const data = { reason: 'shipment_designation_fix', stockWrite: false };
    repo.insertEvent({ unitId: xUnit.id, type: 'shipment_designation_fixed', from: 'SHIPPED', to: 'ALLOCATED', actor: ctx.call.principal.actor, cause: ctx.cause, orderGid: scope.orderGid, locationId: scope.locationId, data: { ...data, allocationId: x.id }, now });
    repo.insertEvent({ unitId: yUnit.id, type: 'shipment_designation_fixed', from: 'ALLOCATED', to: 'SHIPPED', actor: ctx.call.principal.actor, cause: ctx.cause, orderGid: scope.orderGid, locationId: scope.locationId, data: { ...data, allocationId: chosen.id }, now });
    finishConfirmation(ctx, scope, now);
    return repo.allocation(chosen.id)!;
  });
}

function finishConfirmation(ctx: ApiContext, scope: { orderGid: string; lineItemGid: string; locationId: string }, now: number): void {
  const { repo } = ctx.d;
  const left = repo.orderAllocations(scope.orderGid).filter((a) => a.lineItemGid === scope.lineItemGid && a.locationId === scope.locationId && a.status === 'fulfilled' && a.toConfirm).length;
  const anomaly = repo.liveAnomaly('shipped_unit_to_confirm', { orderGid: scope.orderGid, lineItemGid: scope.lineItemGid, locationId: scope.locationId });
  if (anomaly && left === 0) repo.closeAnomaly(anomaly.id, 'resolved', { by: ctx.call.principal.actor }, now);
  requestOrderSync(ctx.d, scope.orderGid, 0, now);
}

export function confirmShipped(ctx: ApiContext, id: string): ApiResult {
  const body = parseBody<ConfirmShippedRequest>(ctx.call);
  if (typeof body.ref !== 'string') throw new ApiError(400, 'validation_failed', 'ref required (typed ref only, 15.5)');
  const a = ctx.d.repo.allocation(id);
  if (!a) throw new ApiError(404, 'not_found', 'unknown allocation');
  checkIfMatch(ctx.call, allocationEtag(a.allocationVersion));
  const result = confirmShippedUnit(ctx, { orderGid: a.orderGid, lineItemGid: a.lineItemGid, locationId: a.locationId, ...(a.toConfirm ? { swapWith: a.id } : {}) }, body.ref);
  return json(presentAllocation(ctx, result), 200, { ETag: allocationEtag(result.allocationVersion) });
}

// ------------------------------------------------------------------------------------- returns (EF-21, S-17)

export function identifyReturnLine(ctx: ApiContext, returnLineItemGid: string, ref: string, returnGid?: string): { unitId: string | null; result: 'identified' | 'mismatch' | 'unknown_ref' } {
  const { sql, repo } = ctx.d;
  const rl = sql
    .exec<{ return_gid: string; order_gid: string; line_item_gid: string }>('SELECT return_gid, order_gid, line_item_gid FROM return_lines WHERE return_line_gid = ?', returnLineItemGid)
    .toArray()[0];
  if (!rl || (returnGid && rl.return_gid !== returnGid && !rl.return_gid.endsWith(`/${returnGid}`))) throw new ApiError(404, 'not_found', 'unknown return line');
  const sold = repo.orderAllocations(rl.order_gid).filter((a) => a.lineItemGid === rl.line_item_gid && (a.status === 'fulfilled' || a.status === 'returned'));
  const candidates = repo.unitsByIds(sold.map((a) => a.unitId));
  const designation = designateUnit(ref, candidatesOf(candidates), normalization(ctx));
  if (!designation.ok && designation.reason === 'ambiguous') throw new ApiError(409, 'ambiguous_ref', 'type the ref in full');
  if (!designation.ok && designation.reason === 'empty') throw new ApiError(400, 'validation_failed', 'ref required');
  let unitId: string | null = designation.ok ? designation.unitId : null;
  if (!unitId) unitId = repo.lookup(normalizeIdentifier(ref, normalization(ctx)))[0]?.id ?? null;
  const now = ctx.now;
  ctx.d.storage.transactionSync(() => {
    sql.exec(
      'INSERT INTO return_identifications (id, order_gid, return_line_item_gid, unit_id, typed_ref, actor_type, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId(now),
      rl.order_gid,
      returnLineItemGid,
      unitId,
      ref,
      ctx.call.principal.actor.type,
      ctx.call.principal.actor.id,
      now,
    );
    requestOrderSync(ctx.d, rl.order_gid, 0, now);
  });
  return { unitId, result: designation.ok ? 'identified' : unitId ? 'mismatch' : 'unknown_ref' };
}

export function identifyReturn(ctx: ApiContext, returnParam: string): ApiResult {
  const body = parseBody<IdentifyReturnRequest>(ctx.call);
  if (!body.returnLineItemGid || typeof body.ref !== 'string') throw new ApiError(400, 'validation_failed', 'returnLineItemGid and ref required');
  const out = identifyReturnLine(ctx, body.returnLineItemGid, body.ref, decodeURIComponent(returnParam));
  return json({ returnLineItemGid: body.returnLineItemGid, ...out }, 202);
}

// ------------------------------------------------------------------------------------- anomalies (EF-30, 12.7)

export function listAnomalies(ctx: ApiContext): ApiResult {
  const limit = pageLimit(ctx.call);
  const statusParam = queryOne(ctx.call, 'status');
  const status = statusParam === 'resolved' ? ['resolved', 'auto_resolved'] : statusParam ? statusParam.split(',') : undefined;
  const order = queryOne(ctx.call, 'order');
  const rows = ctx.d.repo.listAnomalies({
    ...(status ? { status } : {}),
    ...(queryOne(ctx.call, 'severity') ? { severity: queryOne(ctx.call, 'severity')! } : {}),
    ...(queryOne(ctx.call, 'type') ? { type: queryOne(ctx.call, 'type')! } : {}),
    ...(order ? { orderGid: orderGidOf(order) } : {}),
    ...(decodeCursor(queryOne(ctx.call, 'cursor')) ? { after: decodeCursor(queryOne(ctx.call, 'cursor'))! } : {}),
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  return json({ items: page.map((a) => presentAnomaly(ctx, a)), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.id) : null });
}

function liveAnomaly(ctx: ApiContext, id: string) {
  const a = ctx.d.repo.anomaly(id);
  if (!a) throw new ApiError(404, 'not_found', 'unknown anomaly');
  return a;
}

export function acknowledgeAnomaly(ctx: ApiContext, id: string): ApiResult {
  liveAnomaly(ctx, id);
  ctx.d.repo.acknowledgeAnomaly(id, ctx.now);
  return json(presentAnomaly(ctx, ctx.d.repo.anomaly(id)!));
}

/** MVP resolutions of 12.7; each one calls the same code as the matching resource (14.2). */
export async function resolveAnomaly(ctx: ApiContext, id: string): Promise<ApiResult> {
  const body = parseBody<ResolveAnomalyRequest>(ctx.call);
  const a = liveAnomaly(ctx, id);
  if (a.status !== 'open' && a.status !== 'acknowledged') throw new ApiError(409, 'invalid_transition', 'anomaly already resolved');
  const params = body.params ?? {};
  const ref = typeof params.ref === 'string' ? params.ref : undefined;
  const s = a.subject;
  const actor = ctx.call.principal.actor;
  const actions = presentAnomaly(ctx, a).actions;
  const allowed = new Set(['dismiss', ...actions.map((x) => x.action)]);
  if (!allowed.has(body.action)) throw new ApiError(422, 'validation_failed', `action ${body.action} is not a resolution of ${a.type}`);
  // 15.8: resolutions that write the Shopify stock (or relaunch or abandon a write) are administration actions.
  if (actions.some((x) => x.action === body.action && x.writesStock)) requireAdmin(ctx);
  switch (body.action) {
    case 'allocate':
    case 'designate':
      if (!s.orderGid || !s.lineItemGid) throw new ApiError(422, 'validation_failed', 'anomaly without order line');
      allocateToLine(ctx, s.orderGid, s.lineItemGid, { ref, unitId: typeof params.unitId === 'string' ? params.unitId : undefined });
      settleOne(ctx, a.id);
      break;
    case 'confirm_shipped':
      if (!s.orderGid || !s.lineItemGid || !s.locationId || !ref) throw new ApiError(422, 'validation_failed', 'ref required');
      confirmShippedUnit(ctx, { orderGid: s.orderGid, lineItemGid: s.lineItemGid, locationId: s.locationId }, ref);
      break;
    case 'identify': {
      if (!s.returnLineItemGid || !ref) throw new ApiError(422, 'validation_failed', 'ref required');
      identifyReturnLine(ctx, s.returnLineItemGid, ref);
      // A ref of another unit (or an unknown ref) is an identification too: return_unit_mismatch takes over (F6 1 bis).
      settleOne(ctx, a.id);
      break;
    }
    case 'restock':
    case 'lose':
    case 'scrap':
      await resolveToVerify(ctx, a.id, body.action);
      break;
    case 'recheck': {
      const item = s.trackedItemId ? ctx.d.repo.trackedItem(s.trackedItemId) : null;
      if (item && s.locationId) ctx.d.storage.transactionSync(() => requestLevelCheck(ctx.d, item.inventoryItemGid, s.locationId!, 0, ctx.now));
      break;
    }
    case 'dismiss':
      ctx.d.repo.closeAnomaly(a.id, 'resolved', { action: 'dismiss', by: actor }, ctx.now);
      break;
  }
  return json(presentAnomaly(ctx, ctx.d.repo.anomaly(id)!));
}

/**
 * One unit of the anomaly's quantity is settled by the action: the anomaly is closed when it was
 * the last one, its quantity lowered otherwise. The next synchronization confirms (or reopens) it.
 */
function settleOne(ctx: ApiContext, anomalyId: string): void {
  const { repo } = ctx.d;
  const a = repo.anomaly(anomalyId);
  if (!a || (a.status !== 'open' && a.status !== 'acknowledged')) return;
  const quantity = typeof a.details.quantity === 'number' ? a.details.quantity : 1;
  if (quantity <= 1) repo.closeAnomaly(a.id, 'resolved', { by: ctx.call.principal.actor }, ctx.now);
  else repo.updateAnomalyDetails(a.id, { ...a.details, quantity: quantity - 1 }, ctx.now);
}

/** Unit to verify (F3, F5, 8.1): put back in stock (one write at most: level re-read in the outbox), or declare lost / scrapped without write. */
async function resolveToVerify(ctx: ApiContext, anomalyId: string, action: 'restock' | 'lose' | 'scrap'): Promise<void> {
  const { repo } = ctx.d;
  const a = repo.anomaly(anomalyId)!;
  const unit = a.subject.unitId ? repo.unit(a.subject.unitId) : null;
  if (!unit) throw new ApiError(422, 'validation_failed', 'anomaly without unit');
  if (unit.status !== 'TO_VERIFY') throw new ApiError(409, 'invalid_transition', `unit is ${unit.status}`);
  const item = repo.trackedItem(unit.trackedItemId);
  if (!item) throw new ApiError(422, 'not_tracked', 'unit of an unknown item');
  const level = action === 'restock' && unit.locationId ? await readLevel(ctx.d.client(), item.inventoryItemGid, unit.locationId) : null;
  const now = ctx.now;
  ctx.d.storage.transactionSync(() => {
    const fresh = repo.unit(unit.id)!;
    if (fresh.status !== 'TO_VERIFY') throw new ApiError(409, 'invalid_transition', `unit is ${fresh.status}`);
    const to = action === 'restock' ? 'AVAILABLE' : action === 'lose' ? 'LOST' : 'SCRAPPED';
    if (!repo.transitionUnit(fresh.id, 'TO_VERIFY', to, fresh.locationId, now)) throw new ApiError(409, 'invalid_transition', 'unit changed');
    repo.insertEvent({ unitId: fresh.id, type: action === 'restock' ? 'verified_restocked' : action === 'lose' ? 'lost' : 'scrapped', from: 'TO_VERIFY', to, actor: ctx.call.principal.actor, cause: ctx.cause, locationId: fresh.locationId, data: { reason: `unit_to_verify:${action}` }, now });
    if (action === 'restock' && fresh.locationId) {
      if (level) storeLevel(ctx.d, item, fresh.locationId, level, now);
      // +1 available only if Shopify did not restock it already (usable deficit, 8.1): decided by the outbox on a re-read level.
      ctx.d.queueOutbox(stockWriteInput({ type: 'stock', op: 'adjust', trackedItemId: item.id, inventoryItemGid: item.inventoryItemGid, locationId: fresh.locationId, name: 'available', delta: 1, guard: 'deficit', reason: 'restock', unitIds: [fresh.id] }), now);
      for (const r of ctx.d.sql.exec<{ order_gid: string }>('SELECT DISTINCT order_gid FROM uncovered_lines WHERE tracked_item_id = ? AND location_id = ?', item.id, fresh.locationId).toArray()) {
        requestOrderSync(ctx.d, r.order_gid, 0, now);
      }
      const freshItem = repo.trackedItem(item.id);
      if (freshItem) evaluateLevel(ctx.d, freshItem, fresh.locationId, now);
    }
    repo.closeAnomaly(anomalyId, 'resolved', { action, by: ctx.call.principal.actor }, now);
  });
}
