/**
 * Transactional outbox of Shopify writes (spec 12.4). Generic executor: each row holds a frozen
 * GraphQL request `{ query, variables }`; the executor adds `$idempotencyKey` (derived from the row
 * id and its revision) when the mutation declares it, for the `@idempotent` directive.
 * At-least-once with dedupe: retries resend exactly the same payload and key; rows of one
 * `serial_key` run one by one in creation order; a `dead` row blocks the rows after it.
 */
import { backoffDelay, firstUserErrors, ShopifyError, type AdminGraphqlClient } from '@serialis/shopify';
import { errorMessage, logEvent } from './log.js';
import { ReconnectRequiredError } from './tokens.js';

export const OUTBOX_LEASE_MS = 2 * 60_000;
export const OUTBOX_RETRY_BASE_MS = 1_000;
export const OUTBOX_RETRY_MAX_MS = 10 * 60_000;
/** Retries of one revision stop after 20 h, under Shopify's 24 h idempotency-key retention (PV-15). */
export const REVISION_WINDOW_MS = 20 * 3_600_000;
const FROZEN_RETRY_MS = 3_600_000;
const RECONNECT_RETRY_MS = 5 * 60_000;

export type OutboxKind =
  | 'inventory_activate'
  | 'inventory_adjust'
  | 'inventory_move'
  | 'inventory_set'
  | 'hold_place'
  | 'hold_release'
  | 'metafield_set'
  | 'variant_create'
  | 'variant_update'
  | 'variant_delete'
  | 'product_create'
  | 'product_update'
  | 'publishable_publish'
  | 'draft_order_update'
  | 'inventory_item_update'
  | 'webhook_out';

export interface OutboxEnqueueInput {
  kind: OutboxKind;
  /** Shopify object concerned (fulfillment order, item-location pair…): rows of one key run in order. */
  serialKey: string;
  query: string;
  variables?: Record<string, unknown>;
  dedupeKey?: string | null;
  dependsOn?: number | null;
}

export type OutboxRow = {
  id: number;
  kind: OutboxKind;
  serial_key: string;
  depends_on: number | null;
  dedupe_key: string | null;
  payload: string;
  revision: number;
  revision_started_at: number | null;
  idempotency_key: string;
  status: 'pending' | 'in_flight' | 'done' | 'failed' | 'dead';
  lease_until: number | null;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  result: string | null;
};

/** Transient user errors of stock mutations: retry with the same key (spec 12.4). */
const TRANSIENT_USER_ERRORS = new Set(['IDEMPOTENCY_CONCURRENT_REQUEST', 'ADJUST_QUANTITIES_FAILED', 'MOVE_QUANTITIES_FAILED', 'SERVICE_UNAVAILABLE']);

export class Outbox {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly keyPrefix: () => string,
    private readonly random: () => number = Math.random,
  ) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  static idempotencyKey(prefix: string, id: number, revision: number): string {
    return `${prefix}-${id}-r${revision}`;
  }

  /** Synchronous: meant to run inside the business transaction. Returns the row id (existing one on dedupe). */
  enqueue(input: OutboxEnqueueInput, now = Date.now()): { id: number; created: boolean } {
    if (input.dedupeKey) {
      const existing = this.sql.exec<{ id: number }>('SELECT id FROM outbox WHERE dedupe_key = ?', input.dedupeKey).toArray()[0];
      if (existing) return { id: existing.id, created: false };
    }
    const payload = JSON.stringify({ query: input.query, variables: input.variables ?? {} });
    const { id } = this.sql
      .exec<{ id: number }>(
        `INSERT INTO outbox (kind, serial_key, depends_on, dedupe_key, payload, idempotency_key, status, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', 'pending', ?, ?, ?) RETURNING id`,
        input.kind,
        input.serialKey,
        input.dependsOn ?? null,
        input.dedupeKey ?? null,
        payload,
        now,
        now,
        now,
      )
      .one();
    this.sql.exec('UPDATE outbox SET idempotency_key = ? WHERE id = ?', Outbox.idempotencyKey(this.keyPrefix(), id, 0), id);
    return { id, created: true };
  }

  /** In-flight rows whose lease expired go back to pending, same payload and key (spec 12.2, T-CH-05). */
  recoverExpiredLeases(now = Date.now()): number {
    return this.sql.exec("UPDATE outbox SET status = 'pending', lease_until = NULL, updated_at = ? WHERE status = 'in_flight' AND lease_until < ?", now, now)
      .rowsWritten;
  }

  /**
   * Earliest next attempt among pending rows that can run some day (null when nothing waits). Rows
   * behind a dead row of their serial key, or depending on a dead row, wait for an operator: they
   * must not keep the outbox task awake.
   */
  nextAttemptAt(): number | null {
    return (
      this.sql
        .exec<{ next: number | null }>(
          `SELECT MIN(o.next_attempt_at) AS next FROM outbox o
           WHERE o.status = 'pending'
             AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.serial_key = o.serial_key AND p.id < o.id AND p.status = 'dead')
             AND NOT EXISTS (SELECT 1 FROM outbox d WHERE d.id = o.depends_on AND d.status = 'dead')`,
        )
        .one().next ?? null
    );
  }

  /** Runs due rows within the budget; returns when the outbox task must run again. */
  async process(client: () => AdminGraphqlClient, budgetMs: number): Promise<{ executed: number; nextAt: number | null }> {
    const started = Date.now();
    this.recoverExpiredLeases();
    let executed = 0;
    while (Date.now() - started < budgetMs) {
      const row = this.nextRunnable();
      if (!row) break;
      await this.execute(row, client);
      executed += 1;
    }
    return { executed, nextAt: this.nextAttemptAt() };
  }

  private nextRunnable(): OutboxRow | undefined {
    const now = Date.now();
    // A row runs when no earlier row of its serial key is unfinished, and its dependency is done.
    const candidates = this.sql
      .exec<OutboxRow & { blocked: number; dep_status: string | null }>(
        `SELECT o.*,
           EXISTS (SELECT 1 FROM outbox p WHERE p.serial_key = o.serial_key AND p.id < o.id AND p.status IN ('pending', 'in_flight', 'dead')) AS blocked,
           (SELECT d.status FROM outbox d WHERE d.id = o.depends_on) AS dep_status
         FROM outbox o
         WHERE o.status = 'pending' AND o.next_attempt_at <= ?
         ORDER BY o.id
         LIMIT 50`,
        now,
      )
      .toArray();
    for (const c of candidates) {
      if (c.blocked) continue;
      if (c.depends_on !== null && c.dep_status !== 'done') {
        if (c.dep_status === 'failed') {
          this.finish(c.id, 'failed', { error: `dependency ${c.depends_on} failed` });
        }
        continue;
      }
      const { blocked: _b, dep_status: _d, ...row } = c;
      return row;
    }
    return undefined;
  }

  private async execute(row: OutboxRow, client: () => AdminGraphqlClient): Promise<void> {
    const now = Date.now();
    const taken = this.sql.exec(
      "UPDATE outbox SET status = 'in_flight', lease_until = ?, attempts = attempts + 1, revision_started_at = COALESCE(revision_started_at, ?), updated_at = ? WHERE id = ? AND status = 'pending'",
      now + OUTBOX_LEASE_MS,
      now,
      now,
      row.id,
    ).rowsWritten;
    if (taken === 0) return;
    const attempts = row.attempts + 1;
    const revisionStartedAt = row.revision_started_at ?? now;

    const request = JSON.parse(row.payload) as { query: string; variables?: Record<string, unknown> };
    const variables = { ...(request.variables ?? {}) };
    if (request.query.includes('$idempotencyKey')) variables.idempotencyKey = row.idempotency_key;

    try {
      const response = await client().request(request.query, { variables, estimatedCost: 10 });
      const userErrors = firstUserErrors(response.data);
      if (userErrors.length === 0) {
        this.finish(row.id, 'done', { result: JSON.stringify(response.data) });
        return;
      }
      const codes = userErrors.map((e) => e.code ?? '').filter(Boolean);
      const summary = userErrors
        .map((e) => (e.code ? `${e.code}: ${e.message}` : e.message))
        .join('; ')
        .slice(0, 500);
      if (codes.some((c) => TRANSIENT_USER_ERRORS.has(c))) {
        this.retry(row.id, attempts, revisionStartedAt, summary);
      } else if (codes.includes('IDEMPOTENCY_KEY_PARAMETER_MISMATCH')) {
        // Can only come from a code defect (spec 12.4).
        this.finish(row.id, 'dead', { error: summary });
      } else if (codes.includes('IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED')) {
        // Nothing was applied: next revision, new key, at once.
        this.nextRevision(row, summary);
      } else {
        // Definitive business error (CHANGE_FROM_QUANTITY_STALE included until the domain plugs its
        // recompute, see DECISIONS.md): no retry.
        this.finish(row.id, 'failed', { error: summary });
      }
    } catch (error) {
      if (error instanceof ReconnectRequiredError) {
        this.reschedule(row.id, Date.now() + RECONNECT_RETRY_MS, errorMessage(error), true);
      } else if (error instanceof ShopifyError && error.kind === 'frozen') {
        this.reschedule(row.id, Date.now() + FROZEN_RETRY_MS, errorMessage(error), true);
      } else if (error instanceof ShopifyError && error.kind === 'throttled') {
        this.reschedule(row.id, Date.now() + 1_000, errorMessage(error), true);
      } else if (error instanceof ShopifyError && error.kind === 'graphql') {
        // Invalid query or missing access: needs a fix, blocks the serial key.
        this.finish(row.id, 'dead', { error: errorMessage(error) });
      } else {
        this.retry(row.id, attempts, revisionStartedAt, errorMessage(error));
      }
    }
  }

  private retry(id: number, attempts: number, revisionStartedAt: number, error: string): void {
    const now = Date.now();
    if (now - revisionStartedAt > REVISION_WINDOW_MS) {
      // Beyond the window the write is not resent blindly; the domain re-reads the level (spec 12.4).
      this.finish(id, 'failed', { error: `revision_window_expired: ${error}` });
      return;
    }
    const delay = backoffDelay(attempts, { baseMs: OUTBOX_RETRY_BASE_MS, maxMs: OUTBOX_RETRY_MAX_MS, random: this.random });
    this.reschedule(id, now + delay, error, false);
  }

  /** Back to pending; `uncounted` gives the attempt back (throttling, frozen shop, reconnect). */
  private reschedule(id: number, at: number, error: string, uncounted: boolean): void {
    this.sql.exec(
      `UPDATE outbox SET status = 'pending', lease_until = NULL, next_attempt_at = ?, last_error = ?,
         attempts = attempts - ?, updated_at = ? WHERE id = ? AND status = 'in_flight'`,
      at,
      error,
      uncounted ? 1 : 0,
      Date.now(),
      id,
    );
  }

  private nextRevision(row: OutboxRow, error: string): void {
    const revision = row.revision + 1;
    this.sql.exec(
      `UPDATE outbox SET status = 'pending', lease_until = NULL, revision = ?, idempotency_key = ?, revision_started_at = NULL,
         next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'in_flight'`,
      revision,
      Outbox.idempotencyKey(this.keyPrefix(), row.id, revision),
      Date.now(),
      error,
      Date.now(),
      row.id,
    );
  }

  private finish(id: number, status: 'done' | 'failed' | 'dead', detail: { result?: string; error?: string }): void {
    const now = Date.now();
    this.sql.exec(
      'UPDATE outbox SET status = ?, lease_until = NULL, result = ?, last_error = ?, completed_at = ?, updated_at = ? WHERE id = ?',
      status,
      detail.result ?? null,
      detail.error ?? null,
      now,
      now,
      id,
    );
    if (status !== 'done') {
      // TODO(lot 0, observability): anomaly `outbox_dead` for dead rows, sync relaunch for failed ones (spec 12.4).
      logEvent(status === 'dead' ? 'error' : 'warn', `outbox.${status}`, { id, error: detail.error ?? null });
    }
  }
}
