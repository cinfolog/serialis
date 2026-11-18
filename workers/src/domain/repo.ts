/**
 * SQLite mapping of the domain tables (db/shop/0004_domain.sql) to core's types. Synchronous:
 * every method may run inside the `transactionSync` of a task or an API call (spec 12.2).
 */
import {
  anomalyFingerprint,
  severityOf,
  type Allocation,
  type Anomaly,
  type AnomalyDetails,
  type AnomalySubject,
  type AnomalyType,
  type ExplainedQuantity,
  type InventoryLevel,
  type ScopeType,
  type StoredSetting,
  type TrackedItem,
  type Unit,
  type UnitIdentifier,
  type UnitLock,
  type UnitState,
} from '@serialis/core';
import { chunks, newId, parseJson, placeholders, sha256Hex } from './util.js';

type Row = Record<string, SqlStorageValue>;

export interface Actor {
  type: 'user' | 'api_key' | 'system' | 'shopify';
  id: string | null;
}

export interface Cause {
  type: 'webhook' | 'task' | 'api_request' | 'ui_action' | 'reconciliation' | 'migration';
  id: string | null;
}

export const SYSTEM: Actor = { type: 'system', id: null };

export interface TrackedItemRow extends TrackedItem {
  readonly productTitle: string | null;
  readonly variantTitle: string | null;
  readonly sku: string | null;
}

export interface UnitRecord extends Unit {
  readonly variantGid: string;
  readonly primaryIdentifier: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const COUNTED: readonly UnitState[] = ['AVAILABLE', 'HELD', 'ALLOCATED', 'QUALITY_CONTROL', 'DAMAGED'];

export class DomainRepo {
  constructor(private readonly sql: SqlStorage) {}

  private rows<T = Row>(query: string, ...binds: SqlStorageValue[]): T[] {
    return this.sql.exec(query, ...binds).toArray() as unknown as T[];
  }

  private first<T = Row>(query: string, ...binds: SqlStorageValue[]): T | undefined {
    return this.rows<T>(query, ...binds)[0];
  }

  /** Runs `query` with the ids bound in chunks of 90 (100 parameters at most, spec 12.4). */
  private inChunks<T = Row>(query: (ph: string) => string, ids: readonly string[], ...extra: SqlStorageValue[]): T[] {
    const out: T[] = [];
    for (const part of chunks([...new Set(ids)])) out.push(...this.rows<T>(query(placeholders(part.length)), ...part, ...extra));
    return out;
  }

  // ------------------------------------------------------------------ meta

  meta(key: string): string | null {
    return this.first<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  automationPaused(): boolean {
    return this.meta('automation_paused') === '1';
  }

  // ------------------------------------------------------------------ locations

  locations(): { id: string; name: string; active: boolean; updatedAt: number }[] {
    return this.rows<{ id: string; name: string; active: number; updated_at: number }>('SELECT * FROM locations ORDER BY name, id').map((r) => ({
      id: r.id,
      name: r.name,
      active: r.active === 1,
      updatedAt: r.updated_at,
    }));
  }

  location(id: string): { id: string; name: string; active: boolean } | null {
    const r = this.first<{ id: string; name: string; active: number }>('SELECT * FROM locations WHERE id = ?', id);
    return r ? { id: r.id, name: r.name, active: r.active === 1 } : null;
  }

  upsertLocation(l: { id: string; name: string; active: boolean }, now: number): void {
    this.sql.exec(
      'INSERT INTO locations (id, name, active, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, active = excluded.active, updated_at = excluded.updated_at',
      l.id,
      l.name,
      l.active ? 1 : 0,
      now,
    );
  }

  /** Locations seen in Shopify data before the list was read get a placeholder name. */
  ensureLocation(id: string, now: number): void {
    this.sql.exec("INSERT INTO locations (id, name, active, updated_at) VALUES (?, '', 1, ?) ON CONFLICT (id) DO NOTHING", id, now);
  }

  // ------------------------------------------------------------------ tracked items

  private toItem(r: Row): TrackedItemRow {
    return {
      id: r.id as string,
      productGid: r.product_gid as string,
      variantGid: r.variant_gid as string,
      inventoryItemGid: r.inventory_item_gid as string,
      mode: r.mode as 'pooled' | 'unique',
      activatedAt: r.activated_at as number,
      initializing: r.initializing === 1,
      active: r.active === 1,
      productTitle: (r.product_title as string | null) ?? null,
      variantTitle: (r.variant_title as string | null) ?? null,
      sku: (r.sku as string | null) ?? null,
    };
  }

  trackedItem(id: string): TrackedItemRow | null {
    const r = this.first('SELECT * FROM tracked_items WHERE id = ?', id);
    return r ? this.toItem(r) : null;
  }

  activeItemByVariant(variantGid: string): TrackedItemRow | null {
    const r = this.first('SELECT * FROM tracked_items WHERE variant_gid = ? AND active = 1', variantGid);
    return r ? this.toItem(r) : null;
  }

  itemByInventoryItem(inventoryItemGid: string): TrackedItemRow | null {
    const r = this.first('SELECT * FROM tracked_items WHERE inventory_item_gid = ? ORDER BY active DESC, activated_at DESC', inventoryItemGid);
    return r ? this.toItem(r) : null;
  }

  latestItemByVariant(variantGid: string): TrackedItemRow | null {
    const r = this.first('SELECT * FROM tracked_items WHERE variant_gid = ? ORDER BY active DESC, activated_at DESC', variantGid);
    return r ? this.toItem(r) : null;
  }

  itemsByVariants(variantGids: readonly string[]): TrackedItemRow[] {
    return this.inChunks((ph) => `SELECT * FROM tracked_items WHERE variant_gid IN (${ph}) AND active = 1`, variantGids).map((r) => this.toItem(r));
  }

  itemsByIds(ids: readonly string[]): TrackedItemRow[] {
    return this.inChunks((ph) => `SELECT * FROM tracked_items WHERE id IN (${ph})`, ids).map((r) => this.toItem(r));
  }

  activeItems(): TrackedItemRow[] {
    return this.rows('SELECT * FROM tracked_items WHERE active = 1 ORDER BY activated_at, id').map((r) => this.toItem(r));
  }

  hasActiveItems(): boolean {
    return this.first('SELECT 1 AS x FROM tracked_items WHERE active = 1 LIMIT 1') !== undefined;
  }

  insertTrackedItem(input: {
    productGid: string;
    variantGid: string;
    inventoryItemGid: string;
    productTitle: string | null;
    variantTitle: string | null;
    sku: string | null;
    applyToOpenOrders: boolean;
    now: number;
  }): TrackedItemRow {
    const id = newId(input.now);
    this.sql.exec(
      `INSERT INTO tracked_items (id, product_gid, variant_gid, inventory_item_gid, mode, initializing, activated_at, apply_to_open_orders, active,
         product_title, variant_title, sku, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pooled', 1, ?, ?, 1, ?, ?, ?, ?, ?)`,
      id,
      input.productGid,
      input.variantGid,
      input.inventoryItemGid,
      input.now,
      input.applyToOpenOrders ? 1 : 0,
      input.productTitle,
      input.variantTitle,
      input.sku,
      input.now,
      input.now,
    );
    return this.trackedItem(id)!;
  }

  setItemInitializing(id: string, initializing: boolean, now: number): void {
    this.sql.exec('UPDATE tracked_items SET initializing = ?, updated_at = ? WHERE id = ?', initializing ? 1 : 0, now, id);
  }

  deactivateItem(id: string, now: number): void {
    this.sql.exec('UPDATE tracked_items SET active = 0, updated_at = ? WHERE id = ?', now, id);
  }

  // ------------------------------------------------------------------ units

  private toUnit(r: Row, identifiers: UnitIdentifier[]): UnitRecord {
    return {
      id: r.id as string,
      trackedItemId: r.tracked_item_id as string,
      status: r.status as UnitState,
      locationId: (r.location_id as string | null) ?? null,
      identifiers,
      receivedAt: (r.received_at as number | null) ?? null,
      expiresAt: (r.expires_at as number | null) ?? null,
      warrantyEndsAt: (r.warranty_ends_at as number | null) ?? null,
      holdMovedStock: r.hold_moved_stock === 1,
      packedForShipment: r.native_shipment_gid != null,
      version: r.version as number,
      variantGid: r.variant_gid as string,
      primaryIdentifier: (r.primary_identifier as string | null) ?? null,
      createdAt: (r.created_ms as number | null) ?? Date.parse(r.created_at as string),
      updatedAt: (r.updated_ms as number | null) ?? Date.parse(r.updated_at as string),
    };
  }

  identifiersOf(unitIds: readonly string[]): Map<string, UnitIdentifier[]> {
    const map = new Map<string, UnitIdentifier[]>();
    const rows = this.inChunks<{ unit_id: string; type: string; value: string; is_primary: number; retired_at: number | null; id: string }>(
      (ph) => `SELECT * FROM unit_identifiers WHERE unit_id IN (${ph}) ORDER BY is_primary DESC, created_at, id`,
      unitIds,
    );
    for (const r of rows) {
      const list = map.get(r.unit_id) ?? [];
      list.push({ type: r.type, value: r.value, primary: r.is_primary === 1, ...(r.retired_at !== null ? { retired: true } : {}) });
      map.set(r.unit_id, list);
    }
    return map;
  }

  identifierRows(unitId: string): { id: string; type: string; value: string; primary: boolean; retired: boolean }[] {
    return this.rows<{ id: string; type: string; value: string; is_primary: number; retired_at: number | null }>(
      'SELECT * FROM unit_identifiers WHERE unit_id = ? ORDER BY is_primary DESC, created_at, id',
      unitId,
    ).map((r) => ({ id: r.id, type: r.type, value: r.value, primary: r.is_primary === 1, retired: r.retired_at !== null }));
  }

  private withIdentifiers(rows: Row[]): UnitRecord[] {
    const ids = this.identifiersOf(rows.map((r) => r.id as string));
    return rows.map((r) => this.toUnit(r, ids.get(r.id as string) ?? []));
  }

  unitsByIds(ids: readonly string[]): UnitRecord[] {
    return this.withIdentifiers(this.inChunks((ph) => `SELECT * FROM units WHERE id IN (${ph})`, ids));
  }

  unit(id: string): UnitRecord | null {
    return this.unitsByIds([id])[0] ?? null;
  }

  /** AVAILABLE units of items at locations, FIFO order (S-05 default), at most `limit` per call (allocation candidates). */
  availableUnits(itemIds: readonly string[], locationIds: readonly string[], limit = 500): UnitRecord[] {
    if (itemIds.length === 0 || locationIds.length === 0) return [];
    const out: Row[] = [];
    for (const item of new Set(itemIds)) {
      for (const part of chunks([...new Set(locationIds)])) {
        out.push(
          ...this.rows(
            `SELECT * FROM units WHERE tracked_item_id = ? AND status = 'AVAILABLE' AND location_id IN (${placeholders(part.length)})
             ORDER BY received_at IS NULL, received_at, id LIMIT ?`,
            item,
            ...part,
            limit,
          ),
        );
      }
    }
    return this.withIdentifiers(out);
  }

  countedUnits(itemId: string, locationId: string): Record<UnitState, number> {
    const counts = Object.fromEntries(COUNTED.map((s) => [s, 0])) as Record<UnitState, number>;
    for (const r of this.rows<{ status: UnitState; n: number }>(
      'SELECT status, count(*) AS n FROM units WHERE tracked_item_id = ? AND location_id = ? GROUP BY status',
      itemId,
      locationId,
    )) {
      counts[r.status] = r.n;
    }
    return counts;
  }

  unitsAt(itemId: string, locationId: string): UnitRecord[] {
    return this.withIdentifiers(this.rows('SELECT * FROM units WHERE tracked_item_id = ? AND location_id = ?', itemId, locationId));
  }

  insertUnit(input: {
    trackedItem: TrackedItemRow;
    locationId: string;
    status: UnitState;
    identifier: { type: string; value: string; valueNorm: string; scopeKey: string };
    receivedAt: number | null;
    now: number;
  }): string {
    const id = newId(input.now);
    const iso = new Date(input.now).toISOString();
    this.sql.exec(
      `INSERT INTO units (id, variant_gid, location_id, status, version, created_at, updated_at, tracked_item_id, primary_identifier,
         primary_identifier_type, received_at, created_ms, updated_ms)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.trackedItem.variantGid,
      input.locationId,
      input.status,
      iso,
      iso,
      input.trackedItem.id,
      input.identifier.value,
      input.identifier.type,
      input.receivedAt,
      input.now,
      input.now,
    );
    this.sql.exec(
      'INSERT INTO unit_identifiers (id, unit_id, type, value, value_norm, scope_key, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      newId(input.now),
      id,
      input.identifier.type,
      input.identifier.value,
      input.identifier.valueNorm,
      input.identifier.scopeKey,
      input.now,
    );
    return id;
  }

  identifierTaken(type: string, scopeKey: string, valueNorm: string): boolean {
    return this.first('SELECT 1 AS x FROM unit_identifiers WHERE type = ? AND scope_key = ? AND value_norm = ? AND retired_at IS NULL', type, scopeKey, valueNorm) !== undefined;
  }

  /** Units whose identifier (any type, retired included) has this normalised value (EF-07, EF-08). */
  lookup(valueNorm: string): UnitRecord[] {
    const ids = this.rows<{ unit_id: string }>('SELECT DISTINCT unit_id FROM unit_identifiers WHERE value_norm = ?', valueNorm).map((r) => r.unit_id);
    return this.unitsByIds(ids);
  }

  /**
   * Applies one transition with the optimistic version (7.3, trigger of 0001); returns false when
   * the unit is no longer in `from` (the caller aborts its transaction).
   */
  transitionUnit(unitId: string, from: UnitState, to: UnitState, locationId: string | null, now: number): boolean {
    return (
      this.sql.exec(
        'UPDATE units SET status = ?, location_id = ?, version = version + 1, updated_at = ?, updated_ms = ? WHERE id = ? AND status = ?',
        to,
        locationId,
        new Date(now).toISOString(),
        now,
        unitId,
        from,
      ).rowsWritten > 0
    );
  }

  insertEvent(e: {
    unitId: string;
    type: string;
    from: UnitState | null;
    to: UnitState | null;
    actor: Actor;
    cause: Cause;
    orderGid?: string | null;
    locationId?: string | null;
    data?: Record<string, unknown>;
    now: number;
  }): void {
    this.sql.exec(
      `INSERT INTO unit_events (unit_id, type, from_status, to_status, actor_type, actor_id, cause_type, cause_id, order_gid, location_id, data, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.unitId,
      e.type,
      e.from,
      e.to,
      e.actor.type,
      e.actor.id,
      e.cause.type,
      e.cause.id,
      e.orderGid ?? null,
      e.locationId ?? null,
      JSON.stringify(e.data ?? {}),
      e.now,
    );
  }

  // ------------------------------------------------------------------ allocations

  private toAllocation(r: Row): Allocation {
    return {
      id: r.id as string,
      unitId: r.unit_id as string,
      variantGid: r.variant_gid as string,
      orderGid: r.order_gid as string,
      lineItemGid: r.line_item_gid as string,
      fulfillmentOrderGid: (r.fulfillment_order_gid as string | null) ?? null,
      fulfillmentOrderLineItemGid: (r.fulfillment_order_line_item_gid as string | null) ?? null,
      locationId: r.location_id as string,
      status: r.status as Allocation['status'],
      source: r.source as Allocation['source'],
      returnExpected: r.return_expected === 1,
      toConfirm: r.to_confirm === 1,
      allocationVersion: r.allocation_version as number,
      allocatedAt: r.allocated_at as number,
      fulfilledAt: (r.fulfilled_at as number | null) ?? null,
      releasedAt: (r.released_at as number | null) ?? null,
      returnedAt: (r.returned_at as number | null) ?? null,
      releaseKind: (r.release_kind as Allocation['releaseKind']) ?? null,
      returnLineItemGid: (r.return_line_item_gid as string | null) ?? null,
    };
  }

  allocation(id: string): Allocation | null {
    const r = this.first('SELECT * FROM allocations WHERE id = ?', id);
    return r ? this.toAllocation(r) : null;
  }

  orderAllocations(orderGid: string): Allocation[] {
    return this.rows('SELECT * FROM allocations WHERE order_gid = ? ORDER BY allocated_at, id', orderGid).map((r) => this.toAllocation(r));
  }

  engagedAllocationsOf(unitIds: readonly string[]): Allocation[] {
    return this.inChunks((ph) => `SELECT * FROM allocations WHERE unit_id IN (${ph}) AND status IN ('active', 'fulfilled')`, unitIds).map((r) =>
      this.toAllocation(r),
    );
  }

  /** Current allocation (active or fulfilled) of each unit, for display. */
  currentAllocationOf(unitId: string): Allocation | null {
    const r = this.first("SELECT * FROM allocations WHERE unit_id = ? AND status IN ('active', 'fulfilled')", unitId);
    return r ? this.toAllocation(r) : null;
  }

  insertAllocation(a: Allocation): void {
    this.sql.exec(
      `INSERT INTO allocations (id, unit_id, variant_gid, order_gid, line_item_gid, fulfillment_order_gid, fulfillment_order_line_item_gid, location_id,
         status, source, return_expected, to_confirm, allocation_version, allocated_at, fulfilled_at, released_at, returned_at, release_kind, return_line_item_gid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id,
      a.unitId,
      a.variantGid,
      a.orderGid,
      a.lineItemGid,
      a.fulfillmentOrderGid,
      a.fulfillmentOrderLineItemGid,
      a.locationId,
      a.status,
      a.source,
      a.returnExpected ? 1 : 0,
      a.toConfirm ? 1 : 0,
      a.allocationVersion,
      a.allocatedAt,
      a.fulfilledAt,
      a.releasedAt,
      a.returnedAt,
      a.releaseKind,
      a.returnLineItemGid,
    );
  }

  private static readonly ALLOCATION_COLUMNS: Record<string, string> = {
    variantGid: 'variant_gid',
    fulfillmentOrderGid: 'fulfillment_order_gid',
    fulfillmentOrderLineItemGid: 'fulfillment_order_line_item_gid',
    locationId: 'location_id',
    status: 'status',
    source: 'source',
    returnExpected: 'return_expected',
    toConfirm: 'to_confirm',
    allocationVersion: 'allocation_version',
    allocatedAt: 'allocated_at',
    fulfilledAt: 'fulfilled_at',
    releasedAt: 'released_at',
    returnedAt: 'returned_at',
    releaseKind: 'release_kind',
    returnLineItemGid: 'return_line_item_gid',
  };

  patchAllocation(id: string, patch: Partial<Allocation>): void {
    const sets: string[] = [];
    const binds: SqlStorageValue[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = DomainRepo.ALLOCATION_COLUMNS[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      binds.push(typeof v === 'boolean' ? (v ? 1 : 0) : ((v ?? null) as SqlStorageValue));
    }
    if (sets.length === 0) return;
    if (!('allocationVersion' in patch)) sets.push('allocation_version = allocation_version + 1');
    this.sql.exec(`UPDATE allocations SET ${sets.join(', ')} WHERE id = ?`, ...binds, id);
  }

  // ------------------------------------------------------------------ anomalies

  private toAnomaly(r: Row): Anomaly & { resolution: unknown; updatedAt: number } {
    return {
      id: r.id as string,
      type: r.type as AnomalyType,
      severity: r.severity as Anomaly['severity'],
      subject: parseJson<AnomalySubject>(r.subject as string, {}),
      fingerprint: r.fingerprint_key as string,
      details: parseJson<AnomalyDetails>(r.details as string, {}),
      status: r.status as Anomaly['status'],
      detectedAt: r.detected_at as number,
      resolvedAt: (r.resolved_at as number | null) ?? null,
      resolution: parseJson<unknown>(r.resolution as string | null, null),
      updatedAt: r.updated_at as number,
    };
  }

  anomaly(id: string): (Anomaly & { resolution: unknown; updatedAt: number }) | null {
    const r = this.first('SELECT * FROM anomalies WHERE id = ?', id);
    return r ? this.toAnomaly(r) : null;
  }

  orderAnomalies(orderGid: string): Anomaly[] {
    return this.rows('SELECT * FROM anomalies WHERE order_gid = ?', orderGid).map((r) => this.toAnomaly(r));
  }

  liveAnomaly(type: AnomalyType, subject: AnomalySubject): Anomaly | null {
    const key = anomalyFingerprint(type, subject);
    const r = this.first("SELECT * FROM anomalies WHERE fingerprint = ? AND status IN ('open', 'acknowledged')", sha256Hex(key));
    return r ? this.toAnomaly(r) : null;
  }

  listAnomalies(filter: { status?: string[]; severity?: string; type?: string; orderGid?: string; after?: string; limit: number }): (Anomaly & { resolution: unknown; updatedAt: number })[] {
    const where: string[] = [];
    const binds: SqlStorageValue[] = [];
    if (filter.status && filter.status.length > 0) {
      where.push(`status IN (${placeholders(filter.status.length)})`);
      binds.push(...filter.status);
    }
    if (filter.severity) {
      where.push('severity = ?');
      binds.push(filter.severity);
    }
    if (filter.type) {
      where.push('type = ?');
      binds.push(filter.type);
    }
    if (filter.orderGid) {
      where.push('order_gid = ?');
      binds.push(filter.orderGid);
    }
    if (filter.after) {
      where.push('id < ?');
      binds.push(filter.after);
    }
    const sql = `SELECT * FROM anomalies ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return this.rows(sql, ...binds, filter.limit).map((r) => this.toAnomaly(r));
  }

  /** Opens an anomaly unless the same cause is already open (unique live fingerprint, 11.2). Returns its id. */
  openAnomaly(input: { id?: string; type: AnomalyType; subject: AnomalySubject; details: AnomalyDetails; fingerprintKey?: string; now: number }): string {
    const key = input.fingerprintKey ?? anomalyFingerprint(input.type, input.subject);
    const fp = sha256Hex(key);
    const existing = this.first<{ id: string }>("SELECT id FROM anomalies WHERE fingerprint = ? AND status IN ('open', 'acknowledged')", fp);
    if (existing) {
      this.sql.exec('UPDATE anomalies SET details = ?, updated_at = ? WHERE id = ?', JSON.stringify(input.details), input.now, existing.id);
      return existing.id;
    }
    const id = input.id ?? newId(input.now);
    const s = input.subject;
    this.sql.exec(
      `INSERT INTO anomalies (id, type, severity, subject, order_gid, unit_id, tracked_item_id, location_id, variant_gid, fingerprint, fingerprint_key,
         details, status, detected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      id,
      input.type,
      severityOf(input.type),
      JSON.stringify(s),
      s.orderGid ?? null,
      s.unitId ?? null,
      s.trackedItemId ?? null,
      s.locationId ?? null,
      s.variantGid ?? (typeof input.details.variantGid === 'string' ? input.details.variantGid : null),
      fp,
      key,
      JSON.stringify(input.details),
      input.now,
      input.now,
    );
    return id;
  }

  /** Live anomaly by its canonical fingerprint key (anomalies opened with an explicit `fingerprintKey`). */
  liveAnomalyByKey(fingerprintKey: string): { id: string } | null {
    return this.first<{ id: string }>("SELECT id FROM anomalies WHERE fingerprint = ? AND status IN ('open', 'acknowledged')", sha256Hex(fingerprintKey)) ?? null;
  }

  updateAnomalyDetails(id: string, details: AnomalyDetails, now: number): void {
    this.sql.exec('UPDATE anomalies SET details = ?, updated_at = ? WHERE id = ?', JSON.stringify(details), now, id);
  }

  closeAnomaly(id: string, status: 'resolved' | 'auto_resolved', resolution: unknown, now: number): void {
    this.sql.exec(
      "UPDATE anomalies SET status = ?, resolution = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND status IN ('open', 'acknowledged')",
      status,
      resolution === null ? null : JSON.stringify(resolution),
      now,
      now,
      id,
    );
  }

  acknowledgeAnomaly(id: string, now: number): void {
    this.sql.exec("UPDATE anomalies SET status = 'acknowledged', updated_at = ? WHERE id = ? AND status = 'open'", now, id);
  }

  liveAnomaliesOfLevel(itemId: string, locationId: string, types: readonly AnomalyType[]): Anomaly[] {
    return this.rows(
      `SELECT * FROM anomalies WHERE tracked_item_id = ? AND location_id = ? AND order_gid IS NULL AND status IN ('open', 'acknowledged') AND type IN (${placeholders(types.length)})`,
      itemId,
      locationId,
      ...types,
    ).map((r) => this.toAnomaly(r));
  }

  // ------------------------------------------------------------------ settings

  storedSettings(): StoredSetting[] {
    const out: StoredSetting[] = this.rows<{ scope_type: ScopeType; scope_id: string; key: string; value: string }>('SELECT * FROM settings').map((r) => ({
      scopeType: r.scope_type,
      scopeId: r.scope_id,
      key: r.key as StoredSetting['key'],
      value: parseJson<unknown>(r.value, null),
    }));
    // S-35 to S-37 live in `identifier_types` (11.2).
    for (const t of this.identifierTypes()) {
      out.push({ scopeType: 'identifier_type', scopeId: t.key, key: 'S-35', value: t.scope });
      out.push({ scopeType: 'identifier_type', scopeId: t.key, key: 'S-36', value: { stripSpaces: t.stripSpaces, normalizeUpper: t.normalizeUpper } });
      out.push({ scopeType: 'identifier_type', scopeId: t.key, key: 'S-37', value: t.validation });
    }
    return out;
  }

  identifierTypes(): { key: string; scope: 'shop' | 'product'; stripSpaces: boolean; normalizeUpper: boolean; validation: 'none' | 'luhn' | 'regex'; regex: string | null }[] {
    return this.rows<{ key: string; scope: 'shop' | 'product'; strip_spaces: number; normalize_upper: number; validation: 'none' | 'luhn' | 'regex'; regex: string | null }>(
      'SELECT * FROM identifier_types ORDER BY key',
    ).map((r) => ({ key: r.key, scope: r.scope, stripSpaces: r.strip_spaces === 1, normalizeUpper: r.normalize_upper === 1, validation: r.validation, regex: r.regex }));
  }

  putSetting(s: { scopeType: ScopeType; scopeId: string; key: string; value: unknown; updatedBy: string | null; now: number }): void {
    this.sql.exec(
      `INSERT INTO settings (scope_type, scope_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope_type, scope_id, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      s.scopeType,
      s.scopeId,
      s.key,
      JSON.stringify(s.value),
      s.updatedBy,
      s.now,
    );
  }

  deleteSetting(scopeType: ScopeType, scopeId: string, key: string): void {
    this.sql.exec('DELETE FROM settings WHERE scope_type = ? AND scope_id = ? AND key = ?', scopeType, scopeId, key);
  }

  // ------------------------------------------------------------------ stock model (section 8)

  explainedFor(itemId: string, locationId: string): ExplainedQuantity[] {
    return this.rows<Row>("SELECT * FROM explained_quantities WHERE tracked_item_id = ? AND location_id = ? AND status = 'open'", itemId, locationId).map((r) => ({
      sourceType: r.source_type as ExplainedQuantity['sourceType'],
      sourceRef: r.source_ref as string,
      trackedItemId: r.tracked_item_id as string,
      locationId: r.location_id as string,
      inventoryState: r.inventory_state as ExplainedQuantity['inventoryState'],
      direction: r.direction as ExplainedQuantity['direction'],
      quantity: r.quantity as number,
      status: 'open',
    }));
  }

  uncoveredFor(itemId: string, locationId: string): { trackedItemId: string; locationId: string; quantity: number }[] {
    return this.rows<{ quantity: number }>('SELECT quantity FROM uncovered_lines WHERE tracked_item_id = ? AND location_id = ?', itemId, locationId).map((r) => ({
      trackedItemId: itemId,
      locationId,
      quantity: r.quantity,
    }));
  }

  cachedLevel(itemId: string, locationId: string): (InventoryLevel & { active: boolean; safetyStock: number; readAt: number; gapSince: number | null }) | null {
    const r = this.first<Row>('SELECT * FROM inventory_levels WHERE tracked_item_id = ? AND location_id = ?', itemId, locationId);
    if (!r) return null;
    return {
      trackedItemId: itemId,
      locationId,
      onHand: r.on_hand as number,
      available: r.available as number,
      committed: r.committed as number,
      reserved: r.reserved as number,
      qualityControl: r.quality_control as number,
      damaged: r.damaged as number,
      safetyStock: r.safety_stock as number,
      active: r.active === 1,
      readAt: r.read_at as number,
      gapSince: (r.gap_since as number | null) ?? null,
    };
  }

  levelsOfItem(itemId: string): { locationId: string; onHand: number }[] {
    return this.rows<{ location_id: string; on_hand: number }>('SELECT location_id, on_hand FROM inventory_levels WHERE tracked_item_id = ? ORDER BY location_id', itemId).map((r) => ({
      locationId: r.location_id,
      onHand: r.on_hand,
    }));
  }

  saveLevel(
    itemId: string,
    locationId: string,
    l: { active: boolean; onHand: number; available: number; committed: number; reserved: number; qualityControl: number; damaged: number; safetyStock: number },
    now: number,
  ): void {
    this.sql.exec(
      `INSERT INTO inventory_levels (tracked_item_id, location_id, active, on_hand, available, committed, reserved, quality_control, damaged, safety_stock, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tracked_item_id, location_id) DO UPDATE SET active = excluded.active, on_hand = excluded.on_hand, available = excluded.available,
         committed = excluded.committed, reserved = excluded.reserved, quality_control = excluded.quality_control, damaged = excluded.damaged,
         safety_stock = excluded.safety_stock, read_at = excluded.read_at`,
      itemId,
      locationId,
      l.active ? 1 : 0,
      l.onHand,
      l.available,
      l.committed,
      l.reserved,
      l.qualityControl,
      l.damaged,
      l.safetyStock,
      now,
    );
  }

  setGapSince(itemId: string, locationId: string, since: number | null): void {
    this.sql.exec('UPDATE inventory_levels SET gap_since = ? WHERE tracked_item_id = ? AND location_id = ?', since, itemId, locationId);
  }

  locks(now: number): UnitLock[] {
    return this.rows<{ unit_id: string; kind: UnitLock['kind']; owner: string; expires_at: number }>('SELECT * FROM unit_locks WHERE expires_at > ?', now).map((r) => ({
      unitId: r.unit_id,
      kind: r.kind,
      owner: r.owner,
      expiresAt: r.expires_at,
    }));
  }

  lockUnit(unitId: string, kind: UnitLock['kind'], owner: string, expiresAt: number): void {
    this.sql.exec(
      'INSERT INTO unit_locks (unit_id, kind, owner, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (unit_id) DO UPDATE SET kind = excluded.kind, owner = excluded.owner, expires_at = excluded.expires_at',
      unitId,
      kind,
      owner,
      expiresAt,
    );
  }

  /** Pending stock writes of the outbox for one level (a gap is not judged while the app's own writes are in flight). */
  pendingStockWrites(inventoryItemGid: string, locationId: string): number {
    return (
      this.first<{ n: number }>(
        "SELECT count(*) AS n FROM outbox WHERE serial_key = ? AND status IN ('pending', 'in_flight') AND kind IN ('inventory_adjust', 'inventory_move', 'inventory_activate')",
        stockSerialKey(inventoryItemGid, locationId),
      )?.n ?? 0
    );
  }

  audit(actor: Actor, action: string, before: unknown, after: unknown, now: number): void {
    this.sql.exec(
      'INSERT INTO audit_log (actor_type, actor_id, action, before, after, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
      actor.type,
      actor.id,
      action,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
      now,
    );
  }
}

/** Outbox serial key of a level: writes of one (item, location) run one by one, in order (12.4). */
export function stockSerialKey(inventoryItemGid: string, locationId: string): string {
  return `inv:${inventoryItemGid}|${locationId}`;
}

export function countedStates(): readonly UnitState[] {
  return COUNTED;
}
