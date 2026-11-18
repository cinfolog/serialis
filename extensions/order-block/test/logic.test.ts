import { describe, expect, it } from 'vitest';
import type { OrderAllocationsResponse } from '@serialis/contract';
import { LINE, ORDER, VARIANT, makeAllocation } from '@serialis/extensions-shared/testing';
import { MAX_POLLS, buildLineViews, canEdit, originKey, shouldPoll, statusView, untrackedLineCount } from '../src/logic';

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
  it('keeps tracked lines only, one row per unit: active first by date, history after, then missing units', () => {
    const views = buildLineViews(response());
    expect(views).toHaveLength(1);
    expect(views[0]!.rows.map((r) => (r.kind === 'allocation' ? r.allocation.ref : `missing#${r.position}`))).toEqual(['R1', 'R2', 'OLD', 'missing#1']);
    expect(views[0]!.missing).toBe(1);
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
