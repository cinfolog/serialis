import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { OrderAllocationsResponse } from '@serialis/contract';
import { createApiClient } from '@serialis/extensions-shared';
import { LINE, ORDER, VARIANT, makeAllocation, mockFetch, pageText, problem, see, translatorFromFile } from '@serialis/extensions-shared/testing';
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

function setup(responses: OrderAllocationsResponse[], translate = t, onEdit = vi.fn(), pollMs = 5) {
  let i = 0;
  const m = mockFetch({ 'GET /api/v1/orders/9001/allocations': () => responses[Math.min(i++, responses.length - 1)] });
  render(<OrderBlock api={createApiClient({ fetch: m.fetch })} t={translate} orderGid={ORDER} onEdit={onEdit} pollMs={pollMs} formatDateTime={(iso) => `le ${iso.slice(0, 10)}`} />);
  return { m, onEdit };
}

describe('OrderBlock', () => {
  it('shows one row per unit under each tracked line with ref, state and origin, plus missing units', async () => {
    const { m } = setup([order()]);
    await see('Vélo test');
    const rows = [...document.querySelectorAll('s-table-row')].map((r) => [...r.querySelectorAll('s-table-cell')].map((c) => c.textContent));
    expect(rows).toEqual([
      ['SN-001', 'Attribuée', 'Commande (automatique)'],
      ['SN-002', 'Expédiée', 'Manuelle'],
      ['À attribuer', 'En attente d\'une unité', '–'],
    ]);
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
});
