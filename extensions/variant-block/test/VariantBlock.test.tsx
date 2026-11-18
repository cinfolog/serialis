import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { CreateUnitsBatchRequest } from '@serialis/contract';
import { createApiClient } from '@serialis/extensions-shared';
import {
  LOCATIONS, VARIANT, choose, makeTrackedItem, makeUnit, mockFetch, pageText, problem, see, translatorFromFile, typeInto, valueOf,
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
  render(<VariantBlock api={api} t={opts.lang === 'en' ? tEn : t} variantGid={VARIANT} />);
  return m;
}

describe('VariantBlock — tracked variant', () => {
  it('shows counts per location and state with the gap against Shopify on_hand', async () => {
    const m = setup();
    await see('Par emplacement');
    expect(text()).toContain('Entrepôt');
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
    await see('By location');
    expect(text()).toContain('2 to register');
  });

  it('shows the initialization banner', async () => {
    setup({ item: makeTrackedItem({ initializing: true }) });
    await see("Phase d'initialisation");
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
    await see('Ajouter des refs');
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
    await see('Ajouter des refs');
    typeInto(document.querySelector('s-text-area')!, 'N1 N2');
    fireEvent.click(button(/Vérifier l'ajout de 2 refs/));
    await see("Confirmer l'ajout");
    expect(text()).toContain('sans aucune écriture dans le stock Shopify');
  });

  it('blocks "already counted" when Shopify shows no gap and suggests "Reçues"', async () => {
    setup({ item: makeTrackedItem() }); // 5 on hand, 5 registered
    await see('Ajouter des refs');
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
    await see('Ajouter des refs');
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
    await see('Ajouter des refs');
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
    await see('Ajouter des refs');
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
    typeInto(document.querySelector('s-text-area')!, 'N1');
    expect(button(/Vérifier l'ajout/).hasAttribute('disabled')).toBe(true);
  });

  it('untrack: announces the effect, then POSTs the untrack action', async () => {
    let body: unknown;
    const m = setup({
      extra: { 'POST /api/v1/tracked-items': (c) => { body = c.body; return page([]); } },
    });
    await see('Ajouter des refs');
    fireEvent.click(button('Arrêter le suivi de cette variante'));
    await see('Arrêter le suivi ?');
    expect(text()).toContain('sans aucune écriture');
    expect(m.callsTo('POST /api/v1/tracked-items')).toHaveLength(0);
    fireEvent.click(button('Arrêter le suivi'));
    await waitFor(() => expect(body).toEqual({ action: 'untrack', variantGids: [VARIANT] }));
  });

  it('shows the server refusal of an untrack (units still allocated)', async () => {
    setup({ extra: { 'POST /api/v1/tracked-items': () => problem(409, 'invalid_transition', '3 units allocated') } });
    await see('Ajouter des refs');
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
    await see('Par emplacement'); // reloaded as tracked
    expect(body).toEqual({ variantGids: [VARIANT] });
    expect(m.callsTo('POST /api/v1/tracked-items')[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
