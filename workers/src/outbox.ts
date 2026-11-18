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
  /** Frozen request; empty when the row carries an `intent` prepared at the first send of each revision. */
  query: string;
  variables?: Record<string, unknown>;
  /**
   * Domain description of the write (stock change, metafield). The request is built by
   * `OutboxHooks.prepare` just before the first send of each revision (spec 12.4: `changeFromQuantity`
   * read just before sending, recomputed on a new revision), then frozen in the row.
   */
  intent?: Record<string, unknown>;
  dedupeKey?: string | null;
  dependsOn?: number | null;
}

export interface PreparedRequest {
  query: string;
  variables: Record<string, unknown>;
}

export type PrepareResult = { send: PreparedRequest } | { skip: string };

/** Domain plug-ins of the generic executor (registered by the shop object). */
export interface OutboxHooks {
  /** Builds the request of a row with an intent (reads the level, recomputes the write; may decide it is useless). */
  prepare?(row: OutboxRow, intent: Record<string, unknown>, client: AdminGraphqlClient): Promise<PrepareResult>;
  /**
   * After the 20 h window of a revision (12.4): re-reads the level. `applied` = the write took place,
   * `retry` = nothing applied (new revision), `conflict` = ambiguous gap (row failed, anomaly by the hook).
   */
  verifyExpired?(row: OutboxRow, intent: Record<string, unknown>, sent: PreparedRequest, client: AdminGraphqlClient): Promise<'applied' | 'retry' | 'conflict'>;
  /** Called once a row reaches a final status (`done`, `failed`, `dead`). Synchronous. */
  onFinished?(row: Pick<OutboxRow, 'id' | 'kind' | 'serial_key'> & { payload: StoredPayload }, status: 'done' | 'failed' | 'dead', detail: { result?: string; error?: string }): void;
}

/** Stored payload: the frozen request, plus the intent and its preparation state. */
export interface StoredPayload {
  query: string;
  variables?: Record<string, unknown>;
  intent?: Record<string, unknown>;
  /** True once the request of the current revision is frozen. */
  prepared?: boolean;
  /** Set when the 20 h window expired: the next run re-reads the level instead of resending. */
  windowExpired?: boolean;
}

/** Revisions refused for a stale quantity go on for 10 minutes, and at least three times (12.4). */
export const STALE_REVISIONS_MS = 10 * 60_000;
export const STALE_MIN_REVISIONS = 3;

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
  stale_since: number | null;
};

/** A row abandoned by an operator (`Outbox.abandonDead`). */
export type AbandonedOutboxRow = Pick<OutboxRow, 'id' | 'kind' | 'serial_key' | 'revision' | 'last_error'> & { payload: StoredPayload };

/** Transient user errors of stock mutations: retry with the same key (spec 12.4). */
const TRANSIENT_USER_ERRORS = new Set(['IDEMPOTENCY_CONCURRENT_REQUEST', 'ADJUST_QUANTITIES_FAILED', 'MOVE_QUANTITIES_FAILED', 'SERVICE_UNAVAILABLE']);

export class Outbox {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly keyPrefix: () => string,
    private readonly random: () => number = Math.random,
    private readonly hooks: OutboxHooks = {},
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
    const stored: StoredPayload = { query: input.query, variables: input.variables ?? {} };
    if (input.intent) {
      stored.intent = input.intent;
      stored.prepared = false;
    }
    const payload = JSON.stringify(stored);
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

  /**
   * Operator retry of a `dead` row (12.4 « relancer la ligne après correction », 12.7 `outbox_dead`).
   * A row only dies on a refusal (stale revisions exhausted, key/parameter mismatch, invalid query or
   * access): nothing was applied, so it restarts at its next revision (new idempotency key, request
   * prepared again from its intent), attempts and stale counter reset, due now. Synchronous; the
   * caller schedules the outbox task. False when the row does not exist or is not `dead`.
   */
  retryDead(id: number, now = Date.now()): boolean {
    const row = this.sql.exec<{ revision: number; payload: string }>("SELECT revision, payload FROM outbox WHERE id = ? AND status = 'dead'", id).toArray()[0];
    if (!row) return false;
    const revision = row.revision + 1;
    const stored = JSON.parse(row.payload) as StoredPayload;
    const payload = stored.intent ? JSON.stringify({ ...stored, query: '', variables: {}, prepared: false, windowExpired: false }) : row.payload;
    return (
      this.sql.exec(
        `UPDATE outbox SET status = 'pending', lease_until = NULL, revision = ?, idempotency_key = ?, revision_started_at = NULL, payload = ?,
           stale_since = NULL, attempts = 0, next_attempt_at = ?, last_error = NULL, result = NULL, completed_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'dead'`,
        revision,
        Outbox.idempotencyKey(this.keyPrefix(), id, revision),
        payload,
        now,
        now,
        id,
      ).rowsWritten > 0
    );
  }

  /**
   * Operator abandon of a `dead` row (12.4 « ou de l'abandonner, ce qui débloque la suite »): the row
   * becomes final without being sent. Status `failed` (the 0003 CHECK has no other final status that
   * unblocks the serial key) with `abandoned_at` / `abandoned_by` to tell it from a refusal by Shopify;
   * `last_error` is kept. Rows behind it on the serial key are no longer blocked; a row that depends on
   * it (`depends_on`) is failed by the executor, as after any failed dependency (a two-step write never
   * runs its second step alone). No hook: the caller closes the anomaly and requests the reconciliation.
   * Synchronous; null when the row does not exist or is not `dead`.
   */
  abandonDead(id: number, by: string | null, now = Date.now()): AbandonedOutboxRow | null {
    const row = this.sql
      .exec<{ id: number; kind: OutboxKind; serial_key: string; payload: string; revision: number; last_error: string | null }>(
        "SELECT id, kind, serial_key, payload, revision, last_error FROM outbox WHERE id = ? AND status = 'dead'",
        id,
      )
      .toArray()[0];
    if (!row) return null;
    const written = this.sql.exec(
      "UPDATE outbox SET status = 'failed', lease_until = NULL, abandoned_at = ?, abandoned_by = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'dead'",
      now,
      by,
      now,
      now,
      id,
    ).rowsWritten;
    if (written === 0) return null;
    logEvent('warn', 'outbox.abandoned', { id, kind: row.kind });
    return { id: row.id, kind: row.kind, serial_key: row.serial_key, revision: row.revision, last_error: row.last_error, payload: JSON.parse(row.payload) as StoredPayload };
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

    let request = JSON.parse(row.payload) as StoredPayload;

    try {
      if (request.intent && request.windowExpired && request.prepared && this.hooks.verifyExpired) {
        const verdict = await this.hooks.verifyExpired(row, request.intent, { query: request.query, variables: request.variables ?? {} }, client());
        if (verdict === 'applied') {
          this.finish(row.id, 'done', { result: JSON.stringify({ verified: 'applied_before_window_end' }) });
        } else if (verdict === 'retry') {
          this.nextRevision(row, 'revision_window_expired: not applied');
        } else {
          this.finish(row.id, 'failed', { error: 'inventory_write_conflict: ambiguous level after the revision window' });
        }
        return;
      }
      if (request.intent && !request.prepared) {
        if (!this.hooks.prepare) throw new Error(`no preparer for outbox kind ${row.kind}`);
        const prepared = await this.hooks.prepare(row, request.intent, client());
        if ('skip' in prepared) {
          this.finish(row.id, 'done', { result: JSON.stringify({ skipped: prepared.skip }) });
          return;
        }
        // Frozen for every retry of this revision (12.4 "charge figée").
        request = { ...request, query: prepared.send.query, variables: prepared.send.variables, prepared: true };
        this.sql.exec('UPDATE outbox SET payload = ?, updated_at = ? WHERE id = ?', JSON.stringify(request), Date.now(), row.id);
      }
      const variables = { ...(request.variables ?? {}) };
      if (request.query.includes('$idempotencyKey')) variables.idempotencyKey = row.idempotency_key;
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
        this.retry(row, attempts, revisionStartedAt, summary);
      } else if (codes.includes('CHANGE_FROM_QUANTITY_STALE') && request.intent) {
        // The level moved between the read and the write: new revision, level re-read and write recomputed (12.4).
        this.staleRevision(row, summary);
      } else if (codes.includes('IDEMPOTENCY_KEY_PARAMETER_MISMATCH')) {
        // Can only come from a code defect (spec 12.4).
        this.finish(row.id, 'dead', { error: summary });
      } else if (codes.includes('IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED')) {
        // Nothing was applied: next revision, new key, at once.
        this.nextRevision(row, summary);
      } else {
        // Definitive business error (a stale quantity on a frozen request without intent included): no retry.
        this.finish(row.id, 'failed', { error: summary });
      }
    } catch (error) {
      if (error instanceof ReconnectRequiredError) {
        this.reschedule(row.id, Date.now() + RECONNECT_RETRY_MS, errorMessage(error), true);
      } else if (error instanceof ShopifyError && error.kind === 'frozen') {
        this.reschedule(row.id, Date.now() + FROZEN_RETRY_MS, errorMessage(error), true);
      } else if (error instanceof ShopifyError && error.kind === 'throttled') {
        this.reschedule(row.id, Date.now() + 1_000, errorMessage(error), true);
      } else if (error instanceof ShopifyError && error.codes.includes('IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED')) {
        // Shopify may report the idempotency outcomes as top-level errors: nothing was applied, next revision.
        this.nextRevision(row, errorMessage(error));
      } else if (error instanceof ShopifyError && error.codes.includes('IDEMPOTENCY_CONCURRENT_REQUEST')) {
        this.retry(row, attempts, revisionStartedAt, errorMessage(error));
      } else if (error instanceof ShopifyError && error.kind === 'graphql') {
        // Invalid query or missing access: needs a fix, blocks the serial key.
        this.finish(row.id, 'dead', { error: errorMessage(error) });
      } else {
        this.retry(row, attempts, revisionStartedAt, errorMessage(error));
      }
    }
  }

  private retry(row: OutboxRow, attempts: number, revisionStartedAt: number, error: string): void {
    const id = row.id;
    const now = Date.now();
    if (now - revisionStartedAt > REVISION_WINDOW_MS) {
      // Beyond the window the write is not resent blindly; the domain re-reads the level (spec 12.4).
      const stored = JSON.parse(row.payload) as StoredPayload;
      const current = this.sql.exec<{ payload: string }>('SELECT payload FROM outbox WHERE id = ?', id).toArray()[0];
      const latest = current ? (JSON.parse(current.payload) as StoredPayload) : stored;
      if (latest.intent && latest.prepared && this.hooks.verifyExpired) {
        this.sql.exec('UPDATE outbox SET payload = ? WHERE id = ?', JSON.stringify({ ...latest, windowExpired: true }), id);
        this.reschedule(id, now, error, false);
        return;
      }
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

  private nextRevision(row: OutboxRow, error: string, at = Date.now(), staleSince: number | null = row.stale_since): void {
    const revision = row.revision + 1;
    const current = this.sql.exec<{ payload: string }>('SELECT payload FROM outbox WHERE id = ?', row.id).toArray()[0];
    const stored = JSON.parse(current?.payload ?? row.payload) as StoredPayload;
    // A row with an intent is prepared again (level re-read, write recomputed) under the new key.
    const payload = stored.intent ? JSON.stringify({ ...stored, query: '', variables: {}, prepared: false, windowExpired: false }) : (current?.payload ?? row.payload);
    this.sql.exec(
      `UPDATE outbox SET status = 'pending', lease_until = NULL, revision = ?, idempotency_key = ?, revision_started_at = NULL, payload = ?,
         stale_since = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'in_flight'`,
      revision,
      Outbox.idempotencyKey(this.keyPrefix(), row.id, revision),
      payload,
      staleSince,
      at,
      error,
      Date.now(),
      row.id,
    );
  }

  /** CHANGE_FROM_QUANTITY_STALE: random wait of 1 to 5 s growing with the revisions, for 10 minutes and at least 3 times, then dead (12.4). */
  private staleRevision(row: OutboxRow, error: string): void {
    const now = Date.now();
    const since = row.stale_since ?? now;
    const staleRevisions = row.stale_since === null ? 0 : row.revision;
    if (now - since > STALE_REVISIONS_MS && staleRevisions >= STALE_MIN_REVISIONS) {
      this.finish(row.id, 'dead', { error: `stale_revisions_exhausted: ${error}` });
      return;
    }
    const factor = Math.min(16, 2 ** Math.min(4, staleRevisions));
    const delay = Math.round((1_000 + 4_000 * this.random()) * factor);
    this.nextRevision(row, error, now + delay, since);
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
      logEvent(status === 'dead' ? 'error' : 'warn', `outbox.${status}`, { id, error: detail.error ?? null });
    }
    if (this.hooks.onFinished) {
      const row = this.sql.exec<{ id: number; kind: OutboxKind; serial_key: string; payload: string }>('SELECT id, kind, serial_key, payload FROM outbox WHERE id = ?', id).toArray()[0];
      if (row) {
        try {
          this.hooks.onFinished({ id: row.id, kind: row.kind, serial_key: row.serial_key, payload: JSON.parse(row.payload) as StoredPayload }, status, detail);
        } catch (error) {
          logEvent('error', 'outbox.on_finished_failed', { id, error: errorMessage(error) });
        }
      }
    }
  }
}
