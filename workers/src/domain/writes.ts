/**
 * Shopify writes of the domain, through the outbox (spec 12.4, 13.3, 13.4).
 *
 * Stock writes are queued as intents; the request is built just before the first send of each
 * revision: the level is re-read, `changeFromQuantity` set from it (never null), and the delta
 * recomputed. With the `deficit` guard (unit added to the stock: reception, restock of a unit to
 * verify), the app does not write what Shopify already counts (7.3 common rule, 8.1). A stale
 * quantity gives a new revision that redoes all of it (no blind retry).
 */
import { buildUnitsMetafield, METAFIELD_KEY, METAFIELD_NAMESPACE, resolveSetting, serializeMetafield, type Unit } from '@serialis/core';
import type { AdminGraphqlClient } from '@serialis/shopify';
import type { OutboxEnqueueInput, OutboxHooks, OutboxRow, PrepareResult, StoredPayload } from '../outbox.js';
import { readLevel, type LevelRead } from './shopify-read.js';
import { DomainRepo, stockSerialKey } from './repo.js';
import { parseJson, sha256Hex } from './util.js';

export type StockQuantityName = 'available' | 'quality_control' | 'damaged' | 'reserved';

export interface StockIntent {
  type: 'stock';
  op: 'adjust' | 'move' | 'activate';
  trackedItemId: string;
  inventoryItemGid: string;
  locationId: string;
  /** Adjusted quantity (adjust) or destination quantity (move). */
  name: StockQuantityName;
  fromName?: StockQuantityName;
  delta: number;
  guard: 'deficit' | 'none';
  /** Shopify adjustment reason (`received`, `restock`, `quality_control`, …). */
  reason: string;
  unitIds: string[];
}

export interface MetafieldIntent {
  type: 'metafield';
  orderGid: string;
}

const ADJUST = `mutation SerialisAdjust($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryAdjustmentGroup { id }
    userErrors { field message code }
  }
}`;

const MOVE = `mutation SerialisMove($input: InventoryMoveQuantitiesInput!, $idempotencyKey: String!) {
  inventoryMoveQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryAdjustmentGroup { id }
    userErrors { field message code }
  }
}`;

const ACTIVATE = `mutation SerialisActivate($inventoryItemId: ID!, $locationId: ID!, $idempotencyKey: String!) {
  inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $idempotencyKey) {
    inventoryLevel { id }
    userErrors { field message }
  }
}`;

const METAFIELD_SET = `mutation SerialisMetafieldSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } }
}`;

const METAFIELD_DELETE = `mutation SerialisMetafieldDelete($metafields: [MetafieldIdentifierInput!]!) {
  metafieldsDelete(metafields: $metafields) { deletedMetafields { key } userErrors { field message } }
}`;

const OUTBOX_KIND = { adjust: 'inventory_adjust', move: 'inventory_move', activate: 'inventory_activate' } as const;

export function stockWriteInput(intent: StockIntent): OutboxEnqueueInput {
  return {
    kind: OUTBOX_KIND[intent.op],
    serialKey: stockSerialKey(intent.inventoryItemGid, intent.locationId),
    query: '',
    intent: intent as unknown as Record<string, unknown>,
  };
}

export function metafieldWriteInput(orderGid: string): OutboxEnqueueInput {
  return { kind: 'metafield_set', serialKey: `order:${orderGid}`, query: '', intent: { type: 'metafield', orderGid } satisfies MetafieldIntent };
}

/** One pending metafield row per order is enough: it is computed from the base when it runs. */
export function hasPendingMetafieldWrite(sql: SqlStorage, orderGid: string): boolean {
  return (
    sql
      .exec(
        "SELECT 1 FROM outbox WHERE kind = 'metafield_set' AND serial_key = ? AND status = 'pending' AND json_extract(payload, '$.prepared') = 0 LIMIT 1",
        `order:${orderGid}`,
      )
      .toArray().length > 0
  );
}

/** Shopify quantities and unit states compared by a write's guard (7.2, "enregistrement d'une unité déjà comptée"). */
function groupCounts(name: StockQuantityName, level: LevelRead, counted: Record<string, number>): { shopify: number; units: number } {
  switch (name) {
    case 'available':
    case 'reserved':
      return {
        shopify: level.q.available + level.q.committed + level.q.reserved + level.q.safety_stock,
        units: (counted.AVAILABLE ?? 0) + (counted.ALLOCATED ?? 0) + (counted.HELD ?? 0),
      };
    case 'quality_control':
      return { shopify: level.q.quality_control, units: counted.QUALITY_CONTROL ?? 0 };
    case 'damaged':
      return { shopify: level.q.damaged, units: counted.DAMAGED ?? 0 };
  }
}

/** Deficit guard: the part of the delta Shopify does not count yet (later rows of the same level excluded). */
export function guardedDelta(repo: DomainRepo, sql: SqlStorage, row: Pick<OutboxRow, 'id' | 'serial_key'>, intent: StockIntent, level: LevelRead): number {
  const counted = repo.countedUnits(intent.trackedItemId, intent.locationId);
  const { shopify, units } = groupCounts(intent.name, level, counted);
  const stateName = intent.name === 'reserved' ? 'available' : intent.name;
  const explainedDeficit = repo
    .explainedFor(intent.trackedItemId, intent.locationId)
    .filter((e) => e.direction === 'deficit' && e.inventoryState === stateName)
    .reduce((s, e) => s + e.quantity, 0);
  let later = 0;
  for (const r of sql
    .exec<{ payload: string }>("SELECT payload FROM outbox WHERE serial_key = ? AND id > ? AND status IN ('pending', 'in_flight')", row.serial_key, row.id)
    .toArray()) {
    const other = parseJson<StoredPayload>(r.payload, { query: '' }).intent as StockIntent | undefined;
    if (other?.type === 'stock' && other.op === 'adjust' && other.guard === 'deficit' && other.name === intent.name) later += other.delta;
  }
  const missing = units - later - (shopify - explainedDeficit);
  return Math.max(0, Math.min(intent.delta, missing));
}

export async function prepareStockWrite(repo: DomainRepo, sql: SqlStorage, row: OutboxRow, intent: StockIntent, client: AdminGraphqlClient): Promise<PrepareResult> {
  if (intent.op === 'activate') {
    return { send: { query: ACTIVATE, variables: { inventoryItemId: intent.inventoryItemGid, locationId: intent.locationId } } };
  }
  const level = await readLevel(client, intent.inventoryItemGid, intent.locationId);
  if (!level) return { skip: 'inventory_item_missing' };
  const document = `gid://serialis/OutboxEntry/${row.id}`;
  if (intent.op === 'adjust') {
    const delta = intent.guard === 'deficit' ? guardedDelta(repo, sql, row, intent, level) : intent.delta;
    if (delta === 0) return { skip: 'already_counted_by_shopify' };
    return {
      send: {
        query: ADJUST,
        variables: {
          input: {
            reason: intent.reason,
            name: intent.name,
            referenceDocumentUri: document,
            changes: [
              {
                inventoryItemId: intent.inventoryItemGid,
                locationId: intent.locationId,
                delta,
                changeFromQuantity: level.q[intent.name],
                ...(intent.name !== 'available' ? { ledgerDocumentUri: document } : {}),
              },
            ],
          },
        },
      },
    };
  }
  const fromName = intent.fromName ?? 'available';
  const side = (name: StockQuantityName) => ({
    locationId: intent.locationId,
    name,
    changeFromQuantity: level.q[name],
    ...(name !== 'available' ? { ledgerDocumentUri: document } : {}),
  });
  return {
    send: {
      query: MOVE,
      variables: {
        input: {
          reason: intent.reason,
          referenceDocumentUri: document,
          changes: [{ inventoryItemId: intent.inventoryItemGid, quantity: intent.delta, from: side(fromName), to: side(intent.name) }],
        },
      },
    },
  };
}

/** Current `serialis.units` value of an order, computed from the base (13.4); null = no unit (or S-38 = no). */
export function currentMetafieldValue(repo: DomainRepo, sql: SqlStorage, orderGid: string): string | null {
  if (!resolveSetting('S-38', {}, repo.storedSettings())) return null;
  const lines = sql
    .exec<{ line_item_gid: string }>('SELECT line_item_gid FROM order_lines WHERE order_gid = ? ORDER BY position', orderGid)
    .toArray()
    .map((r) => r.line_item_gid);
  const allocations = repo.orderAllocations(orderGid);
  const units = new Map<string, Unit>(repo.unitsByIds(allocations.map((a) => a.unitId)).map((u) => [u.id, u]));
  return serializeMetafield(buildUnitsMetafield(lines, allocations, units));
}

export function prepareMetafieldWrite(repo: DomainRepo, sql: SqlStorage, intent: MetafieldIntent): PrepareResult {
  const value = currentMetafieldValue(repo, sql, intent.orderGid);
  if (value === null) {
    return { send: { query: METAFIELD_DELETE, variables: { metafields: [{ ownerId: intent.orderGid, namespace: METAFIELD_NAMESPACE, key: METAFIELD_KEY }] } } };
  }
  return {
    send: {
      query: METAFIELD_SET,
      variables: { metafields: [{ ownerId: intent.orderGid, namespace: METAFIELD_NAMESPACE, key: METAFIELD_KEY, type: 'json', value }] },
    },
  };
}

/** Hooks plugged into the shop object's outbox. */
export function domainOutboxHooks(deps: {
  sql: SqlStorage;
  repo: DomainRepo;
  onMetafieldFailed: (orderGid: string) => void;
}): OutboxHooks {
  const { sql, repo } = deps;
  return {
    async prepare(row, intent, client) {
      if (intent.type === 'stock') return prepareStockWrite(repo, sql, row, intent as unknown as StockIntent, client);
      if (intent.type === 'metafield') return prepareMetafieldWrite(repo, sql, intent as unknown as MetafieldIntent);
      throw new Error(`unknown outbox intent ${String(intent.type)}`);
    },
    async verifyExpired(_row, intent, sent, client) {
      const stock = intent as unknown as StockIntent;
      if (stock.type !== 'stock' || stock.op === 'activate') return 'retry';
      const level = await readLevel(client, stock.inventoryItemGid, stock.locationId);
      const change = ((sent.variables.input as { changes?: Array<Record<string, unknown>> } | undefined)?.changes ?? [])[0];
      if (!level || !change) return 'conflict';
      const expectedFrom = stock.op === 'adjust' ? Number(change.changeFromQuantity) : Number((change.to as Record<string, unknown>).changeFromQuantity);
      const delta = stock.op === 'adjust' ? Number(change.delta) : Number(change.quantity);
      const now = level.q[stock.name];
      if (now === expectedFrom + delta) return 'applied';
      if (now === expectedFrom) return 'retry';
      repo.openAnomaly({
        type: 'inventory_write_conflict',
        subject: { trackedItemId: stock.trackedItemId, locationId: stock.locationId },
        details: { expectedFrom, delta, found: now, quantityName: stock.name },
        now: Date.now(),
      });
      return 'conflict';
    },
    onFinished(row, status, detail) {
      const intent = row.payload.intent;
      const now = Date.now();
      if (status === 'dead') {
        const stock = intent as unknown as StockIntent | undefined;
        repo.openAnomaly({
          type: 'outbox_dead',
          subject: stock?.type === 'stock' ? { trackedItemId: stock.trackedItemId, locationId: stock.locationId } : {},
          fingerprintKey: `outbox_dead|outbox=${row.id}`,
          details: { outboxId: row.id, kind: row.kind, error: detail.error ?? null },
          now,
        });
      } else {
        // A row retried by an operator (12.7 « Relancer ») reached a final status: its outbox_dead anomaly closes.
        const live = repo.liveAnomalyByKey(`outbox_dead|outbox=${row.id}`);
        if (live) repo.closeAnomaly(live.id, 'auto_resolved', { by: status === 'done' ? 'outbox_done' : 'outbox_failed' }, now);
      }
      if (intent?.type === 'metafield') {
        const orderGid = (intent as unknown as MetafieldIntent).orderGid;
        if (status === 'done') {
          const value = row.payload.variables?.metafields as Array<{ value?: string }> | undefined;
          sql.exec('UPDATE order_sync SET metafield_hash = ? WHERE order_gid = ?', value?.[0]?.value ? sha256Hex(value[0].value) : null, orderGid);
        } else if (status === 'failed') {
          deps.onMetafieldFailed(orderGid);
        }
      }
    },
  };
}
