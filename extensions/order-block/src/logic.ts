import type { Allocation, OrderAllocationsResponse } from '@serialis/contract';

type Line = OrderAllocationsResponse['lines'][number];

/** One displayed row under a tracked line: an allocated unit, or a unit still missing (F15: one row per unit). */
export type UnitRow =
  | { kind: 'allocation'; allocation: Allocation }
  | { kind: 'missing'; position: number };

export interface LineView {
  line: Line;
  rows: UnitRow[];
  /** Units still to allocate for this line (never negative). */
  missing: number;
  /** Units currently on the line (allocated or shipped, a shipped unit awaiting its return included). */
  current: number;
  /** Shipped units whose return is awaited (unit RETURN_PENDING). */
  returnPending: number;
  /** Units already returned (allocation `returned`). */
  returned: number;
}

const isCurrent = (a: Allocation) => a.status === 'active' || a.status === 'fulfilled';

/**
 * Lines that carry tracking: one row per unit currently on the line, then the returned units, then one row per
 * missing unit. Released allocations are history (« Modifier les unités » lists them): not shown, not counted
 * (recette 2: « +10 more units » on a line of 7 units).
 */
export function buildLineViews(res: OrderAllocationsResponse): LineView[] {
  return res.lines
    .filter((l) => l.tracked)
    .map((line) => {
      const shown = line.allocations.filter((a) => a.status !== 'released');
      const rank = (a: Allocation) => (isCurrent(a) ? 0 : 1);
      const allocations = [...shown].sort((a, b) => rank(a) - rank(b) || a.allocatedAt.localeCompare(b.allocatedAt));
      const missing = Math.max(0, line.missing);
      const rows: UnitRow[] = allocations.map((allocation) => ({ kind: 'allocation', allocation }));
      for (let i = 0; i < missing; i++) rows.push({ kind: 'missing', position: i + 1 });
      return {
        line,
        rows,
        missing,
        current: allocations.filter(isCurrent).length,
        returnPending: allocations.filter((a) => a.status === 'fulfilled' && a.unitState === 'RETURN_PENDING').length,
        returned: allocations.filter((a) => a.status === 'returned').length,
      };
    });
}

/**
 * Quantity shown next to the line title (recette 3): the current quantity, with the quantity ordered when an order
 * edit or a refund lowered it (« × 2 (3 ordered) »). A line emptied by its return keeps the quantity ordered, its
 * returned units being counted next to it (recette 2: never « × 0 »).
 */
export function quantityLabel(view: Pick<LineView, 'line' | 'returned' | 'returnPending'>): { current: number; ordered: number | null } {
  const { line } = view;
  const ordered = line.orderedQuantity ?? line.quantity;
  if (line.quantity >= ordered) return { current: line.quantity, ordered: null };
  if (line.quantity === 0 && view.returned + view.returnPending > 0) return { current: ordered, ordered: null };
  return { current: line.quantity, ordered };
}

/** Tracked lines shown in the block, and unit rows shown in all (essential content within 300 px, DECISIONS.md). */
export const MAX_LINES_SHOWN = 2;
export const MAX_UNIT_ROWS = 4;

export interface CompactView {
  shown: Array<{ view: LineView; rows: UnitRow[] }>;
  /** Tracked lines left out (their units are in `hiddenUnits`). */
  hiddenLines: number;
  /** Units on a line (allocated, shipped or missing) left out, over the shown and the hidden lines; returned units are not counted. */
  hiddenUnits: number;
}

const counts = (r: UnitRow) => r.kind === 'missing' || isCurrent(r.allocation);

/**
 * Caps an order to what fits a collapsed block: lines with units to allocate first, 2 lines at most, 4 unit rows
 * in all (4 for a single line, 2 each for two). The rest is counted; "Modifier les unités" shows every unit.
 */
export function compactLines(views: LineView[], maxLines = MAX_LINES_SHOWN, maxRows = MAX_UNIT_ROWS): CompactView {
  const ordered = [...views.filter((v) => v.missing > 0), ...views.filter((v) => v.missing === 0)];
  const kept = ordered.slice(0, maxLines);
  const perLine = Math.max(1, Math.floor(maxRows / Math.max(1, kept.length)));
  const shown = kept.map((view) => ({ view, rows: view.rows.slice(0, perLine) }));
  const hiddenUnits =
    kept.reduce((n, v) => n + v.rows.slice(perLine).filter(counts).length, 0) +
    ordered.slice(maxLines).reduce((n, v) => n + v.rows.filter(counts).length, 0);
  return { shown, hiddenLines: ordered.length - kept.length, hiddenUnits };
}

export function untrackedLineCount(res: OrderAllocationsResponse): number {
  return res.lines.filter((l) => !l.tracked).length;
}

/** Locale key of the origin of an allocation (15.6: commande, manuelle, API, caisse...). */
export function originKey(source: Allocation['source']): string {
  return `orderBlock.origin_${source}`;
}

export type BadgeTone = 'info' | 'success' | 'neutral' | 'warning';

export function statusView(status: Allocation['status']): { key: string; tone: BadgeTone } {
  switch (status) {
    case 'active': return { key: 'orderBlock.status_active', tone: 'info' };
    case 'fulfilled': return { key: 'orderBlock.status_fulfilled', tone: 'success' };
    case 'released': return { key: 'orderBlock.status_released', tone: 'neutral' };
    case 'returned': return { key: 'orderBlock.status_returned', tone: 'warning' };
  }
}

/**
 * Badge of a unit row: the unit's real state once it left (recette 2: « Shipped » while the unit was « Return
 * pending »): a shipped unit awaiting its return, a returned unit back in stock, scrapped or lost.
 */
export function rowStatusView(a: Allocation): { key: string; tone: BadgeTone } {
  const state = a.unitState;
  if (a.status === 'fulfilled' && state && state !== 'SHIPPED') return { key: `states.${state}`, tone: 'warning' };
  if (a.status === 'returned' && state) return { key: `states.${state}`, tone: state === 'AVAILABLE' ? 'success' : 'neutral' };
  return statusView(a.status);
}

/** Polling policy while the order is being synchronized ("attribution en cours"). */
export const POLL_INTERVAL_MS = 3000;
export const MAX_POLLS = 20;

export function shouldPoll(syncState: OrderAllocationsResponse['syncState'], polls: number): boolean {
  return syncState === 'pending' && polls < MAX_POLLS;
}

/** The "Modifier les unités" button is useful when a line is tracked. */
export function canEdit(res: OrderAllocationsResponse): boolean {
  return res.lines.some((l) => l.tracked);
}
