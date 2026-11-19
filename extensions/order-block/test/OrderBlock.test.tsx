import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { OrderAllocationsResponse } from '@serialis/contract';
import { createApiClient } from '@serialis/extensions-shared';
import { BLOCK_HEIGHT_BUDGET, LINE, ORDER, VARIANT, blockHeight, makeAllocation, mockFetch, pageText, problem, see, translatorFromFile } from '@serialis/extensions-shared/testing';
import { OrderBlock } from '../src/OrderBlock';

const t = translatorFromFile(join(import.meta.dirname, '..', 'locales', 'fr.default.json'), 'fr');
const tEn = translatorFromFile(join(import.meta.dirname, '..', 'locales', 'en.json'), 'en');
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function order(over: Partial<OrderAllocationsResponse> = {}): OrderAllocationsResponse {
  return {
    orderGid: ORDER,
    lines: [{
      lineItemGid: LINE, variantGid: VARIANT, title: 'Vélo test', tracked: true, quantity: 3, missing: 1,
      allocations: [
        makeAllocation('SN-001', { source: 'auto' }),
        makeAllocation('SN-002', { source: 'pick', status: 'fulfilled' }),
      ],
    }],
    syncState: 'synced', syncedAt: '2026-03-02T10:00:05Z', ...over,
  };
}

function setup(responses: OrderAllocationsResponse[], translate = t, onEdit = vi.fn(), pollMs = 5, onSummary?: (s: string) => void, refreshMs?: number) {
  let i = 0;
  const m = mockFetch({ 'GET /api/v1/orders/9001/allocations': () => responses[Math.min(i++, responses.length - 1)] });
  render(
    <OrderBlock
      api={createApiClient({ fetch: m.fetch })} t={translate} orderGid={ORDER} onEdit={onEdit} pollMs={pollMs}
      formatDateTime={(iso) => `le ${iso.slice(0, 10)}`} {...(onSummary ? { onSummary } : {})} {...(refreshMs ? { refreshMs } : {})}
    />,
  );
  return { m, onEdit };
}

describe('OrderBlock', () => {
  it('shows one row per unit under each tracked line with ref, state and origin, plus missing units', async () => {
    const { m } = setup([order()]);
    await see('Vélo test');
    expect(pageText()).toContain("SN-001 Attribuée Commande (automatique) SN-002 Expédiée Manuelle À attribuer En attente d'une unité");
    expect(document.querySelector('s-table')).toBeNull();
    expect(blockHeight()).toBeLessThanOrEqual(BLOCK_HEIGHT_BUDGET);
    expect(pageText()).toContain('1 unité à attribuer');
    expect(pageText()).toContain('× 3');
    expect(pageText()).toContain('Synchronisée le le 2026-03-02');
    expect(m.calls[0]!.pathname).toBe('/api/v1/orders/9001/allocations');
  });

  it('is available in English', async () => {
    setup([order()], tEn);
    await see('1 unit to allocate');
    expect(pageText()).toContain('Allocated');
    expect(pageText()).toContain('Edit units');
  });

  it('flags units to confirm and the origin of POS sales', async () => {
    const r = order();
    r.lines[0]!.missing = 0;
    r.lines[0]!.allocations = [makeAllocation('POS-1', { source: 'pos', toConfirm: true })];
    setup([r]);
    await see('À confirmer');
    expect(pageText()).toContain('Caisse');
  });

  it('shows "attribution en cours" while pending, then refreshes by itself until synced', async () => {
    const { m } = setup([order({ syncState: 'pending', syncedAt: null, lines: [{ ...order().lines[0]!, allocations: [], missing: 3 }] }), order()]);
    await see('Attribution en cours');
    expect(pageText()).toContain('3 unités à attribuer');
    await see('SN-001');
    expect(pageText()).not.toContain('Attribution en cours');
    expect(m.callsTo('GET /api/v1/orders/9001/allocations')).toHaveLength(2);
  });

  it('stops polling after the cap and says the allocation takes longer than expected', async () => {
    const pending = order({ syncState: 'pending', syncedAt: null });
    const { m } = setup([pending], t, vi.fn(), 1);
    await see('prend plus de temps que prévu');
    const count = () => m.callsTo('GET /api/v1/orders/9001/allocations').length;
    await waitFor(() => expect(count()).toBe(21)); // 1 load + 20 polls
    await new Promise((r) => setTimeout(r, 30));
    expect(count()).toBe(21); // no further polling
  });

  it('shows a critical banner when the synchronization failed', async () => {
    setup([order({ syncState: 'error' })]);
    await see('Synchronisation en erreur');
  });

  it('opens the action with the "Modifier les unités" button', async () => {
    const { onEdit } = setup([order()]);
    await see('Vélo test');
    fireEvent.click(screen.getByText('Modifier les unités', { selector: 's-button' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('recette 2 — reloads after « Modifier les unités » until the action has done its work, without F5', async () => {
    const after = order();
    after.lines[0]!.missing = 0;
    after.lines[0]!.allocations = [...after.lines[0]!.allocations, makeAllocation('SN-NEW', { source: 'pick' })];
    const { m } = setup([order(), order(), after], t, vi.fn(), 5, undefined, 20);
    await see('Vélo test');
    const before = m.calls.length;
    fireEvent.click(screen.getByText('Modifier les unités', { selector: 's-button' }));
    await waitFor(() => expect(pageText()).toContain('SN-NEW'));
    expect(m.calls.length).toBeGreaterThan(before);
  });

  it('recette 2 — returned order: the unit shows its real state and the line keeps its ordered quantity', async () => {
    const r = order();
    r.lines[0] = { ...r.lines[0]!, quantity: 0, orderedQuantity: 1, missing: 0, allocations: [makeAllocation('VR-9', { status: 'fulfilled', unitState: 'RETURN_PENDING' })] };
    setup([r]);
    await see('VR-9');
    expect(pageText()).toContain('× 1');
    expect(pageText()).not.toContain('× 0');
    expect(pageText()).toContain('VR-9 Retour attendu');
    expect(pageText()).toContain('1 en attente de retour');
    expect(pageText()).not.toContain('Expédiée');
  });

  it('recette 3 — after an order edit 3 → 2 the header shows the current quantity and the quantity ordered', async () => {
    const r = order();
    r.lines[0] = { ...r.lines[0]!, quantity: 2, orderedQuantity: 3, missing: 0 };
    setup([r]);
    await see('Vélo test');
    expect(pageText()).toContain('× 2 (3 commandés)');
    expect(pageText()).not.toContain('× 3');
    cleanup();
    setup([r], tEn);
    await see('× 2 (3 ordered)');
  });

  it('recette 3 — refreshes by itself while visible (native admin actions notify nothing), paused while hidden', async () => {
    let i = 0;
    const edited = order();
    edited.lines[0] = { ...edited.lines[0]!, quantity: 2, orderedQuantity: 3 };
    const m = mockFetch({ 'GET /api/v1/orders/9001/allocations': () => (i++ === 0 ? order() : edited) });
    render(<OrderBlock api={createApiClient({ fetch: m.fetch })} t={t} orderGid={ORDER} onEdit={vi.fn()} livePoll={{ fastMs: 10, fastForMs: 60, slowMs: 40 }} />);
    await see('× 3');
    await see('× 2 (3 commandés)');
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    const paused = m.calls.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(m.calls.length).toBe(paused);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(m.calls.length).toBeGreaterThan(paused));
  });

  it('emergency stop: a unit to allocate shows the paused automation instead of the wait for a unit', async () => {
    setup([order({ automationPaused: true })]);
    await see('Vélo test');
    expect(pageText()).toContain("À attribuer Automatisation en pause (arrêt d'urgence)");
    expect(pageText()).not.toContain("En attente d'une unité");
    cleanup();
    setup([order({ automationPaused: true })], tEn);
    await see('Automation paused (emergency stop)');
    expect(pageText()).not.toContain('Waiting for a unit');
  });

  it('has no edit button and says so when no line is tracked', async () => {
    setup([order({ lines: [{ ...order().lines[0]!, tracked: false }] })]);
    await see("Aucune ligne de cette commande n'est suivie");
    expect(document.querySelector('s-button')).toBeNull();
  });

  it('shows an error with retry when the backend refuses', async () => {
    const m = mockFetch({ 'GET /api/v1/orders/9001/allocations': () => problem(404, 'not_found') });
    render(<OrderBlock api={createApiClient({ fetch: m.fetch })} t={t} orderGid={ORDER} onEdit={() => {}} />);
    await see('Élément introuvable');
    await waitFor(() => expect(screen.getByText('Réessayer', { selector: 's-button' })).toBeTruthy());
  });

  it('gives the collapsed summary of the block', async () => {
    const onSummary = vi.fn();
    setup([order()], t, vi.fn(), 5, onSummary);
    await waitFor(() => expect(onSummary).toHaveBeenLastCalledWith('1 unité à attribuer'));
  });

  it('an order with many units stays compact: 2 lines, 4 unit rows, the rest counted next to the edit button', async () => {
    const line = (n: number, title: string, units: number, missing: number) => ({
      lineItemGid: `gid://shopify/LineItem/${n}`, variantGid: VARIANT, title, tracked: true, quantity: units + missing, missing,
      allocations: Array.from({ length: units }, (_, i) => makeAllocation(`L${n}-${i + 1}`, { id: `a-${n}-${i}`, lineItemGid: `gid://shopify/LineItem/${n}` })),
    });
    setup([order({ lines: [line(1, 'Vélo A', 10, 0), line(2, 'Vélo B', 5, 1), line(3, 'Vélo C', 3, 0)] })]);
    await see('Vélo B');
    // the line with a unit to allocate comes first, 2 rows per line, a third line left out
    expect(pageText()).toMatch(/Vélo B .*L2-1.*L2-2.*Vélo A .*L1-1.*L1-2/);
    expect(pageText()).not.toContain('L1-3');
    expect(pageText()).not.toContain('Vélo C');
    expect(pageText()).toContain('+15 autres unités · +1 autre ligne suivie'); // (6 - 2) + (10 - 2) + 3
    expect(blockHeight()).toBeLessThanOrEqual(BLOCK_HEIGHT_BUDGET);
  });
});
