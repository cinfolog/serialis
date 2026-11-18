import type { Location, TrackedItem, Unit, UnitState } from '@serialis/contract';

// Loading, totals, the app link and the add rules are shared with the variant action (extensions/shared/src/variant.ts).
export { loadVariantData, totals, unitsAppHref, type VariantData } from '@serialis/extensions-shared';

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

export function filterUnits(units: Unit[], query: string): Unit[] {
  const q = query.trim().toUpperCase();
  if (!q) return units;
  return units.filter((u) => u.ref.toUpperCase().includes(q));
}
