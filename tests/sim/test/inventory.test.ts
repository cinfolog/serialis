import { describe, expect, it } from 'vitest';
import { ADJUST, fixture, gql, level } from './helpers.js';

const adjust = (f: ReturnType<typeof fixture>, key: string, change: Record<string, unknown>, name = 'available', extra: Record<string, unknown> = {}) =>
  gql(f.sim, ADJUST, { key, input: { reason: 'correction', name, referenceDocumentUri: 'gid://serialis/OutboxEntry/1', changes: [{ inventoryItemId: f.itemId, locationId: f.loc, ...change }], ...extra } });

describe('inventoryAdjustQuantities', () => {
  it('applies a delta with compare-and-set and reports available and on_hand', async () => {
    const f = fixture();
    const r = await adjust(f, 'k1', { delta: -2, changeFromQuantity: 10 });
    expect(r.data.inventoryAdjustQuantities.userErrors).toEqual([]);
    expect(r.data.inventoryAdjustQuantities.inventoryAdjustmentGroup.changes).toEqual([
      { name: 'available', delta: -2, quantityAfterChange: 8, ledgerDocumentUri: null },
      { name: 'on_hand', delta: -2, quantityAfterChange: 8, ledgerDocumentUri: null },
    ]);
    expect(level(f.sim, f.itemId, f.loc).available).toBe(8);
    expect(f.sim.shop.events.at(-1)?.topic).toBe('inventory_levels/update');
  });

  it('rejects a stale changeFromQuantity with CHANGE_FROM_QUANTITY_STALE and applies nothing', async () => {
    const f = fixture();
    const r = await adjust(f, 'k1', { delta: -2, changeFromQuantity: 9 });
    expect(r.data.inventoryAdjustQuantities.inventoryAdjustmentGroup).toBeNull();
    expect(r.data.inventoryAdjustQuantities.userErrors).toEqual([
      { field: ['input', 'changes', '0', 'changeFromQuantity'], message: expect.any(String), code: 'CHANGE_FROM_QUANTITY_STALE' },
    ]);
    expect(level(f.sim, f.itemId, f.loc).available).toBe(10);
  });

  it('replaying the same key and payload returns the same result without applying twice', async () => {
    const f = fixture();
    const a = await adjust(f, 'k1', { delta: -2, changeFromQuantity: 10 });
    const b = await adjust(f, 'k1', { delta: -2, changeFromQuantity: 10 });
    expect(b.data).toEqual(a.data);
    expect(level(f.sim, f.itemId, f.loc).available).toBe(8);
    expect(f.sim.requests.at(-1)?.replay).toBe(true);
    expect(f.sim.shop.events.filter((e) => e.topic === 'inventory_levels/update')).toHaveLength(1);
  });

  it('same key with another payload gives IDEMPOTENCY_KEY_PARAMETER_MISMATCH', async () => {
    const f = fixture();
    await adjust(f, 'k1', { delta: -2, changeFromQuantity: 10 });
    const r = await adjust(f, 'k1', { delta: -2, changeFromQuantity: 8 });
    expect(r.errors[0].extensions.code).toBe('IDEMPOTENCY_KEY_PARAMETER_MISMATCH');
  });

  it('a failed attempt replayed with its key gives IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED; a new key works', async () => {
    const f = fixture();
    await adjust(f, 'k1', { delta: -1, changeFromQuantity: 99 });
    const again = await adjust(f, 'k1', { delta: -1, changeFromQuantity: 99 });
    expect(again.errors[0].extensions.code).toBe('IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED');
    const ok = await adjust(f, 'k2', { delta: -1, changeFromQuantity: 10 });
    expect(ok.data.inventoryAdjustQuantities.userErrors).toEqual([]);
  });

  it('keys expire after 24 h of sim time', async () => {
    const f = fixture();
    await adjust(f, 'k1', { delta: -1, changeFromQuantity: 10 });
    f.sim.clock.advance(25 * 3600 * 1000);
    const r = await adjust(f, 'k1', { delta: -1, changeFromQuantity: 9 });
    expect(r.data.inventoryAdjustQuantities.userErrors).toEqual([]);
    expect(level(f.sim, f.itemId, f.loc).available).toBe(8);
  });

  it('records contract violations: null changeFromQuantity, missing @idempotent', async () => {
    const f = fixture();
    await adjust(f, 'k1', { delta: -1, changeFromQuantity: null });
    expect(f.sim.violations[0]).toMatch(/changeFromQuantity null/);
    expect(level(f.sim, f.itemId, f.loc).available).toBe(9);
    const noDirective = await gql(f.sim, `mutation($input: InventoryAdjustQuantitiesInput!) { inventoryAdjustQuantities(input: $input) { userErrors { code } } }`, { input: { name: 'available', reason: 'x', changes: [{ inventoryItemId: f.itemId, locationId: f.loc, delta: 1, changeFromQuantity: 9 }] } });
    expect(noDirective.errors[0].extensions.code).toBe('BAD_REQUEST');
    expect(f.sim.violations).toHaveLength(2);
    const absent = await adjust(f, 'k3', { delta: -1 });
    expect(absent.data).toBeUndefined();
  });

  it('ledger rules: required off available, no internal gid, one document, none on available', async () => {
    const f = fixture();
    const code = (r: any) => r.data.inventoryAdjustQuantities.userErrors.map((e: { code: string }) => e.code);
    expect(code(await adjust(f, 'a', { delta: 1, changeFromQuantity: 0 }, 'quality_control'))).toEqual(['INVALID_LEDGER_DOCUMENT']);
    expect(code(await adjust(f, 'b', { delta: 1, changeFromQuantity: 0, ledgerDocumentUri: 'gid://shopify/Order/1' }, 'quality_control'))).toEqual(['INTERNAL_LEDGER_DOCUMENT']);
    expect(code(await adjust(f, 'c', { delta: 1, changeFromQuantity: 10, ledgerDocumentUri: 'gid://serialis/OutboxEntry/9' }, 'available'))).toEqual(['INVALID_AVAILABLE_DOCUMENT']);
    expect(code(await adjust(f, 'd', { delta: 1, changeFromQuantity: 0, ledgerDocumentUri: 'gid://serialis/OutboxEntry/9' }, 'quality_control'))).toEqual([]);
    const two = await gql(f.sim, ADJUST, { key: 'e', input: { name: 'damaged', reason: 'x', changes: [
      { inventoryItemId: f.itemId, locationId: f.loc, delta: 1, changeFromQuantity: 0, ledgerDocumentUri: 'gid://serialis/OutboxEntry/1' },
      { inventoryItemId: f.itemId, locationId: f.loc, delta: 1, changeFromQuantity: 0, ledgerDocumentUri: 'gid://serialis/OutboxEntry/2' }] } });
    expect(code(two)).toEqual(['MAX_ONE_LEDGER_DOCUMENT']);
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ quality_control: 1, damaged: 0, on_hand: 11 });
  });

  it('committed cannot be adjusted', async () => {
    const f = fixture();
    const r = await adjust(f, 'k', { delta: 1, changeFromQuantity: 0 }, 'committed');
    expect(r.data.inventoryAdjustQuantities.userErrors[0].code).toBe('INVALID_NAME');
  });

  it('a write at a location where the item is not stocked creates an inactive level; inventoryActivate activates it', async () => {
    const f = fixture();
    const r = await gql(f.sim, ADJUST, { key: 'k', input: { name: 'available', reason: 'x', changes: [{ inventoryItemId: f.itemId, locationId: f.loc2, delta: 1, changeFromQuantity: 0 }] } });
    expect(r.data.inventoryAdjustQuantities.userErrors).toEqual([]);
    expect(f.sim.shop.getLevel(f.itemId, f.loc2)?.isActive).toBe(false);
    const act = await gql(f.sim, `mutation($i: ID!, $l: ID!, $k: String!) @idempotent(key: $k) { inventoryActivate(inventoryItemId: $i, locationId: $l) { inventoryLevel { isActive } userErrors { code } } }`, { i: f.itemId, l: f.loc2, k: 'act' });
    expect(act.data.inventoryActivate.inventoryLevel.isActive).toBe(true);
  });
});

describe('inventorySetQuantities and inventoryMoveQuantities', () => {
  it('set computes the delta and honours changeFromQuantity', async () => {
    const f = fixture();
    const q = `mutation($input: InventorySetQuantitiesInput!, $k: String!) @idempotent(key: $k) { inventorySetQuantities(input: $input) { inventoryAdjustmentGroup { changes { name delta quantityAfterChange } } userErrors { field code } } }`;
    const row = (from: number) => ({ name: 'available', reason: 'correction', quantities: [{ inventoryItemId: f.itemId, locationId: f.loc, quantity: 4, changeFromQuantity: from }] });
    const bad = await gql(f.sim, q, { k: 's1', input: row(7) });
    expect(bad.data.inventorySetQuantities.userErrors[0]).toMatchObject({ field: ['input', 'quantities', '0', 'changeFromQuantity'], code: 'CHANGE_FROM_QUANTITY_STALE' });
    const ok = await gql(f.sim, q, { k: 's2', input: row(10) });
    expect(ok.data.inventorySetQuantities.inventoryAdjustmentGroup.changes[0]).toEqual({ name: 'available', delta: -6, quantityAfterChange: 4 });
    expect(level(f.sim, f.itemId, f.loc).available).toBe(4);
  });

  it('move shifts quantity between states without changing on_hand, with ledger documents', async () => {
    const f = fixture();
    const q = `mutation($input: InventoryMoveQuantitiesInput!, $k: String!) @idempotent(key: $k) { inventoryMoveQuantities(input: $input) { inventoryAdjustmentGroup { changes { name delta } } userErrors { field code } } }`;
    const input = (qcFrom: number) => ({ reason: 'quality_control', referenceDocumentUri: 'gid://serialis/OutboxEntry/3', changes: [{ inventoryItemId: f.itemId, quantity: 2, from: { locationId: f.loc, name: 'available', changeFromQuantity: 10 }, to: { locationId: f.loc, name: 'quality_control', changeFromQuantity: qcFrom, ledgerDocumentUri: 'gid://serialis/OutboxEntry/3' } }] });
    const stale = await gql(f.sim, q, { k: 'm1', input: input(1) });
    expect(stale.data.inventoryMoveQuantities.userErrors[0]).toMatchObject({ field: ['input', 'changes', '0', 'to', 'changeFromQuantity'], code: 'CHANGE_FROM_QUANTITY_STALE' });
    const ok = await gql(f.sim, q, { k: 'm2', input: input(0) });
    expect(ok.data.inventoryMoveQuantities.inventoryAdjustmentGroup.changes).toEqual([{ name: 'available', delta: -2 }, { name: 'quality_control', delta: 2 }]);
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ available: 8, quality_control: 2, on_hand: 10 });
    // damaged <- quality_control directly (PV-13 shape)
    const direct = await gql(f.sim, q, { k: 'm3', input: { reason: 'damaged', referenceDocumentUri: 'gid://serialis/OutboxEntry/4', changes: [{ inventoryItemId: f.itemId, quantity: 1, from: { locationId: f.loc, name: 'quality_control', changeFromQuantity: 2, ledgerDocumentUri: 'gid://serialis/OutboxEntry/4' }, to: { locationId: f.loc, name: 'damaged', changeFromQuantity: 0, ledgerDocumentUri: 'gid://serialis/OutboxEntry/4' } }] } });
    expect(direct.data.inventoryMoveQuantities.userErrors).toEqual([]);
    expect(level(f.sim, f.itemId, f.loc)).toMatchObject({ quality_control: 1, damaged: 1 });
  });
});
