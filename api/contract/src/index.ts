/**
 * Serialis API contract (spec 14) — MVP subset, shared by the Worker, the embedded admin app
 * and the admin UI extensions.
 *
 * Two surfaces expose the same resources:
 *  - internal: `https://<app host>/api/v1/...`, authenticated by the Shopify session token
 *    (embedded app via App Bridge, admin extensions via their authenticated fetch);
 *  - public: `https://api.serialis.dev/v1/...`, authenticated by an API key (spec 14.1).
 * Rules (14.1): JSON, `Idempotency-Key` required on every POST, `If-Match` (ETag from unit
 * `version`) on PATCH and transitions, cursor pagination (`limit` ≤ 250), errors as
 * problem+json (RFC 9457) with a stable `code`.
 */

export * from './operations.js';
import { OPERATIONS_ROUTES } from './operations.js';

export const API_VERSION = 'v1' as const;
export const INTERNAL_BASE = '/api/v1' as const;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type Gid = string; // e.g. gid://shopify/ProductVariant/123
export type IsoDateTime = string;

export type UnitState =
  | 'INCOMING' | 'AVAILABLE' | 'HELD' | 'ALLOCATED' | 'QUALITY_CONTROL' | 'DAMAGED' | 'IN_TRANSIT'
  | 'SHIPPED' | 'RETURN_PENDING' | 'TO_VERIFY' | 'LOST' | 'SCRAPPED' | 'UNTRACKED';

export interface Identifier {
  id: string;
  type: string; // identifier type key, e.g. "serial", "imei"
  value: string;
  primary: boolean;
}

export interface Unit {
  id: string;
  variantGid: Gid;
  locationId: string | null;
  state: UnitState;
  identifiers: Identifier[];
  /** Primary ref, convenience copy of the primary identifier value. */
  ref: string;
  receivedAt: IsoDateTime | null;
  /** Set when the unit is allocated or shipped. */
  orderGid: Gid | null;
  version: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  /** Field- or item-level errors, e.g. for batch creation. */
  errors?: Array<{ index?: number; field?: string; code: ErrorCode; detail?: string }>;
}

export type ErrorCode =
  | 'unauthenticated' | 'forbidden' | 'not_found' | 'validation_failed'
  | 'idempotency_conflict' | 'precondition_failed' | 'rate_limited'
  | 'unit_not_available' | 'identifier_conflict' | 'invalid_transition'
  | 'variant_mismatch' | 'location_mismatch' | 'ambiguous_ref' | 'unknown_ref'
  | 'not_tracked' | 'emergency_stop' | 'simulation_expired' | 'incompatible_settings';

// ---------------------------------------------------------------------------
// Session (internal surface only)
// ---------------------------------------------------------------------------

/** GET /api/v1/me */
export interface MeResponse {
  shop: string;
  installed: boolean;
  /** Onboarding progress (15.4 "Démarrage"). */
  onboarding: { completed: boolean; step: 'products' | 'refs' | 'gap' | 'blocks' | 'done' };
  emergencyStop: boolean;
  locale: 'fr' | 'en';
}

// ---------------------------------------------------------------------------
// Tracked items (variants under tracking)
// ---------------------------------------------------------------------------

export interface TrackedItem {
  variantGid: Gid;
  productGid: Gid;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  mode: 'interchangeable';
  /** Phase where existing Shopify stock is being registered without writes (S-25). */
  initializing: boolean;
  activatedAt: IsoDateTime;
  /** Per location: Shopify `on_hand` vs registered units (gap of 8.1). */
  stock: Array<{ locationId: string; shopifyOnHand: number; registeredUnits: number; availableUnits: number }>;
}

/** GET /tracked-items?cursor&limit → Page<TrackedItem> */
/** POST /tracked-items */
export interface TrackItemsRequest {
  variantGids: Gid[];
  /** Apply to already open orders (T-E2E-40 option); default false. */
  applyToOpenOrders?: boolean;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** GET /units?variant=&location=&state=&q=&cursor=&limit= → Page<Unit> */
export interface ListUnitsQuery {
  variant?: Gid;
  location?: string;
  state?: UnitState | UnitState[];
  q?: string;
  cursor?: string;
  limit?: number;
}

/**
 * POST /units/batch — add refs for one variant at one location.
 * `alreadyCounted`: units already counted in Shopify's on_hand (no stock write, 6.1 / F10);
 * otherwise they are received now (+available per unit).
 */
export interface CreateUnitsBatchRequest {
  variantGid: Gid;
  locationId: string;
  refs: string[];
  alreadyCounted: boolean;
  /** "atomic": all or nothing; "per_item": create what is valid, report the rest. */
  mode: 'atomic' | 'per_item';
}
export interface CreateUnitsBatchResponse {
  created: Unit[];
  rejected: Array<{ index: number; ref: string; code: ErrorCode; detail?: string }>;
}

/** GET /lookup?identifier= → { unit: Unit | null } */
export interface LookupResponse {
  unit: Unit | null;
}

// ---------------------------------------------------------------------------
// Orders and allocations
// ---------------------------------------------------------------------------

export interface Allocation {
  id: string;
  unitId: string;
  ref: string;
  orderGid: Gid;
  lineItemGid: Gid;
  variantGid: Gid;
  locationId: string;
  status: 'active' | 'fulfilled' | 'released' | 'returned';
  source: 'auto' | 'pick' | 'pos' | 'draft' | 'api' | 'late' | 'migration';
  toConfirm: boolean;
  allocatedAt: IsoDateTime;
}

/** GET /orders/{orderId}/allocations */
export interface OrderAllocationsResponse {
  orderGid: Gid;
  /** One entry per Shopify line, one allocation per unit (F15). */
  lines: Array<{
    lineItemGid: Gid;
    variantGid: Gid;
    title: string;
    tracked: boolean;
    quantity: number;
    allocations: Allocation[];
    /** Units still missing for this line (awaiting_unit / insufficient_units). */
    missing: number;
  }>;
  syncState: 'pending' | 'synced' | 'error';
  syncedAt: IsoDateTime | null;
}

/**
 * POST /allocations — allocate a unit to a line (before preparation, list choice allowed);
 * `ref` is resolved with the designation rule (15.5): full ref, or last 4 chars if unique.
 */
export interface CreateAllocationRequest {
  orderGid: Gid;
  lineItemGid: Gid;
  unitId?: string;
  ref?: string;
}
/** POST /allocations/{id}/replace */
export interface ReplaceAllocationRequest {
  unitId?: string;
  ref?: string;
}
/** POST /allocations/{id}/confirm-shipped — designate the unit really shipped (typed ref only, 15.5). */
export interface ConfirmShippedRequest {
  ref: string;
}
/** DELETE /allocations/{id} → 204 */

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

/** POST /returns/{returnId}/identify — typed ref of the received unit (S-17, 15.5). */
export interface IdentifyReturnRequest {
  returnLineItemGid: Gid;
  ref: string;
}

// ---------------------------------------------------------------------------
// Anomalies
// ---------------------------------------------------------------------------

export type AnomalySeverity = 'critical' | 'warning' | 'info';

export interface Anomaly {
  id: string;
  type: string; // catalogue key of 12.7, e.g. "awaiting_unit"
  severity: AnomalySeverity;
  status: 'open' | 'acknowledged' | 'resolved';
  orderGid: Gid | null;
  variantGid: Gid | null;
  unitId: string | null;
  locationId: string | null;
  summary: string;
  /** Resolution actions allowed for this type (12.7). */
  actions: Array<{ action: string; label: string; writesStock: boolean; needsRef: boolean }>;
  openedAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
}

/** GET /anomalies?status=&severity=&type=&cursor= → Page<Anomaly> */
/** POST /anomalies/{id}/resolve */
export interface ResolveAnomalyRequest {
  action: string;
  params?: Record<string, unknown> & { ref?: string };
}

// ---------------------------------------------------------------------------
// Locations, settings, imports, automation
// ---------------------------------------------------------------------------

export interface Location {
  id: string;
  name: string;
  active: boolean;
}

export type SettingScope = 'shop' | `location:${string}` | `tracked_item:${string}`;

export interface SettingValue {
  key: string; // e.g. "S-05"
  value: string | number | boolean;
  origin: 'default' | 'shop' | 'location' | 'tracked_item' | 'fixed';
  changeRule: 'immediate' | 'simulation';
}

/** GET /settings?scope= → { scope, values } ; PATCH /settings { scope, values, simulationId? } */
export interface SettingsResponse {
  scope: SettingScope;
  values: SettingValue[];
}
export interface PatchSettingsRequest {
  scope: SettingScope;
  /** `null` removes the value stored at this scope (back to the inherited value or the default, T-SET-06). */
  values: Record<string, string | number | boolean | null>;
  simulationId?: string;
}

/** POST /imports (CSV: ref, sku or variant id, location, already_counted) → simulation report */
export interface ImportReport {
  id: string;
  status: 'simulated' | 'confirmed' | 'failed';
  rows: number;
  valid: number;
  errors: Array<{ row: number; code: ErrorCode; detail: string }>;
}

/** POST /automation/pause | /automation/resume → { emergencyStop: boolean } */

// ---------------------------------------------------------------------------
// Route table (used by the UI clients and by the contract test, spec 14.2 coverage)
// ---------------------------------------------------------------------------

export const ROUTES = {
  me: 'GET /me',
  listTrackedItems: 'GET /tracked-items',
  trackItems: 'POST /tracked-items',
  listUnits: 'GET /units',
  getUnit: 'GET /units/{id}',
  createUnitsBatch: 'POST /units/batch',
  lookup: 'GET /lookup',
  unitEvents: 'GET /units/{id}/events',
  orderAllocations: 'GET /orders/{orderId}/allocations',
  createAllocation: 'POST /allocations',
  deleteAllocation: 'DELETE /allocations/{id}',
  replaceAllocation: 'POST /allocations/{id}/replace',
  confirmShipped: 'POST /allocations/{id}/confirm-shipped',
  identifyReturn: 'POST /returns/{returnId}/identify',
  listAnomalies: 'GET /anomalies',
  resolveAnomaly: 'POST /anomalies/{id}/resolve',
  listLocations: 'GET /locations',
  getSettings: 'GET /settings',
  patchSettings: 'PATCH /settings',
  createImport: 'POST /imports',
  getImport: 'GET /imports/{id}',
  confirmImport: 'POST /imports/{id}/confirm',
  pause: 'POST /automation/pause',
  resume: 'POST /automation/resume',
} as const;

export type RouteName = keyof typeof ROUTES;

// ---------------------------------------------------------------------------
// Additions for the embedded admin app (all additive; existing types are unchanged)
// ---------------------------------------------------------------------------

/** Banner states shown at the top of every screen (15.4 "Bandeau d'état", 15.7). */
export type StatusBanner = 'frozen' | 'reconnect_required' | 'restoring' | 'read_only';

/** Admin UI extensions that report their first render to the server (15.4 "Démarrage", T-UX-08). */
export type ExtensionKey = 'variant_block' | 'product_block' | 'order_block' | 'order_action' | 'variant_action';
export const EXTENSION_KEYS: readonly ExtensionKey[] = ['variant_block', 'product_block', 'order_block', 'order_action', 'variant_action'];

/**
 * Header each admin extension sends on every call with its Shopify target (`shopify.extension.target`):
 * the server records the first render of the extension from it (15.4 "l'extension le signale au serveur
 * à son premier rendu"), whatever call the extension makes first.
 */
export const EXTENSION_HEADER = 'X-Serialis-Extension';
/** Shopify targets of the extensions (`shopify.extension.toml`) and the key each one reports. */
export const EXTENSION_TARGETS: Readonly<Record<string, ExtensionKey>> = {
  'admin.product-variant-details.block.render': 'variant_block',
  'admin.product-details.block.render': 'product_block',
  'admin.order-details.block.render': 'order_block',
  'admin.order-details.action.render': 'order_action',
  'admin.product-variant-details.action.render': 'variant_action',
};

/**
 * Optional fields of `MeResponse` added for the admin app, returned by `GET /me` next to the
 * existing ones (the Worker fills them; the app treats a missing value as the default).
 */
export interface MeResponseAdminExtras {
  /** 15.8: "admin" for the owner and designated admins, "operator" otherwise. Default "admin" when absent. */
  role?: 'admin' | 'operator';
  /** 15.8: true for the shop's owner, the only user who designates administrators (`PATCH /app-users` role). */
  owner?: boolean;
  /** Shopify user id of the caller (`sub` of the session token), to mark its own line in Settings › Users. */
  userId?: string | null;
  /** Persistent banners other than the emergency stop (that one is `emergencyStop`). */
  banners?: StatusBanner[];
  /** True once each extension has been rendered at least once in the Shopify admin. */
  extensionsShown?: Record<ExtensionKey, boolean>;
}

/** GET /api/v1/stats/home — home screen (EF-31, reduced for the MVP, 19.4). */
export interface HomeStatsResponse {
  sync: {
    /** Green / orange / red summary of the indicators below. */
    level: 'green' | 'orange' | 'red';
    lastWebhookAt: IsoDateTime | null;
    lastReconciliationAt: IsoDateTime | null;
    /** Current processing delay in seconds (0 when none). */
    delaySeconds: number;
    /** Writes to Shopify waiting in the outbox. */
    pendingWrites: number;
  };
  /** "À traiter maintenant": each count opens the filtered list. */
  toDo: {
    linesWithoutUnit: number;
    criticalAnomalies: number;
    returnsToIdentify: number;
    shippedUnitsToDesignate: number;
  };
  unitsByState: Array<{ locationId: string; state: UnitState; count: number }>;
  /** Share of tracked lines allocated in under 60 s, read from `daily_stats` (0..1). */
  assignedUnder60s: {
    rate: number | null;
    sample: number;
    history30d: Array<{ date: string; rate: number | null }>;
  };
}

/** POST /api/v1/units/batch/check — same body as `POST /units/batch`, writes nothing (15.3, 15.5). */
export type RefCheckStatus = 'ready' | 'duplicate_in_list' | 'already_known' | 'invalid_format' | 'beyond_gap';
export interface CheckUnitsBatchResponse {
  rows: Array<{ index: number; ref: string; status: RefCheckStatus; detail?: string }>;
  ready: number;
  /** Stock written in Shopify if the batch is confirmed (0 when `alreadyCounted`). */
  stockWrite: number;
  /** Remaining gap (Shopify on_hand − registered units) at this location before the batch, or null if unknown. */
  gapBefore: number | null;
}

/** GET /units/{id}/events → Page<UnitEvent> */
export interface UnitEvent {
  id: string;
  at: IsoDateTime;
  /** Who: a person (first name), "api", "pos" or "system". */
  actor: string;
  type: string;
  fromState: UnitState | null;
  toState: UnitState | null;
  /** Cause or reason, short text without customer data. */
  reason: string | null;
  /** Effect on the Shopify stock, e.g. "+1 at location X" or "no write". */
  stockEffect: string | null;
  /** Structured form of `stockEffect` (additive): signed quantity written in Shopify, `null` when none. */
  stockDelta?: number | null;
  /** Shopify quantity name written by `stockDelta` (one of `STOCK_QUANTITY_NAMES`). */
  stockQuantity?: string | null;
}

/** POST /anomalies/{id}/acknowledge ("je m'en occupe", 15.4) → Anomaly */

/** POST /settings/simulate — effect of a "simulation" setting change; id valid 10 min (14.2, 6.6.1). */
export interface SimulateSettingsRequest {
  scope: SettingScope;
  /** Same values as the PATCH to come; `null` = back to the default. */
  values: Record<string, string | number | boolean | null>;
}
export interface SettingsSimulation {
  simulationId: string;
  expiresAt: IsoDateTime;
  /** `summary` is a stable key of `SETTINGS_SIMULATION_SUMMARIES` (the interfaces translate it, 15.9). */
  effects: Array<{ key: string; count: number; summary: SettingsSimulationSummary }>;
  /** Values that weaken a guarantee, with their exact effect (6.6.1). */
  warnings: string[];
}

/** Body of POST /imports: the CSV text with header `ref,sku,variant_id,location,already_counted`. */
export interface CreateImportRequest {
  filename?: string;
  csv: string;
}
/** Optional fields added to the simulation report (15.4 "Imports et exports"). */
export interface ImportReportExtras {
  /** Lines beyond the Shopify gap (already counted but no gap left). */
  beyondGap?: number;
  /** Stock written in Shopify when confirmed. */
  stockWrites?: number;
}

/** POST /automation/pause | /automation/resume */
export interface AutomationStateResponse {
  emergencyStop: boolean;
}

/** Routes added for the admin app (kept apart from `ROUTES` to avoid merge conflicts; spec 14.2). */
export const ADMIN_APP_ROUTES = {
  homeStats: 'GET /stats/home',
  checkUnitsBatch: 'POST /units/batch/check',
  acknowledgeAnomaly: 'POST /anomalies/{id}/acknowledge',
  simulateSettings: 'POST /settings/simulate',
} as const;

export const ALL_ROUTES = { ...ROUTES, ...ADMIN_APP_ROUTES } as const;
export type AnyRouteName = keyof typeof ALL_ROUTES;

// Additions for the admin UI extensions (additive only; existing types untouched)
// ---------------------------------------------------------------------------

/**
 * Optional filters of `GET /tracked-items` used by the variant and product blocks:
 * `variant` returns the (at most one) active item of that variant, `product` all the items
 * of a product. Without filter the route lists every tracked item as before.
 */
export interface ListTrackedItemsQuery {
  variant?: Gid;
  product?: Gid;
  cursor?: string;
  limit?: number;
}

/**
 * `POST /tracked-items` with `action: 'untrack'` deactivates the tracking of the variants (EF-01):
 * units in stock become UNTRACKED without any stock write. Refused with `invalid_transition`
 * while units are allocated, in transit or awaiting a return. Admin level (15.8).
 * Without `action` (or with `'track'`) the request is a `TrackItemsRequest`.
 */
export interface UntrackItemsRequest {
  action: 'untrack';
  variantGids: Gid[];
}

/** Response of `POST /tracked-items` (both actions): the resulting items (untracked ones are omitted on `untrack`). */
export type TrackItemsResponse = Page<TrackedItem>;

/** `GET /locations` → `Page<Location>` (active and inactive locations; `nextCursor` is null when the list is complete). */
export type ListLocationsResponse = Page<Location>;

// ---------------------------------------------------------------------------
// Public API and API keys (spec 14.1, 11.2 `api_keys`, 15.4 "Réglages › API") — additive only
// ---------------------------------------------------------------------------

/**
 * Public surface: `https://api.serialis.dev/v1/...` in production; `https://<app host>/public/v1/...`
 * on the staging and pilot hosts (the production app host does not serve it). Same resources and
 * rules as the internal surface, authenticated by an API key in `Authorization: Bearer`.
 */
export const PUBLIC_BASE = '/v1' as const;
export const PUBLIC_PATH_BASE = '/public/v1' as const;

/** Scopes of an API key (14.1). `webhooks:manage` comes with the outgoing webhooks (lot 4). */
export type ApiScope = 'units:read' | 'units:write' | 'allocations:read' | 'allocations:write' | 'anomalies:read' | 'anomalies:write' | 'admin';
export const API_SCOPES: readonly ApiScope[] = ['units:read', 'units:write', 'allocations:read', 'allocations:write', 'anomalies:read', 'anomalies:write', 'admin'];

/** An API key as listed in the admin app; the secret is never returned after creation. */
export interface ApiKey {
  /** Identifier of the key (public part), used to revoke it. */
  prefix: string;
  name: string;
  scopes: ApiScope[];
  /** Start of the key as shown in the list, e.g. `srl_1_eu_shop.myshopify.com_ab12…`. */
  hint: string;
  createdAt: IsoDateTime;
  createdBy: string | null;
  lastUsedAt: IsoDateTime | null;
  revokedAt: IsoDateTime | null;
}

/** POST /api-keys (internal surface, administrators only; O5: never through the public API). */
export interface CreateApiKeyRequest {
  name: string;
  scopes: ApiScope[];
}
/** The full key is returned ONCE, in this response; only a hash of its secret is stored. */
export interface CreateApiKeyResponse {
  apiKey: ApiKey;
  key: string;
}

/** Key management routes, internal surface only: GET → Page<ApiKey>, POST → CreateApiKeyResponse, DELETE → 204. */
export const API_KEY_ROUTES = {
  listApiKeys: 'GET /api-keys',
  createApiKey: 'POST /api-keys',
  revokeApiKey: 'DELETE /api-keys/{prefix}',
} as const;

/** Every route of the internal surface `/api/v1` (admin app client): shared routes, key management, operations (users, health). */
export const INTERNAL_ROUTES = { ...ALL_ROUTES, ...API_KEY_ROUTES, ...OPERATIONS_ROUTES } as const;
export type InternalRouteName = keyof typeof INTERNAL_ROUTES;

/** POST /units (public API, 14.2, 19.4 capability 1): one unit; same rules as `POST /units/batch` in atomic mode. Response: `Unit` (201, ETag). */
export interface CreateUnitRequest {
  variantGid: Gid;
  locationId: string;
  ref: string;
  alreadyCounted: boolean;
}

/**
 * Routes of the public API and the scope each one requires (14.1 table, MVP subset). A resolution of
 * anomaly that writes the Shopify stock (`writesStock`) requires `admin` instead of `anomalies:write`.
 * `GET /me` and `GET /stats/home` (session and home screen) are not part of the public API.
 */
export const PUBLIC_ROUTES = {
  listTrackedItems: { route: 'GET /tracked-items', scope: 'units:read' },
  trackItems: { route: 'POST /tracked-items', scope: 'admin' },
  listUnits: { route: 'GET /units', scope: 'units:read' },
  createUnit: { route: 'POST /units', scope: 'units:write' },
  getUnit: { route: 'GET /units/{id}', scope: 'units:read' },
  createUnitsBatch: { route: 'POST /units/batch', scope: 'units:write' },
  checkUnitsBatch: { route: 'POST /units/batch/check', scope: 'units:write' },
  lookup: { route: 'GET /lookup', scope: 'units:read' },
  unitEvents: { route: 'GET /units/{id}/events', scope: 'units:read' },
  orderAllocations: { route: 'GET /orders/{orderId}/allocations', scope: 'allocations:read' },
  createAllocation: { route: 'POST /allocations', scope: 'allocations:write' },
  deleteAllocation: { route: 'DELETE /allocations/{id}', scope: 'allocations:write' },
  replaceAllocation: { route: 'POST /allocations/{id}/replace', scope: 'allocations:write' },
  confirmShipped: { route: 'POST /allocations/{id}/confirm-shipped', scope: 'allocations:write' },
  identifyReturn: { route: 'POST /returns/{returnId}/identify', scope: 'units:write' },
  listAnomalies: { route: 'GET /anomalies', scope: 'anomalies:read' },
  acknowledgeAnomaly: { route: 'POST /anomalies/{id}/acknowledge', scope: 'anomalies:write' },
  resolveAnomaly: { route: 'POST /anomalies/{id}/resolve', scope: 'anomalies:write' },
  listLocations: { route: 'GET /locations', scope: 'units:read' },
  getSettings: { route: 'GET /settings', scope: 'admin' },
  simulateSettings: { route: 'POST /settings/simulate', scope: 'admin' },
  patchSettings: { route: 'PATCH /settings', scope: 'admin' },
  createImport: { route: 'POST /imports', scope: 'units:write' },
  getImport: { route: 'GET /imports/{id}', scope: 'units:read' },
  confirmImport: { route: 'POST /imports/{id}/confirm', scope: 'units:write' },
  pause: { route: 'POST /automation/pause', scope: 'admin' },
  resume: { route: 'POST /automation/resume', scope: 'admin' },
} as const satisfies Record<string, { route: string; scope: ApiScope }>;
export type PublicRouteName = keyof typeof PUBLIC_ROUTES;

// ---------------------------------------------------------------------------
// Stable keys shown translated by the interfaces (15.9: no technical key on screen)
// ---------------------------------------------------------------------------

/** Every `summary` the Worker returns in `SettingsSimulation.effects` (6.6.1 "Ce qui va changer"). */
export const SETTINGS_SIMULATION_SUMMARIES = [
  'no_object_affected',
  'duplicates_block_shop_scope',
  'identifiers_rescoped',
  'applies_to_next_synchronizations',
  'metafields_removed_at_next_sync',
  'metafields_written_at_next_sync',
  'applies_to_next_events',
] as const;
export type SettingsSimulationSummary = (typeof SETTINGS_SIMULATION_SUMMARIES)[number];

/** Every `type` of `UnitEvent` the Worker writes (unit history). */
export const UNIT_EVENT_TYPES = [
  'created', 'allocated', 'released', 'to_verify', 'shipped', 'shipment_cancelled', 'return_pending', 'return_cancelled', 'returned',
  'shipment_confirmed', 'shipment_designation_fixed', 'verified_restocked', 'lost', 'scrapped', 'untracked',
] as const;
export type UnitEventType = (typeof UNIT_EVENT_TYPES)[number];

/**
 * Every `reason` of `UnitEvent`: event causes, release kinds (`restocked`…) and return dispositions
 * reported by Shopify (`RESTOCKED`…, in capitals as Shopify spells them).
 */
export const UNIT_EVENT_REASONS = [
  'received', 'already_counted', 'late_designation', 'replaced', 'replacement', 'shipment_designation_fix',
  'unit_to_verify:restock', 'unit_to_verify:lose', 'unit_to_verify:scrap',
  'restocked', 'not_restocked', 'relocated', 'ignored_order', 'manual',
  'RESTOCKED', 'PROCESSING_REQUIRED', 'NOT_RESTOCKED', 'MISSING',
] as const;
export type UnitEventReason = (typeof UNIT_EVENT_REASONS)[number];

/** `UnitEvent.stockEffect` when the event wrote nothing in Shopify. */
export const UNIT_EVENT_NO_WRITE = 'no write';

/** Shopify inventory quantity names an event can write (`UnitEvent.stockQuantity`). */
export const STOCK_QUANTITY_NAMES = ['available', 'reserved', 'committed', 'quality_control', 'damaged'] as const;
export type StockQuantityName = (typeof STOCK_QUANTITY_NAMES)[number];

/** Every stable error `code` of the problem+json answers (14.1), in the order of `ErrorCode`. */
export const ERROR_CODES = [
  'unauthenticated', 'forbidden', 'not_found', 'validation_failed', 'idempotency_conflict', 'precondition_failed', 'rate_limited',
  'unit_not_available', 'identifier_conflict', 'invalid_transition', 'variant_mismatch', 'location_mismatch', 'ambiguous_ref', 'unknown_ref',
  'not_tracked', 'emergency_stop', 'simulation_expired', 'incompatible_settings',
] as const satisfies readonly ErrorCode[];
const _everyErrorCodeListed: [Exclude<ErrorCode, (typeof ERROR_CODES)[number]>] extends [never] ? true : false = true;
void _everyErrorCodeListed;

/**
 * Stable keys the Worker puts in a problem `detail`, a batch `rejected[].detail`, a check row `detail`
 * or an import error `detail` when the code alone is too generic. The interfaces show a specific
 * message for each one (15.7: what happened and what to do) instead of the generic text of the code;
 * any other detail is never shown as a raw key.
 */
export const PROBLEM_DETAIL_KEYS = [
  // Refs (check rows, batch rejections, import rows)
  'no_usable_deficit', 'too_long_or_control_char', 'empty', 'luhn', 'regex', 'invalid_regex', 'empty_ref', 'unknown_or_untracked_variant',
  'unknown_location', 'invalid_already_counted', 'duplicate_in_file', 'duplicate_in_list', 'already_known', 'beyond_gap', 'invalid_format',
  // Rights and shop state
  'admin_required', 'owner_required', 'owner_is_admin', 'last_admin', 'shop_frozen', 'reconnect_required', 'shop_not_installed', 'shop_mismatch',
  'user_never_opened_the_app', 'api_keys_interface_only', 'api_key_revoked',
  // Operations and settings
  'task_not_dead', 'write_not_dead', 'fixed_in_mvp', 'scope_not_allowed', 'invalid_value',
] as const;
export type ProblemDetailKey = (typeof PROBLEM_DETAIL_KEYS)[number];
