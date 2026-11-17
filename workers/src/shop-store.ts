import { DurableObject } from 'cloudflare:workers';
import m0001 from '../../db/shop/0001_init.sql';
import m0002 from '../../db/shop/0002_allowed_transitions.sql';
import type { Env } from './env.js';

/** Ordered shop schema migrations; the version is stored in `meta.schema_version` (spec 10.4). */
const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  { version: 1, sql: m0001 },
  { version: 2, sql: m0002 },
];

export interface IngestInput {
  webhookId: string;
  topic: string;
  triggeredAt: string | null;
  payload: string;
}

export type IngestResult = { stored: true } | { stored: false; reason: 'duplicate' };

/**
 * One object per shop: its SQLite database, tasks, alarms and outbox (spec 10.2, 11.2, 12).
 * Lot 0 scope: schema migrations and idempotent webhook ingestion.
 */
export class ShopStore extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Migrations run before any other call (blockConcurrencyWhile, 30 s limit).
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  schemaVersion(): number {
    const hasMeta = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
    if (!hasMeta) return 0;
    const row = this.sql.exec("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0];
    return row ? Number(row.value) : 0;
  }

  private migrate(): void {
    const current = this.schemaVersion();
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(m.sql);
        this.sql.exec(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          String(m.version),
        );
      });
    }
  }

  /** Stores a webhook once; Shopify retries and duplicates are ignored (same webhook id). */
  ingest(input: IngestInput): IngestResult {
    const cursor = this.sql.exec(
      'INSERT INTO inbox (webhook_id, topic, received_at, triggered_at, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT (webhook_id) DO NOTHING',
      input.webhookId,
      input.topic,
      new Date().toISOString(),
      input.triggeredAt,
      input.payload,
    );
    // TODO lot 0: schedule the matching task (sync_order, sync_inventory_level…) through the alarm queue.
    return cursor.rowsWritten > 0 ? { stored: true } : { stored: false, reason: 'duplicate' };
  }

  inboxCount(): number {
    return Number(this.sql.exec('SELECT count(*) AS n FROM inbox').one().n);
  }

  /** Test helper for the transition triggers; the real API goes through applyTransition (lot 0/MVP). */
  createUnit(id: string, variantGid: string, locationId: string | null, status: string): void {
    const now = new Date().toISOString();
    this.sql.exec(
      'INSERT INTO units (id, variant_gid, location_id, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      id,
      variantGid,
      locationId,
      status,
      now,
      now,
    );
  }

  setUnitStatus(id: string, status: string, expectedVersion: number): void {
    this.sql.exec(
      'UPDATE units SET status = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?',
      status,
      expectedVersion + 1,
      new Date().toISOString(),
      id,
      expectedVersion,
    );
  }
}
