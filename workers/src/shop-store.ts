import { AdminGraphqlClient, CostThrottle } from '@serialis/shopify';
import { DurableObject } from 'cloudflare:workers';
import m0001 from '../../db/shop/0001_init.sql';
import m0002 from '../../db/shop/0002_allowed_transitions.sql';
import m0003 from '../../db/shop/0003_platform.sql';
import m0004 from '../../db/shop/0004_domain.sql';
import { handleApiCall } from './api/router.js';
import type { ApiCall, ApiResult } from './api/http.js';
import type { DomainContext } from './domain/context.js';
import { recordOrderEdit, shouldSchedule } from './domain/ingest.js';
import { runInventoryLevelCheck } from './domain/levels.js';
import { ensureReconciliation, runReconcile, type Pass } from './domain/reconcile.js';
import { DomainRepo } from './domain/repo.js';
import { requestOrderSync, runSyncOrder } from './domain/sync-order.js';
import { domainOutboxHooks } from './domain/writes.js';
import { shopifyFetch } from './shopify-fetch.js';
import type { Env } from './env.js';
import { taskHandler } from './handlers.js';
import { errorMessage, logEvent } from './log.js';
import { Outbox, type OutboxEnqueueInput } from './outbox.js';
import { OUTBOX_TASK_KEY, TASK_PRIORITY } from './task-kinds.js';
import { ALARM_BUDGET_MS, TaskQueue, type EnqueueTaskInput, type TaskHandler } from './tasks.js';
import { ReconnectRequiredError, TokenManager, type TokenStatus } from './tokens.js';
import { minimalCompliancePayload, topicAction, WEBHOOK_TASK_DELAY_MS, type TopicAction } from './topics.js';

/** Ordered shop schema migrations; the version is stored in `meta.schema_version` (spec 10.4). */
const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  { version: 1, sql: m0001 },
  { version: 2, sql: m0002 },
  { version: 3, sql: m0003 },
  { version: 4, sql: m0004 },
];

export type ShopState = 'active' | 'frozen' | 'uninstalled';

export interface IngestInput {
  webhookId: string;
  topic: string;
  triggeredAt: string | null;
  payload: string;
}

export type IngestResult =
  | { stored: true; action: TopicAction['type']; shopState: ShopState }
  | { stored: false; reason: 'duplicate'; shopState: ShopState }
  | { stored: false; reason: 'inactive'; shopState: ShopState }
  | { stored: false; reason: 'not_installed' };

export interface InstallInput {
  shopDomain: string;
  objectName: string;
  /** Session token for the offline token exchange; null to install without Shopify access (tests, support). */
  sessionToken: string | null;
}

export interface InstallResult {
  created: boolean;
  reactivated: boolean;
  installCount: number;
  installedAt: number;
  shopState: ShopState;
  token: TokenStatus;
}

export interface ShopStatus {
  installed: boolean;
  shopDomain: string | null;
  shopState: ShopState | null;
  installCount: number;
  installedAt: number | null;
  token: TokenStatus;
}

function parseBody(payload: string): Record<string, unknown> {
  try {
    const v = JSON.parse(payload) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Budget of the outbox inside one alarm run (the alarm has 25 s of work in total, spec 12.2). */
const OUTBOX_BUDGET_MS = 20_000;

/**
 * One object per shop: its SQLite database, tasks, alarms and outbox (spec 10.2, 11.2, 12).
 * The object initialises only on `install`: any other call to an object without a database
 * (never installed, or erased) is refused without creating a schema, task or alarm (spec 10.5).
 */
export class ShopStore extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly tasks: TaskQueue;
  private readonly outbox: Outbox;
  private readonly tokens: TokenManager;
  private readonly throttle = new CostThrottle();
  private client: AdminGraphqlClient | null = null;
  private readonly repo: DomainRepo;
  private readonly domain: DomainContext;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.tasks = new TaskQueue(ctx.storage);
    this.repo = new DomainRepo(this.sql);
    this.outbox = new Outbox(
      ctx.storage,
      () => this.meta('outbox_key_prefix') ?? 'serialis',
      Math.random,
      domainOutboxHooks({
        sql: this.sql,
        repo: this.repo,
        onMetafieldFailed: (orderGid) => requestOrderSync(this.domain, orderGid, 5_000),
      }),
    );
    this.tokens = new TokenManager(ctx.storage, {
      shop: () => this.meta('shop_domain') ?? '',
      apiKey: env.SHOPIFY_API_KEY,
      apiSecret: env.SHOPIFY_API_SECRET,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      fetch: (input, init) => shopifyFetch()(input, init),
    });
    const self = this;
    this.domain = {
      sql: this.sql,
      storage: ctx.storage,
      repo: this.repo,
      get shopDomain() {
        return self.meta('shop_domain') ?? '';
      },
      client: () => this.shopifyClient(),
      queueOutbox: (input, now) => this.queueOutbox(input, now),
      enqueueTask: (input, now) => this.tasks.enqueue(input, now),
    };
    // Pending migrations run before any other call (blockConcurrencyWhile, 30 s limit), then
    // interrupted work is released and the alarm re-armed (spec 12.2 "Baux", "Réarmement").
    ctx.blockConcurrencyWhile(async () => {
      if (this.schemaVersion() === 0) return;
      this.migrate();
      this.tasks.recoverExpiredLeases();
      this.outbox.recoverExpiredLeases();
      await this.tasks.syncAlarm(this.shopState() === 'active');
    });
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
        this.setMeta('schema_version', String(m.version));
      });
    }
  }

  // ---------------------------------------------------------------- installation (spec 9.14, 10.5)

  /** Idempotent: first call creates the schema, a call after `app/uninstalled` reactivates. */
  async install(input: InstallInput): Promise<InstallResult> {
    const created = this.schemaVersion() === 0;
    let reactivated = false;
    const now = Date.now();
    if (created) {
      this.migrate();
      this.ctx.storage.transactionSync(() => {
        this.setMeta('shop_domain', input.shopDomain);
        this.setMeta('object_name', input.objectName);
        this.setMeta('shop_state', 'active');
        this.setMeta('install_count', '1');
        this.setMeta('installed_at', String(now));
        // Idempotency keys must never repeat across databases of the same shop (reinstall after redaction).
        this.setMeta('outbox_key_prefix', crypto.randomUUID());
      });
      logEvent('info', 'shop.installed', { shop: input.shopDomain });
    } else {
      // The object is named after an authenticated shop: a mismatch is a routing defect.
      if (this.meta('shop_domain') !== input.shopDomain) throw new Error('shop_object_mismatch');
      if (this.shopState() === 'uninstalled') {
        this.ctx.storage.transactionSync(() => {
          this.setMeta('shop_state', 'active');
          this.setMeta('install_count', String(Number(this.meta('install_count') ?? '0') + 1));
          this.setMeta('installed_at', String(now));
          this.deleteMeta('uninstalled_at');
          // Full reconciliation before any automatic allocation (spec 9.14).
          this.setMeta('full_reconcile_required', '1');
        });
        reactivated = true;
        logEvent('info', 'shop.reactivated', { shop: input.shopDomain });
      }
    }
    if (input.sessionToken) await this.tokens.ensureExchanged(input.sessionToken);
    await this.tasks.syncAlarm(this.shopState() === 'active');
    return {
      created,
      reactivated,
      installCount: Number(this.meta('install_count') ?? '0'),
      installedAt: Number(this.meta('installed_at') ?? '0'),
      shopState: this.shopState() ?? 'active',
      token: this.tokens.status().status,
    };
  }

  status(): ShopStatus {
    if (this.schemaVersion() === 0) {
      return { installed: false, shopDomain: null, shopState: null, installCount: 0, installedAt: null, token: 'missing' };
    }
    return {
      installed: true,
      shopDomain: this.meta('shop_domain'),
      shopState: this.shopState(),
      installCount: Number(this.meta('install_count') ?? '0'),
      installedAt: Number(this.meta('installed_at') ?? '0') || null,
      token: this.tokens.status().status,
    };
  }

  /**
   * A valid access token for the Worker when it must call Shopify for the interface: the Worker
   * asks the object instead of reading tokens itself (spec 13.9). Never log the result.
   */
  async accessToken(): Promise<string> {
    this.assertInstalled();
    if (this.shopState() === 'uninstalled') throw new Error('shop_uninstalled');
    return this.tokens.getAccessToken();
  }

  // ---------------------------------------------------------------- ingestion (spec 12.1)

  /**
   * Stores a webhook once and schedules its task in the same transaction; Shopify retries and
   * duplicates are ignored (same webhook id). Idempotent, so RPC retries are harmless.
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    if (this.schemaVersion() === 0) return { stored: false, reason: 'not_installed' };
    let body: unknown = null;
    try {
      body = JSON.parse(input.payload);
    } catch {
      body = null;
    }
    const action = topicAction(input.topic, body);
    const state = this.shopState() ?? 'active';
    // An uninstalled shop only receives the compliance topics (spec 10.5).
    if (state === 'uninstalled' && action.type !== 'compliance') return { stored: false, reason: 'inactive', shopState: state };

    const now = Date.now();
    const stored = this.ctx.storage.transactionSync(() => {
      const payload = action.type === 'compliance' ? minimalCompliancePayload(action) : input.payload;
      const inserted = this.sql.exec(
        'INSERT INTO inbox (webhook_id, topic, received_at, triggered_at, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT (webhook_id) DO NOTHING',
        input.webhookId,
        input.topic,
        new Date(now).toISOString(),
        input.triggeredAt,
        payload,
      ).rowsWritten;
      if (inserted === 0) return false;
      this.applyAction(action, input, now);
      this.sql.exec('UPDATE inbox SET processed_at = ? WHERE webhook_id = ?', new Date(now).toISOString(), input.webhookId);
      return true;
    });

    const shopState = this.shopState() ?? 'active';
    await this.tasks.syncAlarm(shopState === 'active');
    if (!stored) return { stored: false, reason: 'duplicate', shopState };
    return { stored: true, action: action.type, shopState };
  }

  private applyAction(action: TopicAction, input: IngestInput, now: number): void {
    switch (action.type) {
      case 'task': {
        const body = parseBody(input.payload);
        if (input.topic === 'orders/edited') recordOrderEdit(this.domain, body, now);
        // 12.1: a task only when the event may concern a tracked item.
        if (!shouldSchedule(this.domain, action, input.topic, body, now)) return;
        this.tasks.enqueue({ key: action.key, kind: action.kind, priority: action.priority, payload: action.payload, delayMs: WEBHOOK_TASK_DELAY_MS }, now);
        return;
      }
      case 'compliance':
        // Processing (data request export, deferred redaction, shop/redact) comes with lot 5 / F14.
        this.sql.exec(
          "INSERT INTO compliance_requests (webhook_id, topic, order_gids, data_request_id, status, received_at) VALUES (?, ?, ?, ?, 'received', ?) ON CONFLICT (webhook_id) DO NOTHING",
          input.webhookId,
          action.topic,
          JSON.stringify(action.orderGids),
          action.dataRequestId,
          now,
        );
        return;
      case 'uninstall':
        this.uninstall(input.triggeredAt, now);
        return;
      case 'none':
        return;
    }
  }

  /**
   * `app/uninstalled` (spec 9.14): shop inactive, tasks suspended (alarm removed), tokens erased,
   * no more Shopify calls; data kept until `shop/redact`. A delivery triggered before the current
   * installation is ignored (spec 10.5, PV-29).
   */
  private uninstall(triggeredAt: string | null, now: number): void {
    const installedAt = Number(this.meta('installed_at') ?? '0');
    const triggered = triggeredAt ? Date.parse(triggeredAt) : NaN;
    if (Number.isFinite(triggered) && triggered < installedAt) {
      logEvent('warn', 'shop.stale_uninstall_ignored', { shop: this.meta('shop_domain'), triggered_at: triggeredAt });
      return;
    }
    this.setMeta('shop_state', 'uninstalled');
    this.setMeta('uninstalled_at', String(now));
    this.tokens.clear();
    this.client = null;
    logEvent('info', 'shop.uninstalled', { shop: this.meta('shop_domain') });
  }

  // ---------------------------------------------------------------- tasks and outbox (spec 12.2, 12.4)

  /** Schedules a task (domain, reconciliations). */
  async enqueueTask(input: EnqueueTaskInput): Promise<string> {
    this.assertInstalled();
    const outcome = this.tasks.enqueue(input);
    await this.tasks.syncAlarm(this.shopState() === 'active');
    return outcome;
  }

  reviveTask(key: string): boolean {
    this.assertInstalled();
    return this.tasks.revive(key);
  }

  /**
   * Queues a Shopify write and schedules the outbox task. The domain calls `queueOutbox` from inside
   * its own transaction; this RPC wraps it for callers outside the object.
   */
  async enqueueOutbox(input: OutboxEnqueueInput): Promise<{ id: number; created: boolean }> {
    this.assertInstalled();
    const result = this.ctx.storage.transactionSync(() => this.queueOutbox(input));
    await this.tasks.syncAlarm(this.shopState() === 'active');
    return result;
  }

  /** Synchronous, for use inside a business transaction. */
  queueOutbox(input: OutboxEnqueueInput, now = Date.now()): { id: number; created: boolean } {
    const result = this.outbox.enqueue(input, now);
    this.tasks.enqueue({ key: OUTBOX_TASK_KEY, kind: 'process_outbox', priority: TASK_PRIORITY.process_outbox }, now);
    return result;
  }

  override async alarm(): Promise<void> {
    // Never throws (spec 12.2): every task has its own error block and the alarm is always re-armed.
    try {
      if (this.schemaVersion() === 0) return;
      if (this.shopState() !== 'active') return;
      this.outbox.recoverExpiredLeases();
      await this.tasks.runDue((kind) => this.lookupHandler(kind), ALARM_BUDGET_MS);
    } catch (error) {
      logEvent('error', 'alarm.failed', { error: errorMessage(error) });
    } finally {
      try {
        if (this.schemaVersion() > 0) await this.tasks.syncAlarm(this.shopState() === 'active');
      } catch (error) {
        logEvent('error', 'alarm.rearm_failed', { error: errorMessage(error) });
      }
    }
  }

  private lookupHandler(kind: string): TaskHandler | undefined {
    if (kind === 'process_outbox') {
      return async () => {
        const { nextAt } = await this.outbox.process(() => this.shopifyClient(), OUTBOX_BUDGET_MS);
        return { rescheduleAt: nextAt };
      };
    }
    // A handler registered in the registry (tests, later lots) replaces the domain one.
    const registered = taskHandler(kind);
    if (registered) return registered;
    const domain = this.domainHandler(kind);
    if (!domain) return undefined;
    return async (ctx) => {
      try {
        return await domain(ctx);
      } catch (error) {
        // No usable token: wait for the merchant to open the app, without burning attempts (13.9).
        if (error instanceof ReconnectRequiredError) return { rescheduleAt: Date.now() + 5 * 60_000 };
        throw error;
      }
    };
  }

  /** Domain task handlers (spec 12.2, 12.3, 12.5). */
  private domainHandler(kind: string): TaskHandler | undefined {
    switch (kind) {
      case 'sync_order':
        return (ctx) => runSyncOrder(this.domain, String(ctx.payload.orderGid), ctx);
      case 'sync_inventory_level':
        return (ctx) => runInventoryLevelCheck(this.domain, ctx.payload, ctx);
      case 'reconcile':
        return (ctx) => runReconcile(this.domain, String(ctx.payload.pass) as Pass);
      case 'resolve':
        return (ctx) => this.resolveSubject(String(ctx.payload.gid));
      default:
        return undefined;
    }
  }

  /** `resolve:<gid>` (12.1): finds the order of a fulfillment order or return, then synchronizes it. */
  private async resolveSubject(gid: string): Promise<void> {
    const known =
      this.sql.exec<{ order_gid: string }>('SELECT order_gid FROM fulfillment_orders WHERE fo_gid = ?', gid).toArray()[0] ??
      this.sql.exec<{ order_gid: string }>('SELECT order_gid FROM return_map WHERE return_gid = ?', gid).toArray()[0];
    let orderGid = known?.order_gid ?? null;
    if (!orderGid && (gid.includes('/FulfillmentOrder/') || gid.includes('/Return/'))) {
      const field = gid.includes('/FulfillmentOrder/') ? 'fulfillmentOrder' : 'return';
      const { data } = await this.shopifyClient().request<Record<string, { order: { id: string } | null } | null>>(
        `query SerialisResolve($id: ID!) { ${field}(id: $id) { order { id } } }`,
        { variables: { id: gid }, estimatedCost: 2 },
      );
      orderGid = data[field]?.order?.id ?? null;
    }
    if (!orderGid) return;
    const target = orderGid;
    this.ctx.storage.transactionSync(() => requestOrderSync(this.domain, target));
  }

  // ---------------------------------------------------------------- API (spec 14)

  /**
   * Runs an authenticated API call (internal `/api/v1` or public API, spec 14.1): the caller has
   * verified the session token or API key and chosen this object from it.
   */
  async api(call: ApiCall): Promise<ApiResult> {
    if (this.schemaVersion() === 0) return { status: 403, headers: { 'Content-Type': 'application/problem+json' }, body: JSON.stringify({ type: 'https://serialis.dev/problems/forbidden', title: 'Forbidden', status: 403, code: 'forbidden', detail: 'shop_not_installed' }) };
    this.repo.setMeta('last_activity_at', String(Date.now()));
    try {
      return await handleApiCall(this.domain, call, () => ({
        shop: this.meta('shop_domain') ?? '',
        tokenStatus: this.tokens.status().status,
        shopState: this.shopState(),
      }));
    } finally {
      await this.tasks.syncAlarm(this.shopState() === 'active');
    }
  }

  /** Schedules the reconciliation passes (installation, activation of tracking). */
  async ensureReconciliation(): Promise<void> {
    this.assertInstalled();
    this.ctx.storage.transactionSync(() => ensureReconciliation(this.domain));
    await this.tasks.syncAlarm(this.shopState() === 'active');
  }

  /** Admin client of this shop; the token comes from the token manager (refreshed when needed). */
  shopifyClient(): AdminGraphqlClient {
    this.client ??= new AdminGraphqlClient({
      shop: this.meta('shop_domain') ?? '',
      accessToken: () => this.tokens.getAccessToken(),
      fetch: (input, init) => shopifyFetch()(input, init),
      throttle: this.throttle,
      onEvent: (event) => {
        if (event.type === 'throttle_wait') logEvent('info', 'shopify.throttle_wait', { ms: event.ms, reason: event.reason });
        else if (event.type === 'retry') logEvent('warn', 'shopify.retry', { attempt: event.attempt, kind: event.kind, delay_ms: event.delayMs });
      },
    });
    return this.client;
  }

  // ---------------------------------------------------------------- helpers

  /** Test and support helper: runs a synchronous read on the shop base. */
  inboxCount(): number {
    if (this.schemaVersion() === 0) return 0;
    return Number(this.sql.exec('SELECT count(*) AS n FROM inbox').one().n);
  }

  private assertInstalled(): void {
    if (this.schemaVersion() === 0) throw new Error('shop_not_installed');
  }

  private shopState(): ShopState | null {
    return (this.meta('shop_state') as ShopState | null) ?? null;
  }

  private meta(key: string): string | null {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  private deleteMeta(key: string): void {
    this.sql.exec('DELETE FROM meta WHERE key = ?', key);
  }

  /** Test helper for the transition triggers; the real API goes through applyTransition (lot 0/MVP). */
  createUnit(id: string, variantGid: string, locationId: string | null, status: string): void {
    this.assertInstalled();
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
    this.assertInstalled();
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
