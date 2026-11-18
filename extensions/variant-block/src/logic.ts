import type {
  CreateUnitsBatchRequest,
  CreateUnitsBatchResponse,
  ErrorCode,
  Gid,
  Location,
  TrackedItem,
  Unit,
  UnitState,
} from '@serialis/contract';
import {
  MAX_BATCH_REFS,
  classifyRefs,
  countByStatus,
  parseRefList,
  type ApiClient,
  type RefLine,
} from '@serialis/extensions-shared';

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface VariantData {
  locations: Location[];
  /** Null when the variant is not tracked. */
  item: TrackedItem | null;
  units: Unit[];
  /** True when the unit list was cut at the page cap (counts and list are then partial). */
  truncated: boolean;
}

/** Everything the block shows: locations, the tracked item of the variant and its units (spec 15.6). */
export async function loadVariantData(api: ApiClient, variantGid: Gid, signal?: AbortSignal): Promise<VariantData> {
  const call = signal ? { signal } : {};
  const [locations, tracked] = await Promise.all([
    api.listLocations(call),
    api.listTrackedItems({ variant: variantGid, limit: 1 }, call),
  ]);
  const item = tracked.items.find((i) => i.variantGid === variantGid) ?? null;
  if (!item) return { locations: locations.items, item: null, units: [], truncated: false };
  const units = await api.listAllUnits({ variant: variantGid }, signal ? { signal } : {});
  return { locations: locations.items, item, units: units.items, truncated: units.truncated };
}

// ---------------------------------------------------------------------------
// Per-location summary (counts by state, gap with Shopify on_hand, 8.1)
// ---------------------------------------------------------------------------

export const STATE_ORDER: readonly UnitState[] = [
  'AVAILABLE', 'HELD', 'ALLOCATED', 'INCOMING', 'IN_TRANSIT', 'QUALITY_CONTROL', 'DAMAGED',
  'RETURN_PENDING', 'TO_VERIFY', 'SHIPPED', 'LOST', 'SCRAPPED', 'UNTRACKED',
];

export interface LocationSummary {
  /** Null for units without a location (shipped, untracked...). */
  locationId: string | null;
  /** Null when unknown: the view then shows the "no location" label. */
  name: string | null;
  /** Shopify on_hand; null for a location without stock data. */
  shopifyOnHand: number | null;
  registeredUnits: number | null;
  /** shopifyOnHand - registeredUnits: > 0 units still to register, < 0 more refs than stock. */
  gap: number | null;
  counts: Array<{ state: UnitState; count: number }>;
  total: number;
}

export function summarizeLocations(item: TrackedItem, units: Unit[], locations: Location[]): LocationSummary[] {
  const names = new Map(locations.map((l) => [l.id, l.name]));
  const byLocation = new Map<string | null, Map<UnitState, number>>();
  for (const u of units) {
    const m = byLocation.get(u.locationId) ?? new Map<UnitState, number>();
    m.set(u.state, (m.get(u.state) ?? 0) + 1);
    byLocation.set(u.locationId, m);
  }
  const ids: Array<string | null> = item.stock.map((s) => s.locationId);
  for (const id of byLocation.keys()) if (!ids.includes(id)) ids.push(id);

  return ids.map((locationId) => {
    const stock = item.stock.find((s) => s.locationId === locationId) ?? null;
    const m = byLocation.get(locationId) ?? new Map<UnitState, number>();
    const counts = STATE_ORDER.filter((s) => m.has(s)).map((state) => ({ state, count: m.get(state) ?? 0 }));
    return {
      locationId,
      name: locationId === null ? null : (names.get(locationId) ?? locationId),
      shopifyOnHand: stock ? stock.shopifyOnHand : null,
      registeredUnits: stock ? stock.registeredUnits : null,
      gap: stock ? stock.shopifyOnHand - stock.registeredUnits : null,
      counts,
      total: counts.reduce((n, c) => n + c.count, 0),
    };
  });
}

// ---------------------------------------------------------------------------
// Compact view (extensions/DECISIONS.md: essential content within the 300 px of a collapsed admin block)
// ---------------------------------------------------------------------------

/** Up to this many locations, one line each; beyond, a table capped at the same number of rows. */
export const MAX_LOCATION_ROWS = 3;
/** Refs listed inline in the block; the full list is in the app (units filtered on the variant). */
export const MAX_INLINE_REFS = 3;

/**
 * Locations to show in the compact view: those with a gap first (the ones that need attention), then the others,
 * each group in its original order; capped at `max`, with the number left out.
 */
export function pickLocations(summaries: LocationSummary[], max = MAX_LOCATION_ROWS): { shown: LocationSummary[]; hidden: number } {
  const needsAttention = (s: LocationSummary) => s.gap !== null && s.gap !== 0;
  const ordered = [...summaries.filter(needsAttention), ...summaries.filter((s) => !needsAttention(s))];
  return { shown: ordered.slice(0, max), hidden: Math.max(0, ordered.length - max) };
}

/** Most recent units first (received, then created), at most `max`. */
export function recentUnits(units: Unit[], max = MAX_INLINE_REFS): Unit[] {
  const time = (u: Unit) => u.receivedAt ?? u.createdAt;
  return [...units].sort((a, b) => time(b).localeCompare(time(a)) || b.createdAt.localeCompare(a.createdAt)).slice(0, max);
}

/** Unit counts by state over every location, in display order. */
export function countStates(units: Unit[]): Array<{ state: UnitState; count: number }> {
  const m = new Map<UnitState, number>();
  for (const u of units) m.set(u.state, (m.get(u.state) ?? 0) + 1);
  return STATE_ORDER.filter((s) => m.has(s)).map((state) => ({ state, count: m.get(state) ?? 0 }));
}

/** Totals over the stock locations: registered refs and the gap with Shopify (positive = units to register). */
export function totals(item: TrackedItem): { registered: number; gap: number } {
  return item.stock.reduce(
    (acc, s) => ({ registered: acc.registered + s.registeredUnits, gap: acc.gap + (s.shopifyOnHand - s.registeredUnits) }),
    { registered: 0, gap: 0 },
  );
}

/** App path of the unit list filtered on a variant (`app:` protocol of admin extensions). */
export function unitsAppHref(variantGid: Gid): string {
  return `app:units?variant=${encodeURIComponent(variantGid)}`;
}

export function filterUnits(units: Unit[], query: string): Unit[] {
  const q = query.trim().toUpperCase();
  if (!q) return units;
  return units.filter((u) => u.ref.toUpperCase().includes(q));
}

// ---------------------------------------------------------------------------
// Adding refs (15.5 pasted list, 7.2 received vs already counted)
// ---------------------------------------------------------------------------

export type AddKind = 'received' | 'already_counted';

export interface AddPlan {
  kind: AddKind;
  lines: RefLine[];
  counts: ReturnType<typeof countByStatus>;
  /** Refs sent to the server, in list order (batch `rejected[].index` points into this array). */
  readyRefs: string[];
  /**
   * Why validation is refused before any call; null when it can go on.
   * - `nothing`: no ready line; `too_many`: more than 1,000 refs;
   * - `no_gap`: "already counted" while Shopify shows no gap at this location (15.7 example).
   */
  blocked: 'nothing' | 'too_many' | 'no_gap' | null;
  /** "Already counted" adds more refs than the gap: the server decides, the person is warned. */
  exceedsGap: boolean;
  /** Effect on Shopify stock, announced before confirmation (15.7). */
  stockDelta: number;
}

/** Default choice: "already counted" when Shopify shows units still to register or while initializing. */
export function defaultKind(gap: number | null, initializing: boolean): AddKind {
  return (gap !== null && gap > 0) || initializing ? 'already_counted' : 'received';
}

export function buildAddPlan(args: { text: string; knownRefs: Iterable<string>; kind: AddKind; gap: number | null }): AddPlan {
  const lines = classifyRefs(parseRefList(args.text), args.knownRefs);
  const counts = countByStatus(lines);
  const readyRefs = lines.filter((l) => l.status === 'ready').map((l) => l.ref);
  const gap = args.gap ?? 0;
  let blocked: AddPlan['blocked'] = null;
  if (readyRefs.length === 0) blocked = 'nothing';
  else if (readyRefs.length > MAX_BATCH_REFS) blocked = 'too_many';
  else if (args.kind === 'already_counted' && gap <= 0) blocked = 'no_gap';
  return {
    kind: args.kind,
    lines,
    counts,
    readyRefs,
    blocked,
    exceedsGap: args.kind === 'already_counted' && gap > 0 && readyRefs.length > gap,
    stockDelta: args.kind === 'received' ? readyRefs.length : 0,
  };
}

export function toBatchRequest(plan: AddPlan, variantGid: Gid, locationId: string): CreateUnitsBatchRequest {
  return {
    variantGid,
    locationId,
    refs: plan.readyRefs,
    alreadyCounted: plan.kind === 'already_counted',
    mode: 'per_item',
  };
}

export interface BatchOutcome {
  created: number;
  rejected: Array<{ ref: string; code: ErrorCode; detail?: string }>;
  /** Text to put back in the field: the rejected refs, one per line, so they can be corrected. */
  remainingText: string;
}

export function summarizeBatch(plan: AddPlan, res: CreateUnitsBatchResponse): BatchOutcome {
  const rejected = res.rejected.map((r) => ({
    ref: r.ref || plan.readyRefs[r.index] || '',
    code: r.code,
    ...(r.detail ? { detail: r.detail } : {}),
  }));
  return { created: res.created.length, rejected, remainingText: rejected.map((r) => r.ref).join('\n') };
}
