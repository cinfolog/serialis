import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { OrderAllocationsResponse } from '@serialis/contract';
import { createApiClient } from '@serialis/extensions-shared';
import {
  LINE, LOCATIONS, ORDER, VARIANT, choose, makeAllocation, makeUnit, mockFetch, pageText, problem, see, translatorFromFile, typeInto,
} from '@serialis/extensions-shared/testing';
import { OrderAction } from '../src/OrderAction';

const t = translatorFromFile(join(import.meta.dirname, '..', 'locales', 'fr.default.json'), 'fr');
const tEn = translatorFromFile(join(import.meta.dirname, '..', 'locales', 'en.json'), 'en');
afterEach(cleanup);

const page = <T,>(items: T[]) => ({ items, nextCursor: null });
const button = (label: string | RegExp) => screen.getByText(label, { selector: 's-button' }) as HTMLElement;
const disabled = (el: HTMLElement) => el.hasAttribute('disabled');

const AVAILABLE = [
  makeUnit('NEW-0001', { receivedAt: '2026-03-02T00:00:00Z' }),
  makeUnit('NEW-0002', { receivedAt: '2026-03-01T00:00:00Z' }),
  makeUnit('ZZ-A777', { locationId: 'loc-b', receivedAt: '2026-03-03T00:00:00Z' }),
];

function order(over: Partial<OrderAllocationsResponse['lines'][number]> = {}): OrderAllocationsResponse {
  return {
    orderGid: ORDER,
    lines: [{
      lineItemGid: LINE, variantGid: VARIANT, title: 'Vélo test', tracked: true, quantity: 3, missing: 1,
      allocations: [makeAllocation('OLD-1'), makeAllocation('SHIPPED-1', { status: 'fulfilled' })],
      ...over,
    }],
    syncState: 'synced', syncedAt: '2026-03-02T10:00:05Z',
  };
}

function setup(extra: Parameters<typeof mockFetch>[0] = {}, opts: { translate?: typeof t; close?: () => void; allocations?: OrderAllocationsResponse } = {}) {
  const m = mockFetch({
    'GET /api/v1/orders/9001/allocations': () => opts.allocations ?? order(),
    'GET /api/v1/locations': () => page(LOCATIONS),
    'GET /api/v1/units': () => page(AVAILABLE),
    ...extra,
  });
  const close = opts.close ?? vi.fn();
  render(<OrderAction api={createApiClient({ fetch: m.fetch })} t={opts.translate ?? t} orderGid={ORDER} close={close} />);
  return { m, close };
}

async function openPanel(label: string, index = 0) {
  await see('Vélo test');
  fireEvent.click(screen.getAllByText(label, { selector: 's-button' })[index]!);
}

describe('OrderAction — list', () => {
  it('lists the units of each tracked line: replace/remove while allocated, locked once shipped, allocate when missing', async () => {
    setup();
    await see('Vélo test');
    expect(screen.getAllByText('Remplacer', { selector: 's-button' })).toHaveLength(1); // only the active one
    expect(screen.getAllByText('Retirer', { selector: 's-button' })).toHaveLength(1);
    expect(pageText()).toContain('Non modifiable'); // shipped unit
    expect(screen.getAllByText('Attribuer', { selector: 's-button' })).toHaveLength(1); // one missing unit
  });

  it('closes the action', async () => {
    const { close } = setup();
    await see('Vélo test');
    fireEvent.click(button('Fermer'));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('says so when no line is tracked', async () => {
    setup({}, { allocations: { ...order(), lines: [{ ...order().lines[0]!, tracked: false }] } });
    await see("Aucune ligne de cette commande n'est suivie");
  });

  it('is available in English', async () => {
    setup({}, { translate: tEn });
    await see('Locked');
    expect(pageText()).toContain('Edit units');
    expect(pageText()).toContain('Replace');
  });
});

describe('OrderAction — allocate', () => {
  it('chooses a unit in the list, announces the effect, then POSTs /allocations with an Idempotency-Key', async () => {
    const { m } = setup({ 'POST /api/v1/allocations': () => makeAllocation('NEW-0002') });
    await openPanel('Attribuer');
    await see('Attribuer une unité à « Vélo test »');
    // available units of the variant, oldest first, with their location
    await waitFor(() => expect(document.querySelectorAll('s-option').length).toBe(4));
    expect([...document.querySelectorAll('s-option')].map((o) => o.textContent)).toEqual([
      'Choisir une unité…', 'NEW-0002 · Entrepôt', 'NEW-0001 · Entrepôt', 'ZZ-A777 · Boutique',
    ]);
    const listCall = m.callsTo('GET /api/v1/units').at(-1)!;
    expect(listCall.query.get('variant')).toBe(VARIANT);
    expect(listCall.query.get('state')).toBe('AVAILABLE');

    const confirm = button("Attribuer cette unité");
    expect(disabled(confirm)).toBe(true); // nothing chosen yet
    typeInto(document.querySelector('s-select')!, AVAILABLE[1]!.id);
    await see("L'unité NEW-0002 sera attribuée à « Vélo test »");
    expect(pageText()).toContain('Stock Shopify : aucune écriture.');
    expect(m.callsTo('POST /api/v1/allocations')).toHaveLength(0); // announced before any call

    fireEvent.click(button("Attribuer cette unité"));
    await see('Unité attribuée.');
    const post = m.callsTo('POST /api/v1/allocations')[0]!;
    expect(post.body).toEqual({ orderGid: ORDER, lineItemGid: LINE, unitId: AVAILABLE[1]!.id });
    expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    // back on the list, reloaded
    await waitFor(() => expect(m.callsTo('GET /api/v1/orders/9001/allocations').length).toBe(2));
  });

  it('designates by typing the unique last 4 characters; Enter submits; the list is not needed', async () => {
    const { m } = setup({ 'POST /api/v1/allocations': () => makeAllocation('ZZ-A777') });
    await openPanel('Attribuer');
    await waitFor(() => expect(document.querySelector('s-choice-list')).toBeTruthy());
    choose(document.querySelector('s-choice-list')!, 'typed');
    await waitFor(() => expect(document.querySelector('s-text-field')).toBeTruthy());

    typeInto(document.querySelector('s-text-field')!, 'NEW');
    expect(disabled(button('Attribuer cette unité'))).toBe(true);
    fireEvent.keyDown(document.querySelector('s-text-field')!, { key: 'Enter' });
    expect(m.callsTo('POST /api/v1/allocations')).toHaveLength(0); // Enter never validates a suggestion

    typeInto(document.querySelector('s-text-field')!, 'a777');
    await see("L'unité ZZ-A777 sera attribuée");
    expect(disabled(button('Attribuer cette unité'))).toBe(false);
    fireEvent.keyDown(document.querySelector('s-text-field')!, { key: 'Enter' });
    await see('Unité attribuée.');
    expect(m.callsTo('POST /api/v1/allocations')[0]!.body).toMatchObject({ unitId: AVAILABLE[2]!.id });
  });

  it('does not validate ambiguous or unknown typed refs', async () => {
    setup();
    await openPanel('Attribuer');
    await waitFor(() => expect(document.querySelector('s-choice-list')).toBeTruthy());
    choose(document.querySelector('s-choice-list')!, 'typed');
    await waitFor(() => expect(document.querySelector('s-text-field')).toBeTruthy());
    typeInto(document.querySelector('s-text-field')!, '0001');
    // only NEW-0001 ends with 0001 → recognized; 0002 likewise; "NEW-" is too short for a designation
    await see('Unité reconnue par ses 4 derniers caractères : NEW-0001');
    typeInto(document.querySelector('s-text-field')!, 'QQQQ');
    await see('Aucune unité proposée ne correspond');
    expect(disabled(button('Attribuer cette unité'))).toBe(true);
  });

  it('warns when the variant has no available unit', async () => {
    setup({ 'GET /api/v1/units': () => page([]) });
    await openPanel('Attribuer');
    await see('Aucune unité disponible pour cette variante');
  });

  it('shows the refusal of an unavailable unit and stays on the panel', async () => {
    setup({ 'POST /api/v1/allocations': () => problem(409, 'unit_not_available', 'commande #1042') });
    await openPanel('Attribuer');
    await waitFor(() => expect(document.querySelectorAll('s-option').length).toBe(4));
    typeInto(document.querySelector('s-select')!, AVAILABLE[0]!.id);
    fireEvent.click(button('Attribuer cette unité'));
    await see('Cette unité n\'est pas disponible : elle est déjà attribuée à une commande, réservée ou verrouillée. (commande #1042)');
    expect(pageText()).toContain('Attribuer une unité à « Vélo test »');
  });

  it('reuses the Idempotency-Key when retrying after a network failure', async () => {
    let n = 0;
    const { m } = setup({
      'POST /api/v1/allocations': () => {
        if (++n === 1) throw new TypeError('Failed to fetch');
        return makeAllocation('NEW-0001');
      },
    });
    await openPanel('Attribuer');
    await waitFor(() => expect(document.querySelectorAll('s-option').length).toBe(4));
    typeInto(document.querySelector('s-select')!, AVAILABLE[0]!.id);
    fireEvent.click(button('Attribuer cette unité'));
    await see('Connexion impossible');
    fireEvent.click(button('Attribuer cette unité'));
    await see('Unité attribuée.');
    const keys = m.callsTo('POST /api/v1/allocations').map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('blocks confirmation while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    setup();
    await see('Hors connexion');
    await see('Vélo test');
    fireEvent.click(screen.getAllByText('Attribuer', { selector: 's-button' })[0]!);
    await waitFor(() => expect(document.querySelectorAll('s-option').length).toBe(4));
    typeInto(document.querySelector('s-select')!, AVAILABLE[0]!.id);
    expect(disabled(button('Attribuer cette unité'))).toBe(true);
  });
});

describe('OrderAction — replace', () => {
  it('replaces the unit: announces both refs, POSTs /allocations/{id}/replace', async () => {
    const { m } = setup({ [`POST /api/v1/allocations/${makeAllocation('OLD-1').id}/replace`]: () => makeAllocation('NEW-0001') });
    await openPanel('Remplacer');
    await see("Remplacer l'unité de « Vélo test »");
    expect(pageText()).toContain('Unité actuelle : OLD-1');
    await waitFor(() => expect(document.querySelectorAll('s-option').length).toBe(4));
    typeInto(document.querySelector('s-select')!, AVAILABLE[0]!.id);
    await see("L'unité NEW-0001 remplacera OLD-1 sur « Vélo test » ; OLD-1 redevient disponible.");
    fireEvent.click(button("Remplacer l'unité"));
    await see('Unité remplacée.');
    const post = m.calls.find((c) => c.method === 'POST')!;
    expect(post.pathname).toBe('/api/v1/allocations/alloc-OLD-1/replace');
    expect(post.body).toEqual({ unitId: AVAILABLE[0]!.id });
    expect(post.headers['idempotency-key']).toBeTruthy();
  });

  it('on a 412 conflict, shows the reload button that returns to the refreshed list', async () => {
    const { m } = setup({ 'POST /api/v1/allocations/alloc-OLD-1/replace': () => problem(412, 'precondition_failed') });
    await openPanel('Remplacer');
    await waitFor(() => expect(document.querySelectorAll('s-option').length).toBe(4));
    typeInto(document.querySelector('s-select')!, AVAILABLE[0]!.id);
    fireEvent.click(button("Remplacer l'unité"));
    await see('Cette unité a été modifiée entre-temps');
    fireEvent.click(button('Recharger'));
    await see('Vélo test');
    expect(screen.queryByText('Recharger', { selector: 's-button' })).toBeNull();
    await waitFor(() => expect(m.callsTo('GET /api/v1/orders/9001/allocations').length).toBe(2));
  });
});

describe('OrderAction — remove', () => {
  it('announces the effect first; DELETE /allocations/{id} only after confirmation', async () => {
    const { m } = setup({ 'DELETE /api/v1/allocations/alloc-OLD-1': () => undefined });
    await openPanel('Retirer');
    await see("L'unité OLD-1 redevient disponible");
    expect(pageText()).toContain('Stock Shopify : aucune écriture.');
    expect(m.callsTo('DELETE /api/v1/allocations/alloc-OLD-1')).toHaveLength(0);
    expect(m.callsTo('GET /api/v1/units')).toHaveLength(0); // no unit to choose
    fireEvent.click(button("Retirer l'attribution"));
    await see('Attribution retirée.');
    expect(m.callsTo('DELETE /api/v1/allocations/alloc-OLD-1')).toHaveLength(1);
  });

  it('shows the refusal when the unit is already shipped or in preparation', async () => {
    setup({ 'DELETE /api/v1/allocations/alloc-OLD-1': () => problem(409, 'invalid_transition') });
    await openPanel('Retirer');
    fireEvent.click(button("Retirer l'attribution"));
    await see('Action impossible dans l\'état actuel');
  });

  it('can go back without changing anything', async () => {
    const { m } = setup();
    await openPanel('Retirer');
    await see("L'unité OLD-1 redevient disponible");
    fireEvent.click(button('Retour'));
    await see('Non modifiable');
    expect(m.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
});
