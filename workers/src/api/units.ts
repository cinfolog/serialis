/**
 * Tracked items, units, refs and CSV imports (spec 6.1, 9.10, 14.2; MVP 19.4 points 1, 2, 5).
 */
import {
  DEFAULT_NORMALIZATION,
  normalizeIdentifier,
  resolveSetting,
  uniquenessScopeKey,
  validateIdentifier,
  type UnitState,
} from '@serialis/core';
import type {
  CheckUnitsBatchResponse,
  CreateImportRequest,
  CreateUnitsBatchRequest,
  CreateUnitsBatchResponse,
  ErrorCode,
  ImportReport,
  ImportReportExtras,
  Page,
  RefCheckStatus,
  TrackItemsRequest,
  Unit,
  UnitEvent,
  UntrackItemsRequest,
} from '@serialis/contract';
import { UNIT_STATES } from '@serialis/core';
import { evaluateLevel, storeLevel } from '../domain/levels.js';
import { ensureReconciliation } from '../domain/reconcile.js';
import type { TrackedItemRow } from '../domain/repo.js';
import { listOrders, readLevel, readLocations, readVariants, type LevelRead } from '../domain/shopify-read.js';
import { requestOrderSync } from '../domain/sync-order.js';
import { newId, parseJson, placeholders } from '../domain/util.js';
import { stockWriteInput } from '../domain/writes.js';
import { ApiError, checkIfMatch, decodeCursor, encodeCursor, json, pageLimit, parseBody, queryList, queryOne, unitEtag, type ApiResult } from './http.js';
import { presentTrackedItem, presentUnit, type ApiContext } from './present.js';
import { firstNameOf } from './users.js';

const IDENTIFIER_TYPE = 'serial';
const MAX_REF_LENGTH = 128;
const MAX_BATCH = 1_000;
const MAX_IMPORT_ROWS = 5_000;

// ------------------------------------------------------------------------------------- tracked items

export function listTrackedItems(ctx: ApiContext): ApiResult {
  const { sql, repo } = ctx.d;
  const variant = queryOne(ctx.call, 'variant');
  const product = queryOne(ctx.call, 'product');
  const limit = pageLimit(ctx.call);
  const after = decodeCursor(queryOne(ctx.call, 'cursor'));
  const where = ['active = 1'];
  const binds: SqlStorageValue[] = [];
  if (variant) {
    where.push('variant_gid = ?');
    binds.push(variant);
  }
  if (product) {
    where.push('product_gid = ?');
    binds.push(product);
  }
  if (after) {
    where.push('id > ?');
    binds.push(after);
  }
  const ids = sql
    .exec<{ id: string }>(`SELECT id FROM tracked_items WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`, ...binds, limit + 1)
    .toArray()
    .map((r) => r.id);
  const page = ids.slice(0, limit);
  const items = repo.itemsByIds(page).sort((a, b) => (a.id < b.id ? -1 : 1));
  return json({ items: items.map((i) => presentTrackedItem(ctx, i)), nextCursor: ids.length > limit ? encodeCursor(page[page.length - 1]!) : null });
}

function gidList(value: unknown, type: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new ApiError(400, 'validation_failed', 'variantGids: 1 to 100 ids');
  return value.map((v) => {
    const s = String(v);
    if (/^\d+$/.test(s)) return `gid://shopify/${type}/${s}`;
    if (!new RegExp(`^gid://shopify/${type}/\\d+$`).test(s)) throw new ApiError(400, 'validation_failed', `invalid ${type} id ${s}`);
    return s;
  });
}

/** `POST /tracked-items`: activates tracking (initialization phase, S-24 fixed to "do not block") or, with `action: 'untrack'`, deactivates it. */
export async function trackItems(ctx: ApiContext): Promise<ApiResult> {
  const body = parseBody<TrackItemsRequest | UntrackItemsRequest | (TrackItemsRequest & { action?: 'track' })>(ctx.call);
  if ('action' in body && body.action === 'untrack') return untrackItems(ctx, gidList(body.variantGids, 'ProductVariant'));
  const req = body as TrackItemsRequest;
  const variantGids = gidList(req.variantGids, 'ProductVariant');
  const applyToOpenOrders = req.applyToOpenOrders === true;
  const { repo } = ctx.d;
  const toActivate = variantGids.filter((v) => !repo.activeItemByVariant(v));
  if (toActivate.length === 0) {
    return json({ items: repo.itemsByVariants(variantGids).map((i) => presentTrackedItem(ctx, i)), nextCursor: null });
  }
  const client = ctx.d.client();
  const variants = await readVariants(client, toActivate);
  const missing = toActivate.filter((v) => !variants.has(v));
  if (missing.length > 0) throw new ApiError(404, 'not_found', `unknown variant ${missing[0]}`);
  const untracked = toActivate.filter((v) => !variants.get(v)!.tracked);
  if (untracked.length > 0) {
    // EF-01 guard: Shopify inventory tracking must be on (the app proposes to turn it on).
    throw new ApiError(422, 'validation_failed', `inventory tracking is off in Shopify for ${untracked.join(', ')}`, untracked.map((v) => ({ field: 'variantGids', code: 'validation_failed' as ErrorCode, detail: v })));
  }
  // Open orders that already contain the variants: their lines are `preexisting` (S-24 fixed, EF-01) or synchronized.
  const { orders } = await listOrders(client, 'status:open');
  const now = Date.now();
  ctx.d.storage.transactionSync(() => {
    for (const v of toActivate) {
      if (repo.activeItemByVariant(v)) continue; // concurrent activation
      const info = variants.get(v)!;
      const item = repo.insertTrackedItem({
        productGid: info.productGid,
        variantGid: v,
        inventoryItemGid: info.inventoryItemGid,
        productTitle: info.productTitle,
        variantTitle: info.title,
        sku: info.sku,
        applyToOpenOrders,
        now,
      });
      // Units of a former item of the same variant come back to this one (EF-01, reactivation).
      ctx.d.sql.exec(
        'UPDATE units SET tracked_item_id = ? WHERE tracked_item_id IN (SELECT id FROM tracked_items WHERE variant_gid = ? AND active = 0)',
        item.id,
        v,
      );
      for (const l of info.levels) {
        repo.upsertLocation({ id: l.locationId, name: l.locationName, active: l.locationActive }, now);
        repo.saveLevel(
          item.id,
          l.locationId,
          {
            active: l.active,
            onHand: l.q.on_hand,
            available: l.q.available,
            committed: l.q.committed,
            reserved: l.q.reserved,
            qualityControl: l.q.quality_control,
            damaged: l.q.damaged,
            safetyStock: l.q.safety_stock,
          },
          now,
        );
      }
      for (const o of orders) {
        for (const line of o.lines) {
          if (line.variantGid !== v) continue;
          if (applyToOpenOrders) {
            requestOrderSync(ctx.d, o.orderGid, 0, now);
          } else {
            ctx.d.sql.exec(
              "INSERT INTO order_line_tracking (order_gid, line_item_gid, tracked_item_id, mode) VALUES (?, ?, ?, 'preexisting') ON CONFLICT DO NOTHING",
              o.orderGid,
              line.gid,
              item.id,
            );
            requestOrderSync(ctx.d, o.orderGid, 0, now);
          }
        }
      }
      repo.audit(ctx.call.principal.actor, 'tracked_item.activate', null, { variantGid: v, applyToOpenOrders }, now);
      evaluateItem(ctx, item, now);
    }
    ensureReconciliation(ctx.d, now);
  });
  return json({ items: repo.itemsByVariants(variantGids).map((i) => presentTrackedItem(ctx, i)), nextCursor: null });
}

/** Initialization end check of every known level of an item (EF-01, S-25). */
function evaluateItem(ctx: ApiContext, item: TrackedItemRow, now: number): void {
  for (const l of ctx.d.repo.levelsOfItem(item.id)) {
    const fresh = ctx.d.repo.trackedItem(item.id);
    if (fresh) evaluateLevel(ctx.d, fresh, l.locationId, now);
  }
}

/** EF-01: deactivation, refused while units are allocated, in transit or awaiting a return; units in stock become UNTRACKED without write. */
function untrackItems(ctx: ApiContext, variantGids: string[]): ApiResult {
  const { repo, sql } = ctx.d;
  const now = Date.now();
  ctx.d.storage.transactionSync(() => {
    for (const v of variantGids) {
      const item = repo.activeItemByVariant(v);
      if (!item) continue;
      const blocking = sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM units WHERE tracked_item_id = ? AND status IN ('ALLOCATED', 'IN_TRANSIT', 'RETURN_PENDING')", item.id)
        .one().n;
      if (blocking > 0) throw new ApiError(409, 'invalid_transition', `${blocking} unit(s) allocated, in transit or awaiting a return for ${v}`);
      const toUntrack = sql
        .exec<{ id: string; status: UnitState; location_id: string | null }>(
          "SELECT id, status, location_id FROM units WHERE tracked_item_id = ? AND status IN ('AVAILABLE', 'HELD', 'QUALITY_CONTROL', 'DAMAGED', 'INCOMING', 'TO_VERIFY')",
          item.id,
        )
        .toArray();
      for (const u of toUntrack) {
        if (!repo.transitionUnit(u.id, u.status, 'UNTRACKED', u.location_id, now)) throw new ApiError(409, 'invalid_transition', `unit ${u.id} changed`);
        repo.insertEvent({ unitId: u.id, type: 'untracked', from: u.status, to: 'UNTRACKED', actor: ctx.call.principal.actor, cause: ctx.cause, locationId: u.location_id, now });
      }
      repo.deactivateItem(item.id, now);
      repo.audit(ctx.call.principal.actor, 'tracked_item.deactivate', { variantGid: v }, null, now);
    }
  });
  return json({ items: repo.itemsByVariants(variantGids).map((i) => presentTrackedItem(ctx, i)), nextCursor: null });
}

// ------------------------------------------------------------------------------------- units

export function listUnits(ctx: ApiContext): ApiResult {
  const { sql, repo } = ctx.d;
  const limit = pageLimit(ctx.call);
  const where: string[] = [];
  const binds: SqlStorageValue[] = [];
  const variant = queryOne(ctx.call, 'variant');
  if (variant) {
    where.push('u.variant_gid = ?');
    binds.push(variant);
  }
  const location = queryOne(ctx.call, 'location');
  if (location) {
    where.push('u.location_id = ?');
    binds.push(location);
  }
  const states = queryList(ctx.call, 'state');
  for (const s of states) if (!(UNIT_STATES as readonly string[]).includes(s)) throw new ApiError(400, 'validation_failed', `unknown state ${s}`);
  if (states.length > 0) {
    where.push(`u.status IN (${placeholders(states.length)})`);
    binds.push(...states);
  }
  const q = queryOne(ctx.call, 'q');
  if (q) {
    // Prefix search by range on value_norm (12.4: no LIKE on long patterns).
    const norm = normalizeIdentifier(q, normalizationOf(ctx));
    where.push('u.id IN (SELECT unit_id FROM unit_identifiers WHERE value_norm >= ? AND value_norm < ?)');
    binds.push(norm, `${norm}￿`);
  }
  const after = decodeCursor(queryOne(ctx.call, 'cursor'));
  if (after) {
    where.push('u.id > ?');
    binds.push(after);
  }
  const rows = sql
    .exec<{ id: string }>(`SELECT u.id FROM units u ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY u.id LIMIT ?`, ...binds, limit + 1)
    .toArray()
    .map((r) => r.id);
  const page = rows.slice(0, limit);
  const units = repo.unitsByIds(page).sort((a, b) => (a.id < b.id ? -1 : 1));
  const result: Page<Unit> = { items: units.map((u) => presentUnit(ctx, u)), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null };
  return json(result);
}

export function getUnit(ctx: ApiContext, id: string): ApiResult {
  const u = ctx.d.repo.unit(id);
  if (!u) throw new ApiError(404, 'not_found', 'unknown unit');
  checkIfMatch(ctx.call, unitEtag(u.version));
  return json(presentUnit(ctx, u), 200, { ETag: unitEtag(u.version) });
}

export function lookup(ctx: ApiContext): ApiResult {
  const value = queryOne(ctx.call, 'identifier') ?? queryOne(ctx.call, 'q');
  if (!value) throw new ApiError(400, 'validation_failed', 'identifier required');
  const norm = normalizeIdentifier(value, normalizationOf(ctx));
  const found = ctx.d.repo.lookup(norm);
  // An active identifier wins over a retired one (EF-08: old values stay findable).
  const unit = found[0] ?? null;
  return json({ unit: unit ? presentUnit(ctx, unit) : null });
}

const ACTOR_LABEL: Record<string, string> = { system: 'system', shopify: 'system', api_key: 'api', user: 'user' };

export function unitEvents(ctx: ApiContext, id: string): ApiResult {
  const { sql, repo } = ctx.d;
  if (!repo.unit(id)) throw new ApiError(404, 'not_found', 'unknown unit');
  const limit = pageLimit(ctx.call);
  const after = decodeCursor(queryOne(ctx.call, 'cursor'));
  const rows = sql
    .exec<{ id: number; type: string; from_status: UnitState | null; to_status: UnitState | null; actor_type: string; actor_id: string | null; cause_type: string; data: string; occurred_at: number; location_id: string | null }>(
      `SELECT * FROM unit_events WHERE unit_id = ? ${after ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
      ...(after ? [id, Number(after), limit + 1] : [id, limit + 1]),
    )
    .toArray();
  const page = rows.slice(0, limit);
  const items: UnitEvent[] = page.map((r) => {
    const data = parseJson<Record<string, unknown>>(r.data, {});
    const delta = typeof data.stockDelta === 'number' ? data.stockDelta : null;
    return {
      id: String(r.id),
      at: new Date(r.occurred_at).toISOString(),
      // 15.8: a person is shown by first name when known.
      actor: (r.actor_type === 'user' ? firstNameOf(ctx.d, r.actor_id) : null) ?? ACTOR_LABEL[r.actor_type] ?? r.actor_type,
      type: r.type,
      fromState: r.from_status,
      toState: r.to_status,
      reason: typeof data.reason === 'string' ? data.reason : typeof data.releaseKind === 'string' ? data.releaseKind : typeof data.disposition === 'string' ? data.disposition : null,
      stockEffect: delta === null ? (data.stockWrite === false ? 'no write' : null) : `${delta > 0 ? '+' : ''}${delta} ${String(data.quantityName ?? 'available')}`,
    };
  });
  return json({ items, nextCursor: rows.length > limit ? encodeCursor(String(page[page.length - 1]!.id)) : null });
}

// ------------------------------------------------------------------------------------- refs (batch)

function normalizationOf(ctx: ApiContext) {
  return resolveSetting('S-36', { identifierType: IDENTIFIER_TYPE }, ctx.d.repo.storedSettings()) ?? DEFAULT_NORMALIZATION;
}

interface RowCheck {
  index: number;
  ref: string;
  status: RefCheckStatus;
  detail?: string;
  valueNorm: string;
}

interface BatchPlan {
  item: TrackedItemRow;
  locationId: string;
  rows: RowCheck[];
  gapBefore: number | null;
  level: LevelRead | null;
}

const ROW_CODE: Record<Exclude<RefCheckStatus, 'ready'>, ErrorCode> = {
  duplicate_in_list: 'identifier_conflict',
  already_known: 'identifier_conflict',
  invalid_format: 'validation_failed',
  beyond_gap: 'validation_failed',
};

function validateBatchRequest(body: CreateUnitsBatchRequest): void {
  if (typeof body.variantGid !== 'string' || typeof body.locationId !== 'string') throw new ApiError(400, 'validation_failed', 'variantGid and locationId required');
  if (!Array.isArray(body.refs) || body.refs.length === 0 || body.refs.length > MAX_BATCH) throw new ApiError(400, 'validation_failed', `refs: 1 to ${MAX_BATCH} values`);
  if (typeof body.alreadyCounted !== 'boolean') throw new ApiError(400, 'validation_failed', 'alreadyCounted must be a boolean');
}

/** Reads what a batch needs from Shopify (the level at the location, the locations list if unknown). Network, before the transaction. */
async function readBatchContext(ctx: ApiContext, variantGid: string, locationId: string): Promise<{ item: TrackedItemRow; level: LevelRead | null }> {
  const { repo } = ctx.d;
  const item = repo.activeItemByVariant(variantGid);
  if (!item) throw new ApiError(422, 'not_tracked', `variant ${variantGid} is not tracked`);
  if (!repo.location(locationId)) {
    const now = Date.now();
    const locations = await readLocations(ctx.d.client());
    for (const l of locations) repo.upsertLocation({ id: l.id, name: l.name, active: l.isActive }, now);
    if (!repo.location(locationId)) throw new ApiError(422, 'validation_failed', `unknown location ${locationId}`);
  }
  const level = await readLevel(ctx.d.client(), item.inventoryItemGid, locationId);
  return { item, level };
}

/** Usable deficit for AVAILABLE (7.2 "unité déjà comptée"): what Shopify counts and the units do not. */
function availableGap(ctx: ApiContext, item: TrackedItemRow, locationId: string, level: LevelRead | null): number | null {
  if (!level) return null;
  if (!level.exists) return 0;
  const c = ctx.d.repo.countedUnits(item.id, locationId);
  const explained = ctx.d.repo
    .explainedFor(item.id, locationId)
    .filter((e) => e.direction === 'deficit' && e.inventoryState === 'available')
    .reduce((s, e) => s + e.quantity, 0);
  return level.q.available + level.q.committed + level.q.reserved + level.q.safety_stock - (c.AVAILABLE + c.ALLOCATED + c.HELD) - explained;
}

/** Row-by-row check of a batch (synchronous: re-run inside the creating transaction). */
function checkBatch(ctx: ApiContext, item: TrackedItemRow, locationId: string, refs: string[], alreadyCounted: boolean, level: LevelRead | null): BatchPlan {
  const settings = ctx.d.repo.storedSettings();
  const normalization = resolveSetting('S-36', { identifierType: IDENTIFIER_TYPE }, settings);
  const rule = resolveSetting('S-37', { identifierType: IDENTIFIER_TYPE }, settings);
  const regex = ctx.d.repo.identifierTypes().find((t) => t.key === IDENTIFIER_TYPE)?.regex ?? undefined;
  const scopeKey = uniquenessScopeKey(resolveSetting('S-35', { identifierType: IDENTIFIER_TYPE }, settings), item.productGid);
  const seen = new Set<string>();
  const gapBefore = availableGap(ctx, item, locationId, level);
  let gapLeft = gapBefore ?? 0;
  const rows: RowCheck[] = refs.map((raw, index) => {
    const ref = String(raw ?? '');
    const valueNorm = normalizeIdentifier(ref, normalization);
    // eslint-disable-next-line no-control-regex
    if (ref.length > MAX_REF_LENGTH || /[\u0000-\u001f\u007f]/.test(ref)) return { index, ref, status: 'invalid_format', detail: 'too_long_or_control_char', valueNorm };
    const valid = validateIdentifier(valueNorm, rule, regex);
    if (!valid.ok) return { index, ref, status: 'invalid_format', detail: valid.reason, valueNorm };
    if (seen.has(valueNorm)) return { index, ref, status: 'duplicate_in_list', valueNorm };
    seen.add(valueNorm);
    if (ctx.d.repo.identifierTaken(IDENTIFIER_TYPE, scopeKey, valueNorm)) return { index, ref, status: 'already_known', valueNorm };
    if (alreadyCounted) {
      if (gapLeft <= 0) return { index, ref, status: 'beyond_gap', detail: 'no_usable_deficit', valueNorm };
      gapLeft -= 1;
    }
    return { index, ref, status: 'ready', valueNorm };
  });
  return { item, locationId, rows, gapBefore, level };
}

export async function checkUnitsBatch(ctx: ApiContext): Promise<ApiResult> {
  const body = parseBody<CreateUnitsBatchRequest>(ctx.call);
  validateBatchRequest(body);
  const { item, level } = await readBatchContext(ctx, body.variantGid, body.locationId);
  const plan = checkBatch(ctx, item, body.locationId, body.refs, body.alreadyCounted, level);
  const ready = plan.rows.filter((r) => r.status === 'ready').length;
  const response: CheckUnitsBatchResponse = {
    rows: plan.rows.map((r) => ({ index: r.index, ref: r.ref, status: r.status, ...(r.detail ? { detail: r.detail } : {}) })),
    ready,
    stockWrite: body.alreadyCounted ? 0 : ready,
    gapBefore: plan.gapBefore,
  };
  return json(response);
}

/** Creates the ready rows of a plan (inside a transaction). Received units get one grouped `available` write (9.10). */
function createPlannedUnits(ctx: ApiContext, plan: BatchPlan, alreadyCounted: boolean, now: number): string[] {
  const { repo } = ctx.d;
  const settings = repo.storedSettings();
  const scopeKey = uniquenessScopeKey(resolveSetting('S-35', { identifierType: IDENTIFIER_TYPE }, settings), plan.item.productGid);
  const created: string[] = [];
  for (const r of plan.rows) {
    if (r.status !== 'ready') continue;
    const id = repo.insertUnit({
      trackedItem: plan.item,
      locationId: plan.locationId,
      status: 'AVAILABLE',
      identifier: { type: IDENTIFIER_TYPE, value: r.ref.trim(), valueNorm: r.valueNorm, scopeKey },
      receivedAt: now,
      now,
    });
    repo.insertEvent({
      unitId: id,
      type: 'created',
      from: null,
      to: 'AVAILABLE',
      actor: ctx.call.principal.actor,
      cause: ctx.cause,
      locationId: plan.locationId,
      data: alreadyCounted ? { reason: 'already_counted', stockWrite: false } : { reason: 'received', stockDelta: 1, quantityName: 'available' },
      now,
    });
    created.push(id);
  }
  if (created.length > 0 && !alreadyCounted) {
    if (plan.level && (!plan.level.exists || !plan.level.active)) {
      // 2026-04: a write where the item is not stocked creates an inactive level; activate first (spec 8).
      ctx.d.queueOutbox(stockWriteInput({ type: 'stock', op: 'activate', trackedItemId: plan.item.id, inventoryItemGid: plan.item.inventoryItemGid, locationId: plan.locationId, name: 'available', delta: 0, guard: 'none', reason: 'received', unitIds: [] }), now);
    }
    ctx.d.queueOutbox(
      stockWriteInput({
        type: 'stock',
        op: 'adjust',
        trackedItemId: plan.item.id,
        inventoryItemGid: plan.item.inventoryItemGid,
        locationId: plan.locationId,
        name: 'available',
        delta: created.length,
        guard: 'deficit',
        reason: 'received',
        unitIds: created,
      }),
      now,
    );
  }
  if (created.length > 0) {
    // Orders waiting for a unit at this location get it now (T-MVP-04, 19.4 "dès qu'une unité est disponible").
    for (const r of ctx.d.sql
      .exec<{ order_gid: string }>('SELECT DISTINCT order_gid FROM uncovered_lines WHERE tracked_item_id = ? AND location_id = ?', plan.item.id, plan.locationId)
      .toArray()) {
      requestOrderSync(ctx.d, r.order_gid, 0, now);
    }
  }
  return created;
}

export async function createUnitsBatch(ctx: ApiContext): Promise<ApiResult> {
  const body = parseBody<CreateUnitsBatchRequest>(ctx.call);
  validateBatchRequest(body);
  const mode = body.mode ?? 'per_item';
  if (mode !== 'atomic' && mode !== 'per_item') throw new ApiError(400, 'validation_failed', 'mode must be atomic or per_item');
  const { item, level } = await readBatchContext(ctx, body.variantGid, body.locationId);
  const now = Date.now();
  const outcome = ctx.d.storage.transactionSync(() => {
    const plan = checkBatch(ctx, item, body.locationId, body.refs, body.alreadyCounted, level);
    const rejected = plan.rows.filter((r) => r.status !== 'ready');
    if (mode === 'atomic' && rejected.length > 0) return { plan, rejected, created: [] as string[] };
    if (level) storeLevel(ctx.d, item, body.locationId, level, now);
    const created = createPlannedUnits(ctx, plan, body.alreadyCounted, now);
    const fresh = ctx.d.repo.trackedItem(item.id);
    if (fresh && level) evaluateLevel(ctx.d, fresh, body.locationId, now);
    return { plan, rejected, created };
  });
  const errors = outcome.rejected.map((r) => ({ index: r.index, ref: r.ref, code: ROW_CODE[r.status as Exclude<RefCheckStatus, 'ready'>], detail: r.detail ?? r.status }));
  if (mode === 'atomic' && errors.length > 0) {
    throw new ApiError(422, errors.every((e) => e.code === 'identifier_conflict') ? 'identifier_conflict' : 'validation_failed', `${errors.length} ref(s) refused, nothing created`, errors.map((e) => ({ index: e.index, field: 'refs', code: e.code, detail: e.detail })));
  }
  const response: CreateUnitsBatchResponse = { created: ctx.d.repo.unitsByIds(outcome.created).map((u) => presentUnit(ctx, u, null)), rejected: errors };
  return json(response, 201);
}

// ------------------------------------------------------------------------------------- CSV import (9.10, MVP simple import)

interface ImportRow {
  row: number;
  ref: string;
  variantGid: string | null;
  locationId: string | null;
  alreadyCounted: boolean;
  error?: { code: ErrorCode; detail: string };
}

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

function parseBool(v: string | undefined): boolean | null {
  const s = (v ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'oui', 'y', 'o', 'already_counted', 'deja_compte', 'déjà comptée'].includes(s)) return true;
  if (['0', 'false', 'no', 'non', 'n', '', 'received', 'recue', 'reçue'].includes(s)) return false;
  return null;
}

function parseCsv(ctx: ApiContext, csv: string): ImportRow[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new ApiError(422, 'validation_failed', 'CSV needs a header and at least one row');
  if (lines.length - 1 > MAX_IMPORT_ROWS) throw new ApiError(422, 'validation_failed', `at most ${MAX_IMPORT_ROWS} rows per import`);
  const sep = (lines[0]!.match(/;/g)?.length ?? 0) > (lines[0]!.match(/,/g)?.length ?? 0) ? ';' : ',';
  const header = splitCsvLine(lines[0]!, sep).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  if (col('ref') < 0 || col('location') < 0 || (col('sku') < 0 && col('variant_id') < 0)) {
    throw new ApiError(422, 'validation_failed', 'header must contain ref, sku or variant_id, location, already_counted');
  }
  const { repo } = ctx.d;
  const items = repo.activeItems();
  const locations = repo.locations();
  return lines.slice(1).map((line, i) => {
    const cells = splitCsvLine(line, sep);
    const row = i + 2;
    const ref = cells[col('ref')] ?? '';
    const variantCell = col('variant_id') >= 0 ? (cells[col('variant_id')] ?? '') : '';
    const skuCell = col('sku') >= 0 ? (cells[col('sku')] ?? '') : '';
    let variantGid: string | null = null;
    if (variantCell) variantGid = /^\d+$/.test(variantCell) ? `gid://shopify/ProductVariant/${variantCell}` : variantCell;
    else if (skuCell) variantGid = items.find((it) => it.sku === skuCell)?.variantGid ?? null;
    const locCell = cells[col('location')] ?? '';
    const location =
      locations.find((l) => l.id === locCell) ??
      locations.find((l) => /^\d+$/.test(locCell) && l.id === `gid://shopify/Location/${locCell}`) ??
      locations.find((l) => l.name.toLowerCase() === locCell.toLowerCase());
    const counted = parseBool(col('already_counted') >= 0 ? cells[col('already_counted')] : '');
    const out: ImportRow = { row, ref, variantGid, locationId: location?.id ?? null, alreadyCounted: counted ?? false };
    if (!ref) out.error = { code: 'validation_failed', detail: 'empty_ref' };
    else if (!variantGid || !items.some((it) => it.variantGid === variantGid)) out.error = { code: 'not_tracked', detail: 'unknown_or_untracked_variant' };
    else if (!location) out.error = { code: 'validation_failed', detail: 'unknown_location' };
    else if (counted === null) out.error = { code: 'validation_failed', detail: 'invalid_already_counted' };
    return out;
  });
}

interface ImportSimulation {
  rows: ImportRow[];
  errors: ImportReport['errors'];
  valid: number;
  beyondGap: number;
  stockWrites: number;
  groups: Map<string, { item: TrackedItemRow; locationId: string; alreadyCounted: boolean; level: LevelRead | null; rows: ImportRow[] }>;
}

async function simulateImport(ctx: ApiContext, rows: ImportRow[]): Promise<ImportSimulation> {
  const { repo } = ctx.d;
  const groups: ImportSimulation['groups'] = new Map();
  for (const r of rows) {
    if (r.error) continue;
    const key = `${r.variantGid}|${r.locationId}|${r.alreadyCounted}`;
    let g = groups.get(key);
    if (!g) {
      const item = repo.activeItemByVariant(r.variantGid!)!;
      g = { item, locationId: r.locationId!, alreadyCounted: r.alreadyCounted, level: null, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(r);
  }
  const levels = new Map<string, LevelRead | null>();
  for (const g of groups.values()) {
    const k = `${g.item.id}|${g.locationId}`;
    if (!levels.has(k)) levels.set(k, await readLevel(ctx.d.client(), g.item.inventoryItemGid, g.locationId));
    g.level = levels.get(k) ?? null;
  }
  return checkImport(ctx, rows, groups);
}

function checkImport(ctx: ApiContext, rows: ImportRow[], groups: ImportSimulation['groups']): ImportSimulation {
  const errors: ImportReport['errors'] = rows.filter((r) => r.error).map((r) => ({ row: r.row, code: r.error!.code, detail: r.error!.detail }));
  const seen = new Map<string, number>();
  let valid = 0;
  let beyondGap = 0;
  let stockWrites = 0;
  for (const g of groups.values()) {
    const plan = checkBatch(ctx, g.item, g.locationId, g.rows.map((r) => r.ref), g.alreadyCounted, g.level);
    plan.rows.forEach((pr, i) => {
      const r = g.rows[i]!;
      const dupRow = seen.get(pr.valueNorm);
      if (pr.status === 'ready' && dupRow !== undefined) {
        errors.push({ row: r.row, code: 'identifier_conflict', detail: `duplicate_in_file (row ${dupRow})` });
        return;
      }
      seen.set(pr.valueNorm, r.row);
      if (pr.status === 'ready') {
        valid += 1;
        if (!g.alreadyCounted) stockWrites += 1;
      } else {
        if (pr.status === 'beyond_gap') beyondGap += 1;
        errors.push({ row: r.row, code: ROW_CODE[pr.status], detail: pr.status === 'duplicate_in_list' ? 'duplicate_in_file' : (pr.detail ?? pr.status) });
      }
    });
  }
  errors.sort((a, b) => a.row - b.row);
  return { rows, errors, valid, beyondGap, stockWrites, groups };
}

type ImportReportFull = ImportReport & ImportReportExtras;

function importReport(ctx: ApiContext, id: string): ImportReportFull {
  const r = ctx.d.sql.exec<{ id: string; status: string; report: string; rows_total: number; rows_ok: number; mapping: string | null }>('SELECT * FROM imports WHERE id = ?', id).toArray()[0];
  if (!r) throw new ApiError(404, 'not_found', 'unknown import');
  const extras = parseJson<{ beyondGap?: number; stockWrites?: number }>(r.mapping, {});
  return {
    id: r.id,
    status: r.status === 'done' ? 'confirmed' : r.status === 'failed' ? 'failed' : 'simulated',
    rows: r.rows_total,
    valid: r.rows_ok,
    errors: parseJson<ImportReport['errors']>(r.report, []),
    ...(extras.beyondGap !== undefined ? { beyondGap: extras.beyondGap } : {}),
    ...(extras.stockWrites !== undefined ? { stockWrites: extras.stockWrites } : {}),
  };
}

export async function createImport(ctx: ApiContext): Promise<ApiResult> {
  let csv: string;
  if ((ctx.call.headers.contentType ?? '').includes('text/csv')) csv = ctx.call.body ?? '';
  else {
    const body = parseBody<CreateImportRequest>(ctx.call);
    if (typeof body.csv !== 'string') throw new ApiError(400, 'validation_failed', 'csv required');
    csv = body.csv;
  }
  const rows = parseCsv(ctx, csv);
  const sim = await simulateImport(ctx, rows);
  const id = newId();
  const now = Date.now();
  ctx.d.sql.exec(
    `INSERT INTO imports (id, kind, status, rows, mapping, report, rows_total, rows_ok, rows_failed, created_by, created_at, updated_at)
     VALUES (?, 'units_csv', 'validated', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    JSON.stringify(rows),
    JSON.stringify({ beyondGap: sim.beyondGap, stockWrites: sim.stockWrites }),
    JSON.stringify(sim.errors),
    rows.length,
    sim.valid,
    sim.errors.length,
    ctx.call.principal.actor.id,
    now,
    now,
  );
  return json(importReport(ctx, id), 201);
}

export function getImport(ctx: ApiContext, id: string): ApiResult {
  return json(importReport(ctx, id));
}

/** Confirmation: the file is checked again against the current state, then valid rows are created by lots of 500 (9.10). */
export async function confirmImport(ctx: ApiContext, id: string): Promise<ApiResult> {
  const row = ctx.d.sql.exec<{ status: string; rows: string }>('SELECT status, rows FROM imports WHERE id = ?', id).toArray()[0];
  if (!row) throw new ApiError(404, 'not_found', 'unknown import');
  if (row.status === 'done') return json(importReport(ctx, id));
  const rows = parseJson<ImportRow[]>(row.rows, []);
  const sim = await simulateImport(ctx, rows);
  const now = Date.now();
  let created = 0;
  for (const g of sim.groups.values()) {
    for (let i = 0; i < g.rows.length; i += 500) {
      const part = g.rows.slice(i, i + 500);
      ctx.d.storage.transactionSync(() => {
        const plan = checkBatch(ctx, g.item, g.locationId, part.map((r) => r.ref), g.alreadyCounted, g.level);
        if (g.level) storeLevel(ctx.d, g.item, g.locationId, g.level, now);
        created += createPlannedUnits(ctx, plan, g.alreadyCounted, now).length;
        const fresh = ctx.d.repo.trackedItem(g.item.id);
        if (fresh && g.level) evaluateLevel(ctx.d, fresh, g.locationId, now);
      });
    }
  }
  const after = checkImport(ctx, rows, new Map());
  ctx.d.sql.exec(
    "UPDATE imports SET status = 'done', report = ?, rows_ok = ?, rows_failed = ?, updated_at = ? WHERE id = ?",
    JSON.stringify(sim.errors.length > 0 ? sim.errors : after.errors),
    created,
    rows.length - created,
    now,
    id,
  );
  return json(importReport(ctx, id));
}
