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
}

/**
 * Lines that carry tracking, each with one row per allocation then one row per missing unit.
 * Released and returned allocations are history: they are listed after the active ones.
 */
export function buildLineViews(res: OrderAllocationsResponse): LineView[] {
  return res.lines
    .filter((l) => l.tracked)
    .map((line) => {
      const rank = (a: Allocation) => (a.status === 'active' || a.status === 'fulfilled' ? 0 : 1);
      const allocations = [...line.allocations].sort((a, b) => rank(a) - rank(b) || a.allocatedAt.localeCompare(b.allocatedAt));
      const missing = Math.max(0, line.missing);
      const rows: UnitRow[] = allocations.map((allocation) => ({ kind: 'allocation', allocation }));
      for (let i = 0; i < missing; i++) rows.push({ kind: 'missing', position: i + 1 });
      return { line, rows, missing };
    });
}

/** Tracked lines shown in the block, and unit rows shown in all (essential content within 300 px, DECISIONS.md). */
export const MAX_LINES_SHOWN = 2;
export const MAX_UNIT_ROWS = 4;

export interface CompactView {
  shown: Array<{ view: LineView; rows: UnitRow[] }>;
  /** Tracked lines left out (their units are in `hiddenUnits`). */
  hiddenLines: number;
  /** Unit rows left out, over the shown and the hidden lines. */
  hiddenUnits: number;
}

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
    kept.reduce((n, v) => n + Math.max(0, v.rows.length - perLine), 0) +
    ordered.slice(maxLines).reduce((n, v) => n + v.rows.length, 0);
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
