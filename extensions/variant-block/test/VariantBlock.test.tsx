import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { CreateUnitsBatchRequest } from '@serialis/contract';
import { createApiClient } from '@serialis/extensions-shared';
import {
  BLOCK_HEIGHT_BUDGET, LOCATIONS, VARIANT, blockHeight, choose, makeTrackedItem, makeUnit, mockFetch, pageText, problem, see, translatorFromFile, typeInto, valueOf,
} from '@serialis/extensions-shared/testing';
import { VariantBlock } from '../src/VariantBlock';

const t = translatorFromFile(join(import.meta.dirname, '..', 'locales', 'fr.default.json'), 'fr');
const tEn = translatorFromFile(join(import.meta.dirname, '..', 'locales', 'en.json'), 'en');

afterEach(cleanup);

const page = <T,>(items: T[]) => ({ items, nextCursor: null });
const text = () => pageText();
const button = (label: string | RegExp) =>
  screen.getByText(label, { selector: 's-button' }) as HTMLElement;

/** Opens the add form, which replaces the summary. */
async function openAdd() {
  await waitFor(() => button('Ajouter des refs'));
  fireEvent.click(button('Ajouter des refs'));
  await waitFor(() => expect(document.querySelector('s-text-area')).not.toBeNull());
}

function setup(opts: {
  item?: ReturnType<typeof makeTrackedItem> | null;
  units?: ReturnType<typeof makeUnit>[];
  extra?: Parameters<typeof mockFetch>[0];
  lang?: 'fr' | 'en';
  onSummary?: (s: string) => void;
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
  render(<VariantBlock api={api} t={opts.lang === 'en' ? tEn : t} variantGid={VARIANT} {...(opts.onSummary ? { onSummary: opts.onSummary } : {})} />);
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

  it('paste → per-line statuses → effect announced → one batch call with an Idempotency-Key', async () => {
    let body: CreateUnitsBatchRequest | undefined;
    const m = setup({
      item: makeTrackedItem({ stock: [{ locationId: 'loc-a', shopifyOnHand: 5, registeredUnits: 3, availableUnits: 3 }] }),
      extra: {
        'POST /api/v1/units/batch': (c) => {
          body = c.body as CreateUnitsBatchRequest;
          return { created: [makeUnit('NEW-1'), makeUnit('NEW-2')], rejected: [] };
        },
      },
    });
    await openAdd();
    // gap 2 at the first location → "already counted" is proposed by default
    choose(document.querySelector('s-choice-list')!, 'received');
    typeInto(document.querySelector('s-text-area')!, 'NEW-1\nnew-1, NEW-2; AB-001\nTOO' + 'X'.repeat(200));
    await waitFor(() => expect(text()).toContain('2 prête(s), 1 doublon(s) dans la liste, 1 déjà connue(s), 1 au format invalide'));
    expect(text()).toContain('Doublon dans la liste');
    expect(text()).toContain('Déjà connue');
    expect(text()).toContain('Format invalide');

    fireEvent.click(button(/Vérifier l'ajout de 2 refs/));
    await see("Confirmer l'ajout");
    expect(text()).toContain('2 unités seront créées à « Entrepôt » et le stock Shopify augmentera de 2');
    expect(m.callsTo('POST /api/v1/units/batch')).toHaveLength(0); // nothing sent before confirmation

    fireEvent.click(button('Ajouter 2 refs'));
    await see('2 refs ajoutées');
    expect(body).toEqual({ variantGid: VARIANT, locationId: 'loc-a', refs: ['NEW-1', 'NEW-2'], alreadyCounted: false, mode: 'per_item' });
    expect(m.callsTo('POST /api/v1/units/batch')[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    // the list is reloaded after the add
    await waitFor(() => expect(m.callsTo('GET /api/v1/units').length).toBeGreaterThan(1));
  });

  it('"already counted" announces no stock write', async () => {
    setup();
    await openAdd();
    typeInto(document.querySelector('s-text-area')!, 'N1 N2');
    fireEvent.click(button(/Vérifier l'ajout de 2 refs/));
    await see("Confirmer l'ajout");
    expect(text()).toContain('sans aucune écriture dans le stock Shopify');
  });

  it('blocks "already counted" when Shopify shows no gap and suggests "Reçues"', async () => {
    setup({ item: makeTrackedItem() }); // 5 on hand, 5 registered
    await openAdd();
    choose(document.querySelector('s-choice-list')!, 'already_counted');
    typeInto(document.querySelector('s-text-area')!, 'N1');
    await see(/Aucun écart dans Shopify/);
    expect(button(/Vérifier l'ajout/).hasAttribute('disabled')).toBe(true);
  });

  it('keeps rejected refs in the field with their reason, and leaves the others added', async () => {
    setup({
      extra: {
        'POST /api/v1/units/batch': () => ({
          created: [makeUnit('N1')],
          rejected: [{ index: 1, ref: 'N2', code: 'identifier_conflict', detail: 'used by another variant' }],
        }),
      },
    });
    await openAdd();
    typeInto(document.querySelector('s-text-area')!, 'N1 N2');
    fireEvent.click(button(/Vérifier l'ajout/));
    await see("Confirmer l'ajout");
    fireEvent.click(button('Ajouter 2 refs'));
    await see('1 ref ajoutée');
    expect(text()).toContain('N2 : Cette ref existe déjà. (used by another variant)');
    await waitFor(() => expect(valueOf(document.querySelector('s-text-area'))).toBe('N2'));
  });

  it('a retry after a network cut reuses the Idempotency-Key (not applied twice)', async () => {
    let attempt = 0;
    let n = 0;
    const m = mockFetch({
      'GET /api/v1/locations': () => page(LOCATIONS),
      'GET /api/v1/tracked-items': () => page([makeTrackedItem({ stock: [{ locationId: 'loc-a', shopifyOnHand: 5, registeredUnits: 3, availableUnits: 3 }] })]),
      'GET /api/v1/units': () => page([]),
      'POST /api/v1/units/batch': () => {
        if (++attempt === 1) throw new TypeError('Failed to fetch');
        return { created: [makeUnit('N1')], rejected: [] };
      },
    });
    render(<VariantBlock api={createApiClient({ fetch: m.fetch, newIdempotencyKey: () => `key-${++n}` })} t={t} variantGid={VARIANT} />);
    await openAdd();
    typeInto(document.querySelector('s-text-area')!, 'N1');
    fireEvent.click(button(/Vérifier l'ajout/));
    await see("Confirmer l'ajout");
    fireEvent.click(button('Ajouter 1 ref'));
    await see(/Connexion impossible/);
    expect(valueOf(document.querySelector('s-text-area'))).toBe('N1'); // input kept
    fireEvent.click(button('Ajouter 1 ref'));
    await see('1 ref ajoutée');
    const keys = m.callsTo('POST /api/v1/units/batch').map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('shows the problem message of a refused add', async () => {
    setup({ extra: { 'POST /api/v1/units/batch': () => problem(403, 'forbidden') } });
    await openAdd();
    typeInto(document.querySelector('s-text-area')!, 'N1');
    fireEvent.click(button(/Vérifier l'ajout/));
    await see("Confirmer l'ajout");
    fireEvent.click(button('Ajouter 1 ref'));
    await see(/pas les droits nécessaires/);
  });

  it('blocks submissions while offline and shows the banner', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    setup();
    await see('Hors connexion');
    await openAdd();
    typeInto(document.querySelector('s-text-area')!, 'N1');
    expect(button(/Vérifier l'ajout/).hasAttribute('disabled')).toBe(true);
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

  it('the add form replaces the summary (no stacking) and fits the budget with one location', async () => {
    setup({
      item: makeTrackedItem({ stock: [{ locationId: 'loc-a', shopifyOnHand: 10, registeredUnits: 0, availableUnits: 0 }] }),
      units: [],
      extra: { 'GET /api/v1/locations': () => page([LOCATIONS[0]!]) },
    });
    await openAdd();
    expect(text()).not.toContain('Entrepôt · Shopify');
    expect(text()).toContain('Emplacement : Entrepôt');
    expect(document.querySelector('s-select')).toBeNull(); // a single location needs no choice
    expect(blockHeight()).toBeLessThanOrEqual(BLOCK_HEIGHT_BUDGET);
    fireEvent.click(button('Retour'));
    await see('Entrepôt · Shopify 10 · 0 ref');
    expect(document.querySelector('s-text-area')).toBeNull();
  });

  it('offers the location choice when several locations can receive refs', async () => {
    setup({ item: makeTrackedItem({ stock: [
      { locationId: 'loc-a', shopifyOnHand: 2, registeredUnits: 0, availableUnits: 0 },
      { locationId: 'loc-b', shopifyOnHand: 1, registeredUnits: 0, availableUnits: 0 },
    ] }), units: [] });
    await openAdd();
    expect(document.querySelector('s-select')).not.toBeNull();
    expect(blockHeight()).toBeLessThanOrEqual(BLOCK_HEIGHT_BUDGET);
  });
});
