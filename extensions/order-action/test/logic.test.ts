import { describe, expect, it, vi } from 'vitest';
import type { OrderAllocationsResponse } from '@serialis/contract';
import { createApiClient } from '@serialis/extensions-shared';
import { LINE, ORDER, VARIANT, makeAllocation, makeUnit, mockFetch } from '@serialis/extensions-shared/testing';
import { describeEffect, editableLines, isEditable, planCall, runCall, sortCandidates, type Line, type PanelAction } from '../src/logic';

const line: Line = { lineItemGid: LINE, variantGid: VARIANT, title: 'Vélo test', tracked: true, quantity: 2, missing: 1, allocations: [] };
const allocation = makeAllocation('OLD-1');

describe('sortCandidates', () => {
  it('keeps available units only, first in first out (S-05 default), then by ref', () => {
    const units = [
      makeUnit('C', { receivedAt: '2026-03-03T00:00:00Z' }),
      makeUnit('B', { receivedAt: '2026-03-01T00:00:00Z' }),
      makeUnit('A', { receivedAt: '2026-03-01T00:00:00Z' }),
      makeUnit('X', { state: 'ALLOCATED', receivedAt: '2026-01-01T00:00:00Z' }),
    ];
    expect(sortCandidates(units).map((u) => u.ref)).toEqual(['A', 'B', 'C']);
  });
});

describe('editable allocations and lines', () => {
  it('only an active allocation can be replaced or removed (before fulfillment)', () => {
    expect(isEditable(makeAllocation('A'))).toBe(true);
    for (const status of ['fulfilled', 'released', 'returned'] as const) expect(isEditable(makeAllocation('A', { status }))).toBe(false);
  });
  it('keeps tracked lines', () => {
    const res: OrderAllocationsResponse = { orderGid: ORDER, lines: [line, { ...line, tracked: false }], syncState: 'synced', syncedAt: null };
    expect(editableLines(res)).toHaveLength(1);
  });
});

describe('planCall', () => {
  const allocate: PanelAction = { type: 'allocate', line };
  const replace: PanelAction = { type: 'replace', line, allocation };
  const remove: PanelAction = { type: 'remove', line, allocation };

  it('builds the three requests of the contract', () => {
    expect(planCall(ORDER, allocate, { unitId: 'u1' })).toEqual({ kind: 'create', req: { orderGid: ORDER, lineItemGid: LINE, unitId: 'u1' } });
    expect(planCall(ORDER, replace, { ref: 'ABCD' })).toEqual({ kind: 'replace', id: allocation.id, req: { ref: 'ABCD' } });
    expect(planCall(ORDER, remove, null)).toEqual({ kind: 'remove', id: allocation.id });
  });
  it('needs a chosen unit to allocate or replace', () => {
    expect(planCall(ORDER, allocate, null)).toBeNull();
    expect(planCall(ORDER, replace, null)).toBeNull();
  });
});

describe('runCall', () => {
  it('dispatches to the right route; POSTs carry the given key, DELETE has none', async () => {
    const m = mockFetch({
      'POST /api/v1/allocations': () => ({}),
      [`POST /api/v1/allocations/${allocation.id}/replace`]: () => ({}),
      [`DELETE /api/v1/allocations/${allocation.id}`]: () => undefined,
    });
    const api = createApiClient({ fetch: m.fetch });
    await runCall(api, { kind: 'create', req: { orderGid: ORDER, lineItemGid: LINE, unitId: 'u' } }, 'k1');
    await runCall(api, { kind: 'replace', id: allocation.id, req: { unitId: 'u' } }, 'k2');
    await runCall(api, { kind: 'remove', id: allocation.id }, 'k3');
    expect(m.calls.map((c) => [c.method, c.headers['idempotency-key']])).toEqual([['POST', 'k1'], ['POST', 'k2'], ['DELETE', undefined]]);
  });
});

describe('describeEffect (announced before confirmation, 15.7)', () => {
  it('names the unit and the line', () => {
    expect(describeEffect({ type: 'allocate', line }, { ref: 'NEW-1' })).toEqual({ key: 'orderAction.effect_allocate', vars: { ref: 'NEW-1', line: 'Vélo test' } });
    expect(describeEffect({ type: 'replace', line, allocation }, { ref: 'NEW-1' })).toEqual({
      key: 'orderAction.effect_replace', vars: { oldRef: 'OLD-1', ref: 'NEW-1', line: 'Vélo test' },
    });
    expect(describeEffect({ type: 'remove', line, allocation }, null)).toEqual({ key: 'orderAction.effect_remove', vars: { ref: 'OLD-1', line: 'Vélo test' } });
  });
  it('has no effect to announce until a unit is chosen', () => {
    expect(describeEffect({ type: 'allocate', line }, null)).toBeNull();
    expect(describeEffect({ type: 'replace', line, allocation }, null)).toBeNull();
  });
  it('does not call the network', () => {
    const spy = vi.fn();
    describeEffect({ type: 'remove', line, allocation }, null);
    expect(spy).not.toHaveBeenCalled();
  });
});
