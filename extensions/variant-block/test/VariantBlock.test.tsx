import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createApiClient } from '@serialis/extensions-shared';
import {
  BLOCK_HEIGHT_BUDGET, LOCATIONS, VARIANT, blockHeight, makeTrackedItem, makeUnit, mockFetch, pageText, problem, see, translatorFromFile,
} from '@serialis/extensions-shared/testing';
import { VariantBlock } from '../src/VariantBlock';

const t = translatorFromFile(join(import.meta.dirname, '..', 'locales', 'fr.default.json'), 'fr');
const tEn = translatorFromFile(join(import.meta.dirname, '..', 'locales', 'en.json'), 'en');

afterEach(cleanup);

const page = <T,>(items: T[]) => ({ items, nextCursor: null });
const text = () => pageText();
const button = (label: string | RegExp) =>
  screen.getByText(label, { selector: 's-button' }) as HTMLElement;

function setup(opts: {
  item?: ReturnType<typeof makeTrackedItem> | null;
  units?: ReturnType<typeof makeUnit>[];
  extra?: Parameters<typeof mockFetch>[0];
  lang?: 'fr' | 'en';
  onSummary?: (s: string) => void;
  onAddRefs?: () => void;
  refreshMs?: number;
} = {}) {
  const item = opts.item === undefined ? makeTrackedItem({ stock: [{ locationId: 'loc-a', shopifyOnHand: 5, registeredUnits: 3, availableUnits: 3 }] }) : opts.item;
  const units = opts.units ?? [makeUnit('AB-001'), makeUnit('AB-002'), makeUnit('AB-003', { state: 'ALLOCATED' })];
  const m = mockFetch({
    'GET /api/v1/locations': () => page(LOCATIONS),
    'GET /api/v1/tracked-items': () => page(item ? [item] : []),
    'GET /api/v1/units': () => page(units),
    ...opts.extra,
  });
  const api = createApiClient({ fetch: m.fetch, newIdempotencyKey: () => 'key-1' });
  const onAddRefs = 'onAddRefs' in opts ? opts.onAddRefs : vi.fn();
  render(
    <VariantBlock
      api={api}
      t={opts.lang === 'en' ? tEn : t}
      variantGid={VARIANT}
      {...(opts.onSummary ? { onSummary: opts.onSummary } : {})}
      {...(onAddRefs ? { onAddRefs } : {})}
      {...(opts.refreshMs ? { refreshMs: opts.refreshMs } : {})}
    />,
  );
  return m;
}

describe('VariantBlock — tracked variant', () => {
  it('shows counts per location and state with the gap against Shopify on_hand', async () => {
    const m = setup();
    await see('Entrepôt · Shopify 5 · 3 refs');
    expect(text()).toContain('2 à enregistrer'); // 5 in Shopify, 3 registered
    expect(text()).toContain('Disponible');
    expect(text()).toContain('Attribuée');
    // the block asks only for its own variant
    expect(m.callsTo('GET /api/v1/tracked-items')[0]!.query.get('variant')).toBe(VARIANT);
    expect(m.callsTo('GET /api/v1/units')[0]!.query.get('variant')).toBe(VARIANT);
    expect(text()).toContain('AB-001');
  });

  it('is available in English', async () => {
    setup({ lang: 'en' });
    await see('Entrepôt · Shopify 5 · 3 refs');
    expect(text()).toContain('2 to register');
  });

  it('shows a one-line initialization hint while Shopify still shows units to register', async () => {
    setup({ item: makeTrackedItem({ initializing: true, stock: [{ locationId: 'loc-a', shopifyOnHand: 5, registeredUnits: 3, availableUnits: 3 }] }) });
    await see('Initialisation : saisissez le stock existant en « déjà comptées ».');
    expect(document.querySelector('s-banner')).toBeNull();
  });

  it('drops the initialization hint once the gap is closed', async () => {
    setup({ item: makeTrackedItem({ initializing: true }) });
    await see('Aligné');
    expect(text()).not.toContain('Initialisation');
  });

  it('shows a loading state, then an error with retry', async () => {
    setup({ extra: { 'GET /api/v1/locations': () => problem(500, 'unknown') } });
    expect(text()).toContain('Chargement');
    await see('Action impossible');
    expect(text()).toContain('Une erreur inattendue');
    expect(screen.getByText('Réessayer', { selector: 's-button' })).toBeTruthy();
  });

  it('untrack: announces the effect, then POSTs the untrack action', async () => {
    let body: unknown;
    const m = setup({
      extra: { 'POST /api/v1/tracked-items': (c) => { body = c.body; return page([]); } },
    });
    await see('Entrepôt · Shopify');
    fireEvent.click(button('Arrêter le suivi de cette variante'));
    await see('Arrêter le suivi ?');
    expect(text()).toContain('sans aucune écriture');
    expect(m.callsTo('POST /api/v1/tracked-items')).toHaveLength(0);
    fireEvent.click(button('Arrêter le suivi'));
    await waitFor(() => expect(body).toEqual({ action: 'untrack', variantGids: [VARIANT] }));
  });

  it('shows the server refusal of an untrack (units still allocated)', async () => {
    setup({ extra: { 'POST /api/v1/tracked-items': () => problem(409, 'invalid_transition', '3 units allocated') } });
    await see('Entrepôt · Shopify');
    fireEvent.click(button('Arrêter le suivi de cette variante'));
    await see('Arrêter le suivi ?');
    fireEvent.click(button('Arrêter le suivi'));
    await see(/3 units allocated/);
  });
});

describe('VariantBlock — untracked variant', () => {
  it('offers to track, announces the effect, then POSTs /tracked-items', async () => {
    let body: unknown;
    let tracked = false;
    const m = setup({
      item: null,
      extra: {
        'GET /api/v1/tracked-items': () => page(tracked ? [makeTrackedItem()] : []),
        'POST /api/v1/tracked-items': (c) => { body = c.body; tracked = true; return page([makeTrackedItem()]); },
      },
    });
    await see(/n'est pas encore suivie/);
    fireEvent.click(button('Suivre les refs'));
    await see('Activer le suivi des refs ?');
    expect(m.callsTo('POST /api/v1/tracked-items')).toHaveLength(0);
    fireEvent.click(button('Activer le suivi'));
    await see('Entrepôt · Shopify 5 · 5 refs'); // reloaded as tracked
    expect(body).toEqual({ variantGids: [VARIANT] });
    expect(m.callsTo('POST /api/v1/tracked-items')[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('VariantBlock — compact rendering (essential content within the 300 px of a collapsed block)', () => {
  const units = (n: number) =>
    Array.from({ length: n }, (_, i) => makeUnit(`R-${i + 1}`, { receivedAt: `2026-03-0${i + 1}T10:00:00Z`, locationId: i % 2 ? 'loc-b' : 'loc-a' }));

  it('typical variant in initialization (1 location, 0 refs): one line, no table, no form, within budget', async () => {
    const onSummary = vi.fn();
    setup({
      item: makeTrackedItem({ initializing: true, stock: [{ locationId: 'loc-a', shopifyOnHand: 10, registeredUnits: 0, availableUnits: 0 }] }),
      units: [],
      onSummary,
    });
    await see('Entrepôt · Shopify 10 · 0 ref');
    expect(text()).toContain('10 à enregistrer');
    expect(text()).toContain('Aucune ref enregistrée');
    expect(document.querySelector('s-table')).toBeNull();
    expect(document.querySelector('s-text-area')).toBeNull();
    expect(document.querySelector('s-banner')).toBeNull();
    expect(button('Ajouter des refs').getAttribute('variant')).toBe('primary');
    expect(blockHeight()).toBeLessThanOrEqual(BLOCK_HEIGHT_BUDGET);
    await waitFor(() => expect(onSummary).toHaveBeenLastCalledWith('0 ref · 10 à enregistrer'));
    expect(onSummary.mock.lastCall![0].length).toBeLessThanOrEqual(30);
  });

  it('2 locations and 5 refs: one line per location, the 3 most recent refs and a link to the full list', async () => {
    setup({
      item: makeTrackedItem({ stock: [
        { locationId: 'loc-a', shopifyOnHand: 4, registeredUnits: 3, availableUnits: 3 },
        { locationId: 'loc-b', shopifyOnHand: 2, registeredUnits: 2, availableUnits: 2 },
      ] }),
      units: units(5),
    });
    await see('Boutique · Shopify 2 · 2 refs');
    expect(text()).toContain('Entrepôt · Shopify 4 · 3 refs');
    expect(document.querySelector('s-table')).toBeNull();
    const shown = ['R-1', 'R-2', 'R-3', 'R-4', 'R-5'].filter((r) => text().includes(r));
    expect(shown).toEqual(['R-3', 'R-4', 'R-5']); // most recent first, 3 at most
    const link = button('Voir les 5 refs');
    expect(link.getAttribute('href')).toBe(`app:units?variant=${encodeURIComponent(VARIANT)}`);
    expect(blockHeight()).toBeLessThanOrEqual(BLOCK_HEIGHT_BUDGET);
  });

  it('collapsed summary in English', async () => {
    const onSummary = vi.fn();
    setup({ lang: 'en', onSummary });
    await waitFor(() => expect(onSummary).toHaveBeenLastCalledWith('3 refs · 2 to register'));
  });

  it('4 locations: a table capped at 3 rows, locations with a gap first, and the count of the others', async () => {
    const locations = [...LOCATIONS, { id: 'loc-c', name: 'Atelier', active: true }, { id: 'loc-d', name: 'Dépôt', active: true }];
    setup({
      item: makeTrackedItem({ stock: [
        { locationId: 'loc-a', shopifyOnHand: 1, registeredUnits: 1, availableUnits: 1 },
        { locationId: 'loc-b', shopifyOnHand: 1, registeredUnits: 1, availableUnits: 1 },
        { locationId: 'loc-c', shopifyOnHand: 1, registeredUnits: 1, availableUnits: 1 },
        { locationId: 'loc-d', shopifyOnHand: 3, registeredUnits: 1, availableUnits: 1 },
      ] }),
      units: units(3),
      extra: { 'GET /api/v1/locations': () => page(locations) },
    });
    await see('+1 autre emplacement');
    const rows = [...document.querySelectorAll('s-table-body > s-table-row')].map((r) => r.querySelector('s-table-cell')!.textContent);
    expect(rows).toEqual(['Dépôt', 'Entrepôt', 'Boutique']);
    expect(text()).not.toContain('R-1'); // no room for inline refs next to the table: the link opens them
    expect(button('Voir les 3 refs')).toBeTruthy();
    expect(blockHeight()).toBeLessThanOrEqual(BLOCK_HEIGHT_BUDGET);
  });
});

describe('VariantBlock — adding refs opens the action modal', () => {
  it('« Ajouter des refs » navigates to the action; no form in the block', async () => {
    const onAddRefs = vi.fn();
    setup({ onAddRefs });
    await see('Entrepôt · Shopify 5 · 3 refs');
    fireEvent.click(button('Ajouter des refs'));
    expect(onAddRefs).toHaveBeenCalledTimes(1);
    expect(document.querySelector('s-text-area')).toBeNull();
    expect(document.querySelector('s-choice-list')).toBeNull();
    expect(document.querySelector('s-select')).toBeNull();
    expect(text()).toContain('Entrepôt · Shopify 5 · 3 refs'); // the summary stays
    expect(blockHeight()).toBeLessThanOrEqual(BLOCK_HEIGHT_BUDGET);
  });

  it('reloads the summary after the action was opened (no close event reaches the block)', async () => {
    let registered = 3;
    const m = setup({
      refreshMs: 20,
      extra: {
        'GET /api/v1/tracked-items': () =>
          page([makeTrackedItem({ stock: [{ locationId: 'loc-a', shopifyOnHand: 5, registeredUnits: registered, availableUnits: registered }] })]),
      },
    });
    await see('Entrepôt · Shopify 5 · 3 refs');
    const before = m.callsTo('GET /api/v1/tracked-items').length;
    await new Promise((r) => setTimeout(r, 60));
    expect(m.callsTo('GET /api/v1/tracked-items').length).toBe(before); // no polling before the action is opened
    fireEvent.click(button('Ajouter des refs'));
    registered = 5; // refs added in the modal
    await see('Entrepôt · Shopify 5 · 5 refs');
    expect(text()).toContain('Aligné');
  });

  it('reloads at once when the page becomes visible again', async () => {
    const m = setup({ refreshMs: 60_000 });
    await see('Entrepôt · Shopify 5 · 3 refs');
    fireEvent.click(button('Ajouter des refs'));
    const before = m.callsTo('GET /api/v1/tracked-items').length;
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(m.callsTo('GET /api/v1/tracked-items').length).toBe(before + 1));
  });

  it('without navigation, links to the add form of the app (Units screen, add=1)', async () => {
    setup({ onAddRefs: undefined });
    await see('Entrepôt · Shopify 5 · 3 refs');
    expect(button('Ajouter des refs').getAttribute('href')).toBe(`app:units?variant=${encodeURIComponent(VARIANT)}&add=1`);
  });

  it('fits the budget with 2 locations, 5 refs and the initialization hint', async () => {
    setup({
      item: makeTrackedItem({ initializing: true, stock: [
        { locationId: 'loc-a', shopifyOnHand: 6, registeredUnits: 3, availableUnits: 3 },
        { locationId: 'loc-b', shopifyOnHand: 2, registeredUnits: 2, availableUnits: 2 },
      ] }),
      units: Array.from({ length: 5 }, (_, i) => makeUnit(`R-${i + 1}`, { locationId: i % 2 ? 'loc-b' : 'loc-a' })),
    });
    await see('Initialisation');
    expect(blockHeight()).toBeLessThanOrEqual(BLOCK_HEIGHT_BUDGET);
  });
});
