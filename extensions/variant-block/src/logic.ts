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
