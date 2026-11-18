/**
 * Variant data and the "add refs" rules shared by the variant block (summary) and the variant action (add form):
 * loading, gap with Shopify, location choice, received vs already counted (7.2), pasted list (15.5) and batch result.
 */
import type {
  CreateUnitsBatchRequest,
  CreateUnitsBatchResponse,
  ErrorCode,
  Gid,
  Location,
  TrackedItem,
  Unit,
} from '@serialis/contract';
import type { ApiClient } from './api-client';
import { MAX_BATCH_REFS, classifyRefs, countByStatus, parseRefList, type RefLine } from './refs';

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

/** Locations, the tracked item of the variant and its units (spec 15.6). */
export async function loadVariantData(api: ApiClient, variantGid: Gid, signal?: AbortSignal): Promise<VariantData> {
  const call = signal ? { signal } : {};
  const [locations, tracked] = await Promise.all([
    api.listLocations(call),
    api.listTrackedItems({ variant: variantGid, limit: 1 }, call),
  ]);
  const item = tracked.items.find((i) => i.variantGid === variantGid) ?? null;
  if (!item) return { locations: locations.items, item: null, units: [], truncated: false };
  const units = await api.listAllUnits({ variant: variantGid }, call);
  return { locations: locations.items, item, units: units.items, truncated: units.truncated };
}

/** Totals over the stock locations: registered refs and the gap with Shopify (positive = units to register). */
export function totals(item: TrackedItem): { registered: number; gap: number } {
  return item.stock.reduce(
    (acc, s) => ({ registered: acc.registered + s.registeredUnits, gap: acc.gap + (s.shopifyOnHand - s.registeredUnits) }),
    { registered: 0, gap: 0 },
  );
}

/** Gap with Shopify at one location (on_hand - registered refs); null without stock data there. */
export function gapAt(item: TrackedItem, locationId: string): number | null {
  const s = item.stock.find((x) => x.locationId === locationId);
  return s ? s.shopifyOnHand - s.registeredUnits : null;
}

/**
 * App path of the unit list filtered on a variant (`app:` protocol of admin extensions); `add` opens its add form
 * (`add=1`, Units screen of the app).
 */
export function unitsAppHref(variantGid: Gid, opts: { add?: boolean } = {}): string {
  return `app:units?variant=${encodeURIComponent(variantGid)}${opts.add ? '&add=1' : ''}`;
}

// ---------------------------------------------------------------------------
// Location of the added refs
// ---------------------------------------------------------------------------

/** Locations that can receive refs: active ones, plus any location where Shopify holds stock of the variant. */
export function addLocationOptions(item: TrackedItem, locations: Location[]): Location[] {
  const stock = new Set(item.stock.map((s) => s.locationId));
  const options = locations.filter((l) => l.active || stock.has(l.id));
  // A stock location missing from the location list still gets an entry (named by its id).
  for (const id of stock) if (!options.some((l) => l.id === id)) options.push({ id, name: id, active: true });
  return options;
}

/** Location proposed first: the first one where Shopify shows units to register, else the first option. */
export function initialAddLocation(item: TrackedItem, options: Location[]): string {
  const withGap = item.stock.find((s) => s.shopifyOnHand - s.registeredUnits > 0 && options.some((l) => l.id === s.locationId));
  return withGap?.locationId ?? options[0]?.id ?? '';
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

export function buildAddPlan(args: {
  text: string;
  knownRefs: Iterable<string>;
  /** Refs refused by the server check (type rules S-37), flagged as invalid. */
  invalidRefs?: Iterable<string>;
  kind: AddKind;
  gap: number | null;
}): AddPlan {
  const lines = classifyRefs(parseRefList(args.text), args.knownRefs, {}, args.invalidRefs ?? []);
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

// ---------------------------------------------------------------------------
// Refs already registered (variant action, decision 3)
// ---------------------------------------------------------------------------

/** Units of the variant at one location and elsewhere (other locations, or none). */
export function countByLocation(units: Unit[], locationId: string): { here: number; elsewhere: number } {
  let here = 0;
  for (const u of units) if (u.locationId === locationId) here++;
  return { here, elsewhere: units.length - here };
}

/** Units just added first (newest first), then the listed ones without them. */
export function newFirst(added: Unit[], listed: Unit[]): Unit[] {
  const ids = new Set(added.map((u) => u.id));
  return [...added, ...listed.filter((u) => !ids.has(u.id))];
}
