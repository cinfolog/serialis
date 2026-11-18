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
  values: Record<string, string | number | boolean>;
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
