import { describe, expect, it } from 'vitest';
import type { OrderAllocationsResponse } from '@serialis/contract';
import { LINE, ORDER, VARIANT, makeAllocation } from '@serialis/extensions-shared/testing';
import { MAX_POLLS, buildLineViews, canEdit, compactLines, quantityLabel, type LineView, originKey, rowStatusView, shouldPoll, statusView, untrackedLineCount } from '../src/logic';

const response = (over: Partial<OrderAllocationsResponse> = {}): OrderAllocationsResponse => ({
  orderGid: ORDER,
  lines: [
    {
      lineItemGid: LINE, variantGid: VARIANT, title: 'Vélo test', tracked: true, quantity: 3, missing: 1,
      allocations: [
        makeAllocation('R2', { allocatedAt: '2026-03-02T10:00:00Z' }),
        makeAllocation('OLD', { status: 'released', allocatedAt: '2026-03-01T10:00:00Z' }),
        makeAllocation('R1', { allocatedAt: '2026-03-02T09:00:00Z' }),
      ],
    },
    { lineItemGid: 'gid://shopify/LineItem/2', variantGid: 'v2', title: 'Casque', tracked: false, quantity: 1, missing: 0, allocations: [] },
  ],
  syncState: 'synced', syncedAt: '2026-03-02T10:00:05Z', ...over,
});

describe('buildLineViews', () => {
  it('keeps tracked lines only, one row per unit: current units by date, then missing units; released history is left out', () => {
    const views = buildLineViews(response());
    expect(views).toHaveLength(1);
    expect(views[0]!.rows.map((r) => (r.kind === 'allocation' ? r.allocation.ref : `missing#${r.position}`))).toEqual(['R1', 'R2', 'missing#1']);
    expect(views[0]!).toMatchObject({ missing: 1, current: 2, returnPending: 0, returned: 0 });
  });

  it('recette 2 — returned line: real unit state, quantity ordered, returned units after the current ones', () => {
    const r = response();
    r.lines[0] = {
      ...r.lines[0]!, quantity: 0, orderedQuantity: 2, missing: 0,
      allocations: [
        makeAllocation('BACK', { status: 'returned', unitState: 'SCRAPPED', allocatedAt: '2026-03-01T09:00:00Z' }),
        makeAllocation('PEND', { status: 'fulfilled', unitState: 'RETURN_PENDING' }),
      ],
    };
    const v = buildLineViews(r)[0]!;
    expect(v.rows.map((x) => (x.kind === 'allocation' ? x.allocation.ref : '-'))).toEqual(['PEND', 'BACK']);
    expect(v).toMatchObject({ current: 1, returnPending: 1, returned: 1 });
    expect(quantityLabel(v)).toEqual({ current: 2, ordered: null });
    expect(rowStatusView(r.lines[0]!.allocations[1]!)).toEqual({ key: 'states.RETURN_PENDING', tone: 'warning' });
    expect(rowStatusView(r.lines[0]!.allocations[0]!)).toEqual({ key: 'states.SCRAPPED', tone: 'neutral' });
    expect(rowStatusView(makeAllocation('S', { status: 'fulfilled', unitState: 'SHIPPED' }))).toEqual(statusView('fulfilled'));
    expect(quantityLabel({ ...v, line: { ...v.line, orderedQuantity: undefined } } as never)).toEqual({ current: 0, ordered: null });
  });

  it('recette 3 — order edited 3 → 2: current quantity, then the quantity ordered', () => {
    const r = response();
    r.lines[0] = { ...r.lines[0]!, quantity: 2, orderedQuantity: 3, missing: 0, allocations: [makeAllocation('A'), makeAllocation('B')] };
    expect(quantityLabel(buildLineViews(r)[0]!)).toEqual({ current: 2, ordered: 3 });
    r.lines[0] = { ...r.lines[0]!, quantity: 3, orderedQuantity: 3 };
    expect(quantityLabel(buildLineViews(r)[0]!)).toEqual({ current: 3, ordered: null });
  });

  it('recette 2 — « +N more units » counts the units on the line only (7 units and 7 released: +3)', () => {
    const r = response();
    r.lines[0] = {
      ...r.lines[0]!, quantity: 7, missing: 0,
      allocations: [
        ...Array.from({ length: 7 }, (_, i) => makeAllocation(`U${i}`, { id: `u${i}`, status: i < 3 ? 'fulfilled' : 'active' })),
        ...Array.from({ length: 7 }, (_, i) => makeAllocation(`OLD${i}`, { id: `o${i}`, status: 'released' })),
        makeAllocation('RET', { id: 'ret', status: 'returned', unitState: 'AVAILABLE' }),
      ],
    };
    expect(compactLines(buildLineViews(r)).hiddenUnits).toBe(3);
  });

  it('never shows a negative number of missing units', () => {
    const r = response();
    r.lines[0]!.missing = -2;
    expect(buildLineViews(r)[0]!.missing).toBe(0);
  });

  it('counts untracked lines and tells whether the order is editable', () => {
    expect(untrackedLineCount(response())).toBe(1);
    expect(canEdit(response())).toBe(true);
    expect(canEdit(response({ lines: [] }))).toBe(false);
  });
});

describe('labels and polling', () => {
  it('maps origin and status to locale keys', () => {
    expect(originKey('pos')).toBe('orderBlock.origin_pos');
    expect(statusView('active')).toEqual({ key: 'orderBlock.status_active', tone: 'info' });
    expect(statusView('fulfilled').tone).toBe('success');
  });

  it('polls only while pending, up to the cap', () => {
    expect(shouldPoll('pending', 0)).toBe(true);
    expect(shouldPoll('pending', MAX_POLLS)).toBe(false);
    expect(shouldPoll('synced', 0)).toBe(false);
    expect(shouldPoll('error', 0)).toBe(false);
  });
});

describe('compactLines', () => {
  const view = (id: string, rows: number, missing = 0): LineView => ({
    line: { lineItemGid: id, variantGid: VARIANT, title: id, tracked: true, quantity: rows, missing, allocations: [] },
    rows: Array.from({ length: rows }, (_, i) => ({ kind: 'missing' as const, position: i + 1 })),
    missing,
    current: 0,
    returnPending: 0,
    returned: 0,
  });

  it('a single line shows up to 4 rows', () => {
    const c = compactLines([view('a', 6)]);
    expect(c.shown[0]!.rows).toHaveLength(4);
    expect(c).toMatchObject({ hiddenLines: 0, hiddenUnits: 2 });
  });

  it('two lines or more: lines with units to allocate first, 2 rows each, the rest counted', () => {
    const c = compactLines([view('a', 3), view('b', 1), view('c', 2, 2)]);
    expect(c.shown.map((s) => [s.view.line.lineItemGid, s.rows.length])).toEqual([['c', 2], ['a', 2]]);
    expect(c).toMatchObject({ hiddenLines: 1, hiddenUnits: 2 });
  });

  it('a small order is shown whole', () => {
    expect(compactLines([view('a', 2), view('b', 1)])).toMatchObject({ hiddenLines: 0, hiddenUnits: 0 });
  });
});
