/**
 * Shop-level resources: session info, home statistics, locations, settings and emergency stop
 * (spec 6.6, 14.2, 15.4; MVP 19.4).
 */
import { resolveSetting, SETTINGS, settingWarning, validateStoredSetting, type ScopeType, type SettingKey, type SettingValues } from '@serialis/core';
import type {
  ExtensionKey,
  HomeStatsHealthExtras,
  HomeStatsResponse,
  Location,
  MeResponse,
  MeResponseAdminExtras,
  PatchSettingsRequest,
  SettingScope,
  SettingsResponse,
  SettingsSimulation,
  SettingValue,
  SimulateSettingsRequest,
  StatusBanner,
  UnitState,
} from '@serialis/contract';
import { readLocations } from '../domain/shopify-read.js';
import { requestOrderSync } from '../domain/sync-order.js';
import { newId, parseJson } from '../domain/util.js';
import { ApiError, checkIfMatch, iso, json, parseBody, queryOne, type ApiResult } from './http.js';
import type { ApiContext } from './present.js';
import { isOwner, roleOf } from './users.js';
import { healthCounters, type HealthInfo } from './health.js';

const LOCATIONS_TTL_MS = 10 * 60_000;
const SIMULATION_TTL_MS = 10 * 60_000;
const EXTENSIONS: readonly ExtensionKey[] = ['variant_block', 'product_block', 'order_block', 'order_action'];

// ------------------------------------------------------------------------------------- me, home

export function me(ctx: ApiContext, info: { shop: string; tokenStatus: string; shopState: string | null }): ApiResult {
  const { repo, sql } = ctx.d;
  const shown = Object.fromEntries(EXTENSIONS.map((k) => [k, repo.meta(`extension_render:${k}`) !== null])) as Record<ExtensionKey, boolean>;
  const hasItems = repo.hasActiveItems();
  const hasUnits = sql.exec('SELECT 1 FROM units LIMIT 1').toArray().length > 0;
  const gap = sql.exec('SELECT 1 FROM tracked_items WHERE active = 1 AND initializing = 1 LIMIT 1').toArray().length > 0;
  const blocksDone = EXTENSIONS.every((k) => shown[k]);
  const step: MeResponse['onboarding']['step'] = !hasItems ? 'products' : !hasUnits ? 'refs' : gap ? 'gap' : !blocksDone ? 'blocks' : 'done';
  const banners: StatusBanner[] = [];
  if (info.shopState === 'frozen') banners.push('frozen');
  if (info.tokenStatus === 'reconnect_required') banners.push('reconnect_required');
  const body: MeResponse & MeResponseAdminExtras = {
    shop: info.shop,
    installed: true,
    onboarding: { completed: step === 'done', step },
    emergencyStop: repo.automationPaused(),
    locale: ctx.locale,
    role: roleOf(ctx.d, ctx.call.principal),
    owner: isOwner(ctx.d, ctx.call.principal),
    userId: ctx.call.principal.surface === 'internal' && ctx.call.principal.actor.type === 'user' ? ctx.call.principal.actor.id : null,
    banners,
    extensionsShown: shown,
  };
  return json(body);
}

export function homeStats(ctx: ApiContext, info: HealthInfo): ApiResult {
  const { sql, repo } = ctx.d;
  const now = ctx.now;
  const one = <T>(q: string, ...b: SqlStorageValue[]) => sql.exec(q, ...b).toArray()[0] as T | undefined;
  const lastWebhook = one<{ at: string | null }>('SELECT MAX(received_at) AS at FROM inbox')?.at ?? null;
  const lastRecon = repo.meta('last_reconciliation_at');
  const oldestDue = one<{ at: number | null }>("SELECT MIN(run_at) AS at FROM tasks WHERE status = 'pending' AND kind = 'sync_order' AND run_at <= ?", now)?.at ?? null;
  const pendingWrites = one<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE status IN ('pending', 'in_flight')")?.n ?? 0;
  const deadWrites = one<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE status = 'dead'")?.n ?? 0;
  const anomalyCount = (where: string) => one<{ n: number }>(`SELECT count(*) AS n FROM anomalies WHERE status IN ('open', 'acknowledged') AND ${where}`)?.n ?? 0;
  const critical = anomalyCount("severity = 'critical'");
  // Spec 17.1: the indicator summarises the synchronisation only (webhooks, reconciliation, delay, writes to Shopify).
  // Business anomalies (insufficient_units, shipped_without_unit...) are listed under « To handle now », not here.
  const SYNC_ANOMALIES = ['outbox_dead', 'task_dead', 'reconnect_required', 'consistency_violation', 'webhook_silence'];
  const syncCritical = anomalyCount(`severity = 'critical' AND type IN (${SYNC_ANOMALIES.map((t) => `'${t}'`).join(', ')})`);
  const delaySeconds = oldestDue === null ? 0 : Math.max(0, Math.round((now - oldestDue) / 1000));
  const health = healthCounters(ctx.d, info, now);
  const red = syncCritical > 0 || deadWrites > 0 || health.counters.tasksDead > 0 || health.counters.reconnectRequired;
  const level: HomeStatsResponse['sync']['level'] = red ? 'red' : delaySeconds > 60 || pendingWrites > 50 || health.alerts.length > 0 ? 'orange' : 'green';

  // Share of tracked lines allocated in under 60 s (19.4 success criterion), over 30 days.
  const since = now - 30 * 86_400_000;
  const samples = sql
    .exec<{ allocated_at: number; created: number | null }>(
      `SELECT MIN(a.allocated_at) AS allocated_at, (SELECT order_created_at FROM order_sync WHERE order_gid = a.order_gid) AS created
       FROM allocations a WHERE a.source = 'auto' AND a.allocated_at >= ? GROUP BY a.order_gid, a.line_item_gid`,
      since,
    )
    .toArray()
    .filter((r) => r.created !== null);
  const byDay = new Map<string, { ok: number; n: number }>();
  let ok = 0;
  for (const s of samples) {
    const fast = s.allocated_at - (s.created as number) <= 60_000;
    if (fast) ok += 1;
    const day = new Date(s.created as number).toISOString().slice(0, 10);
    const d = byDay.get(day) ?? { ok: 0, n: 0 };
    d.n += 1;
    if (fast) d.ok += 1;
    byDay.set(day, d);
  }
  const history: HomeStatsResponse['assignedUnder60s']['history30d'] = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    const d = byDay.get(day);
    history.push({ date: day, rate: d ? d.ok / d.n : null });
  }

  const response: HomeStatsResponse & HomeStatsHealthExtras = {
    sync: {
      level,
      lastWebhookAt: lastWebhook,
      lastReconciliationAt: lastRecon ? new Date(Number(lastRecon)).toISOString() : null,
      delaySeconds,
      pendingWrites,
    },
    toDo: {
      linesWithoutUnit: one<{ q: number | null }>('SELECT SUM(quantity) AS q FROM uncovered_lines')?.q ?? 0,
      criticalAnomalies: critical,
      returnsToIdentify: anomalyCount("type = 'return_unidentified'"),
      shippedUnitsToDesignate: anomalyCount("type IN ('shipped_without_unit', 'pos_sold_without_unit', 'preexisting_sale_to_designate', 'shipped_unit_to_confirm')"),
    },
    unitsByState: sql
      .exec<{ location_id: string; status: UnitState; n: number }>('SELECT location_id, status, count(*) AS n FROM units WHERE location_id IS NOT NULL GROUP BY location_id, status ORDER BY location_id, status')
      .toArray()
      .map((r) => ({ locationId: r.location_id, state: r.status, count: r.n })),
    assignedUnder60s: { rate: samples.length > 0 ? ok / samples.length : null, sample: samples.length, history30d: history },
    health,
  };
  return json(response);
}

// ------------------------------------------------------------------------------------- locations

export async function listLocations(ctx: ApiContext): Promise<ApiResult> {
  const { repo } = ctx.d;
  const current = repo.locations();
  const fresh = current.length > 0 && current.every((l) => l.name !== '') && current.every((l) => ctx.now - l.updatedAt < LOCATIONS_TTL_MS);
  if (!fresh || queryOne(ctx.call, 'refresh') === '1') {
    const now = Date.now();
    const read = await readLocations(ctx.d.client());
    ctx.d.storage.transactionSync(() => {
      for (const l of read) repo.upsertLocation({ id: l.id, name: l.name, active: l.isActive }, now);
    });
  }
  const items: Location[] = repo.locations().map((l) => ({ id: l.id, name: l.name, active: l.active }));
  return json({ items, nextCursor: null });
}

// ------------------------------------------------------------------------------------- settings (6.6)

/**
 * API encoding of the values (app/DECISIONS.md 4): choice ids, booleans, minutes for S-22,
 * S-36 split in two keys, S-37 pattern apart. S-35 to S-37 apply to the `serial` identifier type
 * (stored in `identifier_types`, 11.2) and are read and written at the shop scope.
 */
type ApiValue = string | number | boolean;

interface Codec {
  key: SettingKey;
  toCore(v: ApiValue): unknown;
  fromCore(v: unknown): ApiValue;
}

const enumCodec = (key: SettingKey, map: Record<string, string>): Codec => {
  const reverse = Object.fromEntries(Object.entries(map).map(([a, c]) => [c, a]));
  return { key, toCore: (v) => (typeof v === 'string' && v in map ? map[v] : `invalid:${String(v)}`), fromCore: (v) => reverse[String(v)] ?? String(v) };
};
const identity = (key: SettingKey): Codec => ({ key, toCore: (v) => v, fromCore: (v) => v as ApiValue });

const CODECS: Record<string, Codec> = {
  'S-05': enumCodec('S-05', { fifo: 'fifo', earliest_expiry: 'fefo', manual: 'manual' }),
  'S-08': identity('S-08'),
  'S-09': enumCodec('S-09', { to_verify: 'manual', auto_resolve: 'auto' }),
  'S-11': identity('S-11'),
  'S-17': identity('S-17'),
  'S-22': { key: 'S-22', toCore: (v) => (typeof v === 'number' ? v * 60_000 : NaN), fromCore: (v) => Math.round(Number(v) / 60_000) },
  'S-25': enumCodec('S-25', { automatic: 'auto', on_decision: 'on_decision' }),
  'S-38': identity('S-38'),
  'S-40': {
    key: 'S-40',
    toCore: (v) => (v === 'owner_digest' || v === 'owner_no_digest' ? { recipients: 'owner', outgoingWebhook: false, dailyDigest: v === 'owner_digest' } : null),
    fromCore: (v) => ((v as SettingValues['S-40']).dailyDigest ? 'owner_digest' : 'owner_no_digest'),
  },
};

const IDENTIFIER_KEYS = ['S-35', 'S-36.strip_spaces', 'S-36.normalize_upper', 'S-37', 'S-37.pattern'] as const;
const LISTED_KEYS = ['S-01', 'S-05', 'S-08', 'S-09', 'S-11', 'S-17', 'S-22', 'S-24', 'S-25', ...IDENTIFIER_KEYS, 'S-38', 'S-40'] as const;
const FIXED_KEYS = new Set(['S-01', 'S-24']);

function parseScope(raw: string | undefined): { scope: SettingScope; type: ScopeType; id: string } {
  const s = raw ?? 'shop';
  if (s === 'shop') return { scope: 'shop', type: 'shop', id: '' };
  const m = /^(location|tracked_item):(.+)$/.exec(s);
  if (!m) throw new ApiError(422, 'validation_failed', `invalid scope ${s}`);
  return { scope: s as SettingScope, type: m[1] as ScopeType, id: m[2]! };
}

function settingsEtag(ctx: ApiContext): string {
  return `"s${ctx.d.repo.meta('settings_version') ?? '0'}"`;
}

function baseKey(key: string): SettingKey {
  return key.split('.')[0] as SettingKey;
}

function readValues(ctx: ApiContext, scope: { scope: SettingScope; type: ScopeType; id: string }): SettingValue[] {
  const { repo } = ctx.d;
  const stored = repo.storedSettings();
  const types = repo.identifierTypes();
  const serial = types.find((t) => t.key === 'serial');
  const out: SettingValue[] = [];
  for (const key of LISTED_KEYS) {
    const def = SETTINGS[baseKey(key)];
    if (FIXED_KEYS.has(key)) {
      out.push({ key, value: String(def.fixedInMvp), origin: 'fixed', changeRule: def.changeRule === 'simulation' ? 'simulation' : 'immediate' });
      continue;
    }
    const changeRule = def.changeRule === 'simulation' ? 'simulation' : 'immediate';
    if ((IDENTIFIER_KEYS as readonly string[]).includes(key)) {
      if (scope.type !== 'shop' || !serial) continue;
      const k = key as (typeof IDENTIFIER_KEYS)[number];
      const custom = { 'S-35': serial.scope !== 'shop', 'S-36.strip_spaces': !serial.stripSpaces, 'S-36.normalize_upper': !serial.normalizeUpper, 'S-37': serial.validation !== 'none', 'S-37.pattern': serial.regex !== null }[k];
      const value = { 'S-35': serial.scope, 'S-36.strip_spaces': serial.stripSpaces, 'S-36.normalize_upper': serial.normalizeUpper, 'S-37': serial.validation, 'S-37.pattern': serial.regex ?? '' }[k];
      out.push({ key, value, origin: custom ? 'shop' : 'default', changeRule: key === 'S-37.pattern' ? 'immediate' : changeRule });
      continue;
    }
    const codec = CODECS[key]!;
    if (!def.scopes.includes(scope.type) && scope.type !== 'shop') continue;
    const ctxScope = scope.type === 'tracked_item' ? { trackedItemId: scope.id } : scope.type === 'location' ? { locationId: scope.id } : {};
    const applied = resolveSetting(codec.key, ctxScope, stored);
    const own = stored.find((s) => s.key === codec.key && s.scopeType === scope.type && s.scopeId === scope.id);
    const inheritedFrom = (['tracked_item', 'location', 'shop'] as const).find((t) =>
      stored.some((s) => s.key === codec.key && s.scopeType === t && (t === 'shop' ? s.scopeId === '' : t === 'tracked_item' ? s.scopeId === (ctxScope as { trackedItemId?: string }).trackedItemId : s.scopeId === (ctxScope as { locationId?: string }).locationId)),
    );
    out.push({ key, value: codec.fromCore(applied), origin: own ? (scope.type as SettingValue['origin']) : (inheritedFrom ?? 'default'), changeRule });
  }
  return out;
}

export function getSettings(ctx: ApiContext): ApiResult {
  const scope = parseScope(queryOne(ctx.call, 'scope'));
  const response: SettingsResponse = { scope: scope.scope, values: readValues(ctx, scope) };
  return json(response, 200, { ETag: settingsEtag(ctx) });
}

interface Change {
  key: string;
  value: ApiValue | null;
  core?: { key: SettingKey; value: unknown };
}

/** Validates the requested values (T-SET-01: 422 on a value out of the list or a scope not allowed). */
function validateChanges(ctx: ApiContext, scope: { type: ScopeType; id: string }, values: Record<string, ApiValue | null>): Change[] {
  const changes: Change[] = [];
  const errors: Array<{ field: string; code: 'validation_failed' | 'incompatible_settings'; detail: string }> = [];
  for (const [key, value] of Object.entries(values ?? {})) {
    if (FIXED_KEYS.has(key)) {
      errors.push({ field: key, code: 'validation_failed', detail: 'fixed_in_mvp' });
      continue;
    }
    if ((IDENTIFIER_KEYS as readonly string[]).includes(key)) {
      if (scope.type !== 'shop') errors.push({ field: key, code: 'validation_failed', detail: 'scope_not_allowed' });
      else if (value === null) changes.push({ key, value });
      else if (key === 'S-35' && value !== 'shop' && value !== 'product') errors.push({ field: key, code: 'validation_failed', detail: 'invalid_value' });
      else if (key === 'S-37' && value !== 'none' && value !== 'luhn' && value !== 'regex') errors.push({ field: key, code: 'validation_failed', detail: 'invalid_value' });
      else if (key.startsWith('S-36.') && typeof value !== 'boolean') errors.push({ field: key, code: 'validation_failed', detail: 'invalid_value' });
      else if (key === 'S-37.pattern') {
        try {
          new RegExp(`^(?:${String(value)})$`, 'u');
          changes.push({ key, value });
        } catch {
          errors.push({ field: key, code: 'validation_failed', detail: 'invalid_regex' });
        }
      } else changes.push({ key, value });
      continue;
    }
    const codec = CODECS[key];
    if (!codec) {
      errors.push({ field: key, code: 'validation_failed', detail: 'unknown_key' });
      continue;
    }
    if (value === null) {
      changes.push({ key, value, core: { key: codec.key, value: null } });
      continue;
    }
    const core = codec.toCore(value);
    const v = validateStoredSetting({ scopeType: scope.type, scopeId: scope.id, key: codec.key, value: core });
    if (!v.ok) errors.push({ field: key, code: 'validation_failed', detail: v.error });
    else changes.push({ key, value, core: { key: codec.key, value: core } });
  }
  const pattern = values['S-37.pattern'];
  const serial = ctx.d.repo.identifierTypes().find((t) => t.key === 'serial');
  if (values['S-37'] === 'regex' && !pattern && !serial?.regex) errors.push({ field: 'S-37.pattern', code: 'incompatible_settings', detail: 'regex validation needs a pattern' });
  if (errors.length > 0) {
    const code = errors.every((e) => e.code === 'incompatible_settings') ? 'incompatible_settings' : 'validation_failed';
    throw new ApiError(422, code, errors.map((e) => `${e.field}: ${e.detail}`).join('; '), errors);
  }
  return changes;
}

function needsSimulation(key: string): boolean {
  if (key === 'S-37.pattern') return false;
  return SETTINGS[baseKey(key)].changeRule === 'simulation';
}

/** S-35 → shop is refused while two products share a normalised identifier (6.6.2). */
function scopeConflicts(ctx: ApiContext): number {
  return (
    ctx.d.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM (SELECT value_norm FROM unit_identifiers WHERE type = 'serial' AND retired_at IS NULL GROUP BY value_norm HAVING count(*) > 1)")
      .toArray()[0]?.n ?? 0
  );
}

export function simulateSettings(ctx: ApiContext): ApiResult {
  const body = parseBody<SimulateSettingsRequest>(ctx.call);
  const scope = parseScope(body.scope);
  const changes = validateChanges(ctx, scope, body.values ?? {});
  const { sql } = ctx.d;
  const effects: SettingsSimulation['effects'] = [];
  const warnings: string[] = [];
  for (const c of changes) {
    let count = 0;
    let summary = 'no_object_affected';
    if (c.key === 'S-35') {
      count = c.value === 'shop' ? scopeConflicts(ctx) : 0;
      summary = count > 0 ? 'duplicates_block_shop_scope' : 'identifiers_rescoped';
    } else if (c.key === 'S-11') {
      count = sql.exec<{ n: number }>("SELECT count(*) AS n FROM order_sync WHERE status IN ('ok', 'short')").toArray()[0]?.n ?? 0;
      summary = 'applies_to_next_synchronizations';
    } else if (c.key === 'S-38') {
      count = sql.exec<{ n: number }>("SELECT count(DISTINCT order_gid) AS n FROM allocations WHERE status IN ('active', 'fulfilled')").toArray()[0]?.n ?? 0;
      summary = c.value === false ? 'metafields_removed_at_next_sync' : 'metafields_written_at_next_sync';
    } else if (c.key === 'S-09' || c.key === 'S-17' || c.key.startsWith('S-36')) {
      summary = 'applies_to_next_events';
    }
    effects.push({ key: c.key, count, summary });
    if (c.core && c.value !== null) {
      const w = settingWarning(c.core.key, c.core.value);
      if (w) warnings.push(w[ctx.locale]);
    }
  }
  const id = newId(ctx.now);
  const expiresAt = ctx.now + SIMULATION_TTL_MS;
  ctx.d.repo.setMeta(`settings_simulation:${id}`, JSON.stringify({ scope: scope.scope, values: body.values, expiresAt }));
  const response: SettingsSimulation = { simulationId: id, expiresAt: new Date(expiresAt).toISOString(), effects, warnings };
  return json(response, 201);
}

/** Orders whose synchronization a "simulation" setting changes (same sets as the simulation, 14.2). */
function concernedOrders(ctx: ApiContext, keys: string[]): Set<string> {
  const { sql } = ctx.d;
  const out = new Set<string>();
  if (keys.includes('S-38')) {
    for (const r of sql.exec<{ order_gid: string }>("SELECT DISTINCT order_gid FROM allocations WHERE status IN ('active', 'fulfilled')").toArray()) out.add(r.order_gid);
  }
  if (keys.includes('S-11')) {
    for (const r of sql.exec<{ order_gid: string }>("SELECT order_gid FROM order_sync WHERE status IN ('ok', 'short', 'pending')").toArray()) out.add(r.order_gid);
  }
  return out;
}

export function patchSettings(ctx: ApiContext): ApiResult {
  const body = parseBody<PatchSettingsRequest & { values: Record<string, ApiValue | null> }>(ctx.call);
  checkIfMatch(ctx.call, settingsEtag(ctx));
  const scope = parseScope(body.scope);
  const changes = validateChanges(ctx, scope, body.values ?? {});
  const simulated = changes.filter((c) => needsSimulation(c.key));
  if (simulated.length > 0) {
    // 14.2: a "simulation" setting is saved only with a recent simulation of the same values.
    const sim = body.simulationId ? parseJson<{ scope: string; values: Record<string, unknown>; expiresAt: number } | null>(ctx.d.repo.meta(`settings_simulation:${body.simulationId}`), null) : null;
    const matches = sim && sim.expiresAt > ctx.now && sim.scope === scope.scope && simulated.every((c) => JSON.stringify(sim.values[c.key] ?? null) === JSON.stringify(c.value));
    if (!matches) throw new ApiError(409, 'simulation_expired', `simulate first: ${simulated.map((c) => c.key).join(', ')}`);
  }
  const { repo, sql } = ctx.d;
  const actor = ctx.call.principal.actor;
  const now = ctx.now;
  ctx.d.storage.transactionSync(() => {
    const before = readValues(ctx, scope);
    for (const c of changes) {
      if (c.core) {
        if (c.value === null) repo.deleteSetting(scope.type, scope.id, c.core.key);
        else repo.putSetting({ scopeType: scope.type, scopeId: scope.id, key: c.core.key, value: c.core.value, updatedBy: actor.id, now });
        continue;
      }
      const v = c.value;
      switch (c.key) {
        case 'S-35': {
          const next = v ?? 'shop';
          if (next === 'shop' && scopeConflicts(ctx) > 0) throw new ApiError(422, 'incompatible_settings', 'two products share an identifier: shop-wide uniqueness refused');
          sql.exec("UPDATE identifier_types SET scope = ? WHERE key = 'serial'", next);
          // Every scope key of the type is recomputed in the same transaction (11.2).
          sql.exec(
            next === 'shop'
              ? "UPDATE unit_identifiers SET scope_key = 'shop' WHERE type = 'serial'"
              : "UPDATE unit_identifiers SET scope_key = (SELECT t.product_gid FROM units u JOIN tracked_items t ON t.id = u.tracked_item_id WHERE u.id = unit_identifiers.unit_id) WHERE type = 'serial'",
          );
          break;
        }
        case 'S-36.strip_spaces':
          sql.exec("UPDATE identifier_types SET strip_spaces = ? WHERE key = 'serial'", v === null ? 1 : v ? 1 : 0);
          break;
        case 'S-36.normalize_upper':
          sql.exec("UPDATE identifier_types SET normalize_upper = ? WHERE key = 'serial'", v === null ? 1 : v ? 1 : 0);
          break;
        case 'S-37':
          sql.exec("UPDATE identifier_types SET validation = ? WHERE key = 'serial'", v ?? 'none');
          break;
        case 'S-37.pattern':
          sql.exec("UPDATE identifier_types SET regex = ? WHERE key = 'serial'", v === null || v === '' ? null : String(v));
          break;
      }
    }
    repo.setMeta('settings_version', String(Number(repo.meta('settings_version') ?? '0') + 1));
    repo.audit(actor, 'settings.update', before, { scope: scope.scope, values: body.values }, now);
    // 6.6.1: a "simulation" setting is applied to what is in progress: each concerned order is synchronized now.
    for (const orderGid of concernedOrders(ctx, simulated.map((c) => c.key))) requestOrderSync(ctx.d, orderGid, 0, now);
  });
  const response: SettingsResponse = { scope: scope.scope, values: readValues(ctx, scope) };
  return json(response, 200, { ETag: settingsEtag(ctx) });
}

// ------------------------------------------------------------------------------------- emergency stop (EF-33, P-02)

export function setAutomation(ctx: ApiContext, paused: boolean): ApiResult {
  const { repo, sql } = ctx.d;
  const now = ctx.now;
  ctx.d.storage.transactionSync(() => {
    const before = repo.automationPaused();
    repo.setMeta('automation_paused', paused ? '1' : '0');
    if (before !== paused) repo.audit(ctx.call.principal.actor, paused ? 'automation.pause' : 'automation.resume', { paused: before }, { paused }, now);
    if (!paused) {
      // Waiting lines get their units now (the stop only suspended automatic allocation).
      for (const r of sql.exec<{ order_gid: string }>('SELECT DISTINCT order_gid FROM uncovered_lines').toArray()) requestOrderSync(ctx.d, r.order_gid, 0, now);
    }
  });
  return json({ emergencyStop: paused });
}

export { iso };
