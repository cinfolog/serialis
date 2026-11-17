/**
 * Task queue of a shop object (spec 12.2): table `tasks` + the object's alarm.
 * - one row per key (`sync_order:<order>`…): a new request for a pending key postpones it by 2 s
 *   without passing `deadline_at` (10 s after the first request); for a running key it sets
 *   `rerun_requested` instead of creating a second run;
 * - attempts are counted when the lease is taken, before the work;
 * - failures retry with exponential backoff and jitter, then `dead` after MAX_ATTEMPTS;
 * - the alarm handler never throws and always reschedules the alarm.
 */
import { backoffDelay } from '@serialis/shopify';
import { errorMessage, logEvent } from './log.js';

export const MAX_ATTEMPTS = 8;
export const LEASE_MS = 2 * 60_000;
export const LEASE_RENEW_MS = 30_000;
export const COALESCE_MAX_MS = 10_000;
export const ALARM_BUDGET_MS = 25_000;
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 10 * 60_000;

export type TaskRow = {
  key: string;
  kind: string;
  payload: string;
  run_at: number;
  deadline_at: number;
  status: 'pending' | 'running' | 'dead';
  lease_until: number | null;
  lease_token: string | null;
  rerun_requested: number;
  attempts: number;
  last_error: string | null;
  priority: number;
  created_at: number;
  updated_at: number;
};

export interface EnqueueTaskInput {
  key: string;
  kind: string;
  priority: number;
  payload?: Record<string, unknown>;
  /** Delay before running (default 0). */
  delayMs?: number;
}

export type EnqueueOutcome = 'created' | 'postponed' | 'rerun_requested' | 'dead';

export interface TaskContext {
  key: string;
  kind: string;
  payload: Record<string, unknown>;
  /** 1 for the first run. */
  attempt: number;
  /** True while this execution still holds the lease (check before writing, spec 12.2). */
  holdsLease(): boolean;
}

/** A handler may ask to run again later (for example the outbox when rows wait for their backoff). */
export type TaskResult = void | { rescheduleAt?: number | null };
export type TaskHandler = (ctx: TaskContext) => Promise<TaskResult> | TaskResult;

export class NoHandlerError extends Error {
  override readonly name = 'NoHandlerError';
}

export class TaskQueue {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly random: () => number = Math.random,
  ) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /** Synchronous: may run inside a business transaction. Call `syncAlarm()` afterwards. */
  enqueue(input: EnqueueTaskInput, now = Date.now()): EnqueueOutcome {
    const payload = JSON.stringify(input.payload ?? {});
    const runAt = now + Math.max(0, input.delayMs ?? 0);
    const existing = this.sql.exec<Pick<TaskRow, 'status' | 'run_at' | 'deadline_at'>>('SELECT status, run_at, deadline_at FROM tasks WHERE key = ?', input.key).toArray()[0];

    if (!existing) {
      this.sql.exec(
        `INSERT INTO tasks (key, kind, payload, run_at, deadline_at, status, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        input.key,
        input.kind,
        payload,
        runAt,
        Math.max(runAt, now + COALESCE_MAX_MS),
        input.priority,
        now,
        now,
      );
      return 'created';
    }
    if (existing.status === 'running') {
      this.sql.exec('UPDATE tasks SET rerun_requested = 1, payload = ?, updated_at = ? WHERE key = ?', payload, now, input.key);
      return 'rerun_requested';
    }
    if (existing.status === 'dead') {
      // Only R2 (or an operator) revives a dead task, at most once an hour (spec 12.2).
      return 'dead';
    }
    // Pending: coalesce. A deadline in the past (task waiting for a retry) opens a new window.
    const deadline = existing.deadline_at < now ? now + COALESCE_MAX_MS : existing.deadline_at;
    const newRunAt = Math.min(runAt, deadline);
    this.sql.exec(
      'UPDATE tasks SET run_at = ?, deadline_at = ?, payload = ?, priority = MIN(priority, ?), updated_at = ? WHERE key = ?',
      newRunAt,
      deadline,
      payload,
      input.priority,
      now,
      input.key,
    );
    return 'postponed';
  }

  /** Puts a dead task back to pending with its counter reset (R2, operator). */
  revive(key: string, now = Date.now()): boolean {
    const cursor = this.sql.exec(
      "UPDATE tasks SET status = 'pending', attempts = 0, run_at = ?, deadline_at = ?, last_error = NULL, updated_at = ? WHERE key = ? AND status = 'dead'",
      now,
      now + COALESCE_MAX_MS,
      now,
      key,
    );
    return cursor.rowsWritten > 0;
  }

  /** Running rows whose lease expired go back to pending with the same payload (spec 12.2, T-CH-05). */
  recoverExpiredLeases(now = Date.now()): number {
    return this.sql.exec(
      "UPDATE tasks SET status = 'pending', lease_until = NULL, lease_token = NULL, run_at = ?, updated_at = ? WHERE status = 'running' AND lease_until < ?",
      now,
      now,
      now,
    ).rowsWritten;
  }

  /** Next time the alarm must fire: smallest pending run_at, or the end of a running lease. */
  nextWakeUp(): number | null {
    const row = this.sql
      .exec<{ next: number | null }>(
        "SELECT MIN(CASE WHEN status = 'pending' THEN run_at WHEN status = 'running' THEN lease_until END) AS next FROM tasks WHERE status IN ('pending', 'running')",
      )
      .one();
    return row.next ?? null;
  }

  /** Sets the alarm on the next wake-up; only touches it when the time changes (spec 12.2). */
  async syncAlarm(active: boolean): Promise<void> {
    const next = active ? this.nextWakeUp() : null;
    const current = await this.storage.getAlarm();
    if (next === null) {
      if (current !== null) await this.storage.deleteAlarm();
      return;
    }
    if (current !== next) await this.storage.setAlarm(next);
  }

  /**
   * Runs due tasks by priority within the time budget. Never throws: each task has its own error
   * block, so an error counts against the task, not against the alarm.
   */
  async runDue(lookup: (kind: string) => TaskHandler | undefined, budgetMs = ALARM_BUDGET_MS): Promise<number> {
    const started = Date.now();
    let ran = 0;
    try {
      this.recoverExpiredLeases();
    } catch (error) {
      logEvent('error', 'tasks.recover_failed', { error: errorMessage(error) });
    }
    while (Date.now() - started < budgetMs) {
      let row: TaskRow | undefined;
      try {
        row = this.sql
          .exec<TaskRow>("SELECT * FROM tasks WHERE status = 'pending' AND run_at <= ? ORDER BY priority, run_at LIMIT 1", Date.now())
          .toArray()[0];
      } catch (error) {
        logEvent('error', 'tasks.select_failed', { error: errorMessage(error) });
        break;
      }
      if (!row) break;
      await this.runOne(row, lookup);
      ran += 1;
    }
    return ran;
  }

  private async runOne(row: TaskRow, lookup: (kind: string) => TaskHandler | undefined): Promise<void> {
    const leaseToken = crypto.randomUUID();
    const takenAt = Date.now();
    // Attempts are counted at take time (spec 12.2, T-CH-06).
    const taken = this.sql.exec(
      "UPDATE tasks SET status = 'running', attempts = attempts + 1, lease_until = ?, lease_token = ?, rerun_requested = 0, updated_at = ? WHERE key = ? AND status = 'pending'",
      takenAt + LEASE_MS,
      leaseToken,
      takenAt,
      row.key,
    ).rowsWritten;
    if (taken === 0) return;
    const attempt = row.attempts + 1;

    const holdsLease = (): boolean =>
      this.sql.exec('SELECT 1 FROM tasks WHERE key = ? AND lease_token = ? AND status = ?', row.key, leaseToken, 'running').toArray().length > 0;
    const renew = setInterval(() => {
      try {
        this.sql.exec('UPDATE tasks SET lease_until = ? WHERE key = ? AND lease_token = ?', Date.now() + LEASE_MS, row.key, leaseToken);
      } catch {
        // The next renewal or the completion will tell.
      }
    }, LEASE_RENEW_MS);

    try {
      const handler = lookup(row.kind);
      if (!handler) throw new NoHandlerError(`no handler for task kind ${row.kind}`);
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      const result = await handler({ key: row.key, kind: row.kind, payload, attempt, holdsLease });
      this.complete(row.key, leaseToken, result ?? undefined);
    } catch (error) {
      this.fail(row.key, leaseToken, attempt, error);
    } finally {
      clearInterval(renew);
    }
  }

  private complete(key: string, leaseToken: string, result: { rescheduleAt?: number | null } | undefined): void {
    try {
      this.storage.transactionSync(() => {
        const current = this.sql
          .exec<{ rerun_requested: number }>('SELECT rerun_requested FROM tasks WHERE key = ? AND lease_token = ?', key, leaseToken)
          .toArray()[0];
        if (!current) return; // lease lost: another execution owns the row now
        const now = Date.now();
        const rescheduleAt = current.rerun_requested ? now : (result?.rescheduleAt ?? null);
        if (rescheduleAt === null) {
          this.sql.exec('DELETE FROM tasks WHERE key = ?', key);
        } else {
          this.sql.exec(
            "UPDATE tasks SET status = 'pending', run_at = ?, deadline_at = ?, attempts = 0, rerun_requested = 0, lease_until = NULL, lease_token = NULL, last_error = NULL, updated_at = ? WHERE key = ?",
            rescheduleAt,
            Math.max(rescheduleAt, now + COALESCE_MAX_MS),
            now,
            key,
          );
        }
      });
    } catch (error) {
      logEvent('error', 'tasks.complete_failed', { key, error: errorMessage(error) });
    }
  }

  private fail(key: string, leaseToken: string, attempt: number, error: unknown): void {
    const message = errorMessage(error);
    try {
      const now = Date.now();
      if (error instanceof NoHandlerError || attempt >= MAX_ATTEMPTS) {
        this.sql.exec(
          "UPDATE tasks SET status = 'dead', lease_until = NULL, lease_token = NULL, last_error = ?, updated_at = ? WHERE key = ? AND lease_token = ?",
          message,
          now,
          key,
          leaseToken,
        );
        // TODO(lot 0, observability): critical anomaly and alert (spec 12.2, 17.2).
        logEvent('error', 'tasks.dead', { key, attempt, error: message });
        return;
      }
      const delay = backoffDelay(attempt, { baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS, random: this.random });
      this.sql.exec(
        "UPDATE tasks SET status = 'pending', run_at = ?, lease_until = NULL, lease_token = NULL, last_error = ?, updated_at = ? WHERE key = ? AND lease_token = ?",
        now + delay,
        message,
        now,
        key,
        leaseToken,
      );
      logEvent('warn', 'tasks.retry', { key, attempt, delay_ms: delay, error: message });
    } catch (dbError) {
      logEvent('error', 'tasks.fail_record_failed', { key, error: errorMessage(dbError) });
    }
  }
}
