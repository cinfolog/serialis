/**
 * Operations additions to the contract (spec 15.8 access rights, 17.1/17.2 observability): app users
 * and their role, health counters of the home screen, admin health section. Kept in their own file
 * and route table (`OPERATIONS_ROUTES`) so that the existing types and tables stay untouched.
 */
import type { IsoDateTime, Page } from './index.js';

// ---------------------------------------------------------------------------
// App users (15.8)
// ---------------------------------------------------------------------------

export type AppUserRole = 'admin' | 'operator';

/** A user of the shop who opened the app at least once (no e-mail, first name only when provided). */
export interface AppUser {
  /** Shopify user id (`sub` of the session token). */
  userId: string;
  firstName: string | null;
  role: AppUserRole;
  /** The owner (first user seen by the app) is always an administrator. */
  owner: boolean;
  /** User id of the administrator who designated this one, when designated. */
  designatedBy: string | null;
  firstSeenAt: IsoDateTime;
  lastSeenAt: IsoDateTime;
}

/** GET /app-users (admin) → Page<AppUser> (complete list, `nextCursor` null). */
export type ListAppUsersResponse = Page<AppUser>;

/**
 * PATCH /app-users (admin) → AppUser. Designates (or withdraws) an administrator among the users who
 * already opened the app; the owner stays administrator and the last administrator cannot be withdrawn
 * (422). `firstName: null` clears the first name.
 */
export interface PatchAppUserRequest {
  userId: string;
  role?: AppUserRole;
  firstName?: string | null;
}

// ---------------------------------------------------------------------------
// Health (17.1, 17.2)
// ---------------------------------------------------------------------------

/** Alerts derived from the counters (17.2 thresholds), shown as banners on the home screen. */
export type HealthAlert = 'task_dead' | 'task_overdue' | 'outbox_dead' | 'outbox_stuck' | 'reconnect_required' | 'frozen' | 'webhook_silence';

export interface HealthCounters {
  /** Tasks in `dead` (12.2). */
  tasksDead: number;
  /** Pending tasks due for more than 2 minutes (17.2). */
  tasksOverdue: number;
  /** Outbox rows in `dead` (12.4). */
  outboxDead: number;
  /** Outbox rows waiting (pending or in flight). */
  outboxPending: number;
  /** Rows waiting for more than 1 hour (17.2). */
  outboxPendingOver1h: number;
  /** Age of the oldest waiting row, in seconds (null when none). */
  outboxOldestPendingSeconds: number | null;
  /** The shop's Shopify tokens must be re-established by opening the app (13.9). */
  reconnectRequired: boolean;
  /** The shop is frozen by Shopify (402/423, 12.2): writes and passes suspended. */
  frozen: boolean;
}

/** Optional field added to `HomeStatsResponse` (GET /stats/home). */
export interface HomeStatsHealthExtras {
  health?: { counters: HealthCounters; alerts: HealthAlert[] };
}

/** GET /health (admin) — health section of the app. */
export interface HealthResponse {
  shopState: 'active' | 'frozen' | 'uninstalled';
  token: 'missing' | 'valid' | 'refreshing' | 'reconnect_required';
  schemaVersion: number;
  /** Size of the shop's database in bytes (alerts at 5 and 8 GB, 17.2). */
  databaseBytes: number | null;
  counters: HealthCounters;
  alerts: HealthAlert[];
  lastWebhookAt: IsoDateTime | null;
  passes: Array<{ pass: 'R1' | 'R2' | 'R3' | 'R4' | 'purge'; lastRunAt: IsoDateTime | null; nextRunAt: IsoDateTime | null }>;
  deadTasks: Array<{ key: string; kind: string; attempts: number; lastError: string | null; updatedAt: IsoDateTime }>;
  deadWrites: Array<{ id: number; kind: string; lastError: string | null; updatedAt: IsoDateTime }>;
}

// ---------------------------------------------------------------------------
// Health actions (12.7 `task_dead` « relancer depuis l'écran Santé », `outbox_dead` « Relancer »)
// ---------------------------------------------------------------------------

/**
 * POST /health/tasks/{key}/revive (admin) → 204 No Content. Puts a `dead` task back to `pending`
 * (same key, attempts reset, due now, 12.2); its `task_dead` anomaly closes when the task runs.
 * `key` is the task key of `HealthResponse.deadTasks`, URL-encoded. Empty body.
 * - 403 `forbidden` / `admin_required`: operator (15.8);
 * - 404 `not_found` / `task_not_dead`: no task with this key, or the task is not `dead`;
 * - 409 `invalid_transition` / `shop_frozen` or `reconnect_required`: retrying is pointless until
 *   Shopify unfreezes the shop or the merchant reopens the app (12.2, 13.9).
 */
export type ReviveTaskRequest = Record<string, never>;

/**
 * POST /health/writes/{id}/retry (admin) → 204 No Content. Puts a `dead` outbox row back to
 * `pending` at its next revision (new idempotency key, request prepared again, attempts reset, 12.4);
 * its `outbox_dead` anomaly closes when the row is sent. `id` is `HealthResponse.deadWrites[].id`.
 * Empty body. Same 403 / 404 (`write_not_dead`) / 409 answers as `reviveTask`.
 */
export type RetryWriteRequest = Record<string, never>;

/** Routes of this file (internal surface `/api/v1`, never on the public API). */
export const OPERATIONS_ROUTES = {
  listAppUsers: 'GET /app-users',
  patchAppUser: 'PATCH /app-users',
  health: 'GET /health',
  reviveTask: 'POST /health/tasks/{key}/revive',
  retryWrite: 'POST /health/writes/{id}/retry',
} as const;
