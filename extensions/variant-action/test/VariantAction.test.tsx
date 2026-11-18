import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { CreateUnitsBatchRequest, Location, TrackedItem } from '@serialis/contract';
import { createApiClient } from '@serialis/extensions-shared';
import {
  LOCATIONS, VARIANT, choose, makeTrackedItem, makeUnit, mockFetch, pageText, problem, see, translatorFromFile, typeInto, valueOf,
} from '@serialis/extensions-shared/testing';
import { VariantAction } from '../src/VariantAction';

const t = translatorFromFile(join(import.meta.dirname, '..', 'locales', 'fr.default.json'), 'fr');
const tEn = translatorFromFile(join(import.meta.dirname, '..', 'locales', 'en.json'), 'en');
afterEach(cleanup);

const page = <T,>(items: T[]) => ({ items, nextCursor: null });
const text = () => pageText();
const button = (label: string | RegExp) => screen.getByText(label, { selector: 's-button' }) as HTMLElement;
const disabled = (el: HTMLElement) => el.hasAttribute('disabled');
const area = () => document.querySelector('s-text-area')!;
const kinds = () => document.querySelector('s-choice-list')!;
/** Polaris components are unknown elements under jsdom: Preact renders `values` / `value` as attributes. */
const kindValue = () => kinds().getAttribute('values');
const selectValue = () => document.querySelector('s-select')!.getAttribute('value');

/** Answer of `POST /units/batch/check`: every ref ready unless listed in `known`. */
function checkAll(req: CreateUnitsBatchRequest, known: string[] = []) {
  const rows = req.refs.map((ref, index) => ({ index, ref, status: known.includes(ref) ? 'already_known' : 'ready' }));
  return { rows, ready: rows.filter((r) => r.status === 'ready').length, stockWrite: 0, gapBefore: null };
}
/** Calls of the « already registered » list (pages of 20), apart from the form's full load (pages of 250). */
const listCalls = (m: ReturnType<typeof mockFetch>) => m.callsTo('GET /api/v1/units').filter((c) => c.query.get('limit') === '20');

/** One location, gap 2 (5 in Shopify, 3 refs). */
const ONE_LOCATION = makeTrackedItem({ stock: [{ locationId: 'loc-a', shopifyOnHand: 5, registeredUnits: 3, availableUnits: 3 }] });

function setup(opts: {
  item?: TrackedItem | null;
  locations?: Location[];
  extra?: Parameters<typeof mockFetch>[0];
  lang?: 'fr' | 'en';
  newKey?: () => string;
} = {}) {
  const item = opts.item === undefined ? ONE_LOCATION : opts.item;
  const m = mockFetch({
    'GET /api/v1/locations': () => page(opts.locations ?? [LOCATIONS[0]!]),
    'GET /api/v1/tracked-items': () => page(item ? [item] : []),
    'GET /api/v1/units': () => page([makeUnit('AB-001'), makeUnit('AB-002'), makeUnit('AB-003')]),
    // server check: nothing more than what the client already knows
    'POST /api/v1/units/batch/check': (c) => checkAll(c.body as CreateUnitsBatchRequest),
    ...opts.extra,
  });
  const close = vi.fn();
  const api = createApiClient({ fetch: m.fetch, ...(opts.newKey ? { newIdempotencyKey: opts.newKey } : {}) });
  render(<VariantAction api={api} t={opts.lang === 'en' ? tEn : t} variantGid={VARIANT} close={close} />);
  return { m, close };
}

async function ready() {
  await waitFor(() => expect(document.querySelector('s-text-area')).not.toBeNull());
}

describe('VariantAction — form', () => {
  it('single location: stated in one line, no select; primary « Ajouter N refs » and secondary « Annuler » in the modal slots', async () => {
    const { m, close } = setup();
    await ready();
    expect(text()).toContain('Emplacement : Entrepôt');
    expect(document.querySelector('s-select')).toBeNull();
    // the variant comes from the selection: only its data is read
    expect(m.callsTo('GET /api/v1/tracked-items')[0]!.query.get('variant')).toBe(VARIANT);
    const primary = button('Ajouter 0 ref');
    expect(primary.getAttribute('slot')).toBe('primary-action');
    expect(disabled(primary)).toBe(true);
    const cancel = button('Annuler');
    expect(cancel.getAttribute('slot')).toBe('secondary-actions');
    fireEvent.click(cancel);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('several locations: a select, starting on the location with units to register; the default kind follows it', async () => {
    setup({
      locations: LOCATIONS,
      item: makeTrackedItem({ stock: [
        { locationId: 'loc-a', shopifyOnHand: 2, registeredUnits: 2, availableUnits: 2 },
        { locationId: 'loc-b', shopifyOnHand: 4, registeredUnits: 1, availableUnits: 1 },
      ] }),
    });
    await ready();
    const select = document.querySelector('s-select')!;
    expect(select).not.toBeNull();
    expect(selectValue()).toBe('loc-b');
    expect(kindValue()).toBe('already_counted'); // gap 3 at loc-b
    typeInto(select, 'loc-a');
    await waitFor(() => expect(kindValue()).toBe('received')); // no gap at loc-a
    expect(text()).not.toContain('Emplacement : ');
  });

  it('initialization: "already counted" by default, with the hint', async () => {
    setup({ item: makeTrackedItem({ initializing: true }) }); // no gap, but initializing
    await ready();
    expect(kindValue()).toBe('already_counted');
    expect(text()).toContain('Initialisation');
  });

  it('live count and per-line duplicate, known and invalid feedback', async () => {
    setup();
    await ready();
    typeInto(area(), 'NEW-1\nnew-1, NEW-2; AB-001\nTOO' + 'X'.repeat(200));
    await see('2 prête(s), 1 doublon(s) dans la liste, 1 déjà enregistrée(s), 1 au format invalide');
    expect(text()).toContain('Doublon dans la liste');
    expect(text()).toContain('Déjà enregistrée — Entrepôt · Disponible');
    expect(text()).toContain('Format invalide');
    expect(disabled(button('Ajouter 2 refs'))).toBe(false);
  });

  it('blocks "already counted" when Shopify shows no gap and suggests « Reçues »', async () => {
    setup({ item: makeTrackedItem() }); // 5 on hand, 5 registered
    await ready();
    choose(kinds(), 'already_counted');
    typeInto(area(), 'N1');
    await see(/Aucun écart dans Shopify/);
    expect(disabled(button('Ajouter 1 ref'))).toBe(true);
  });

  it('warns when "already counted" exceeds the gap', async () => {
    setup();
    await ready();
    typeInto(area(), 'N1 N2 N3');
    await see('Vous ajoutez 3 refs « déjà comptées » pour un écart de 2');
  });

  it('is available in English', async () => {
    setup({ lang: 'en' });
    await ready();
    expect(text()).toContain('Location: Entrepôt');
    expect(text()).toContain('Already counted in Shopify');
    expect(button('Cancel')).toBeTruthy();
  });
});

describe('VariantAction — submit', () => {
  it('received: effect announced, then one per_item batch with an Idempotency-Key; success shows the result and closes', async () => {
    let body: CreateUnitsBatchRequest | undefined;
    const { m, close } = setup({
      extra: {
        'POST /api/v1/units/batch': (c) => {
          body = c.body as CreateUnitsBatchRequest;
          return { created: [makeUnit('NEW-1'), makeUnit('NEW-2')], rejected: [] };
        },
      },
    });
    await ready();
    choose(kinds(), 'received');
    typeInto(area(), 'NEW-1 NEW-2');
    fireEvent.click(button('Ajouter 2 refs'));
    await see("Confirmer l'ajout");
    expect(text()).toContain('2 unités seront créées à « Entrepôt » et le stock Shopify augmentera de 2');
    expect(m.callsTo('POST /api/v1/units/batch')).toHaveLength(0); // nothing sent before confirmation

    fireEvent.click(button("Confirmer l'ajout de 2 refs"));
    await see('2 refs ajoutées');
    expect(body).toEqual({ variantGid: VARIANT, locationId: 'loc-a', refs: ['NEW-1', 'NEW-2'], alreadyCounted: false, mode: 'per_item' });
    expect(m.callsTo('POST /api/v1/units/batch')[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(text()).toContain('Le bloc de la variante se met à jour');
    expect(document.querySelector('s-text-area')).toBeNull();
    // data reloaded (known refs and gap), then « Fermer » closes the modal
    await waitFor(() => expect(m.callsTo('GET /api/v1/units').length).toBeGreaterThan(1));
    const done = button('Fermer');
    expect(done.getAttribute('slot')).toBe('primary-action');
    fireEvent.click(done);
    expect(close).toHaveBeenCalledTimes(1);
    // « Ajouter d'autres refs » brings the form back
    fireEvent.click(button("Ajouter d'autres refs"));
    await ready();
  });

  it('already counted: announces no stock write and sends alreadyCounted', async () => {
    let body: CreateUnitsBatchRequest | undefined;
    setup({ extra: { 'POST /api/v1/units/batch': (c) => { body = c.body as CreateUnitsBatchRequest; return { created: [makeUnit('N1')], rejected: [] }; } } });
    await ready();
    typeInto(area(), 'N1');
    fireEvent.click(button('Ajouter 1 ref'));
    await see('sans aucune écriture dans le stock Shopify');
    fireEvent.click(button("Confirmer l'ajout de 1 ref"));
    await see('1 ref ajoutée');
    expect(body?.alreadyCounted).toBe(true);
  });

  it('« Retour » from the confirmation goes back to the form without sending', async () => {
    const { m } = setup();
    await ready();
    typeInto(area(), 'N1');
    fireEvent.click(button('Ajouter 1 ref'));
    await see("Confirmer l'ajout");
    fireEvent.click(button('Retour'));
    await waitFor(() => expect(button('Ajouter 1 ref')).toBeTruthy());
    expect(m.callsTo('POST /api/v1/units/batch')).toHaveLength(0);
  });

  it('keeps rejected refs in the field with their reason, the others added', async () => {
    setup({
      extra: {
        'POST /api/v1/units/batch': () => ({
          created: [makeUnit('N1')],
          rejected: [{ index: 1, ref: 'N2', code: 'identifier_conflict', detail: 'used by another variant' }],
        }),
      },
    });
    await ready();
    typeInto(area(), 'N1 N2');
    fireEvent.click(button('Ajouter 2 refs'));
    await see("Confirmer l'ajout");
    fireEvent.click(button("Confirmer l'ajout de 2 refs"));
    await see('1 ref ajoutée');
    expect(text()).toContain('N2 : Cette ref existe déjà. (used by another variant)');
    await waitFor(() => expect(valueOf(area())).toBe('N2'));
    expect(button('Fermer').getAttribute('slot')).toBe('secondary-actions'); // something was added: « Fermer », not « Annuler »
  });

  it('shows the problem message of a refused add and keeps the input', async () => {
    setup({ extra: { 'POST /api/v1/units/batch': () => problem(403, 'forbidden') } });
    await ready();
    typeInto(area(), 'N1');
    fireEvent.click(button('Ajouter 1 ref'));
    await see("Confirmer l'ajout");
    fireEvent.click(button("Confirmer l'ajout de 1 ref"));
    await see(/pas les droits nécessaires/);
    expect(valueOf(area())).toBe('N1');
  });

  it('a retry after a network cut reuses the Idempotency-Key (not applied twice)', async () => {
    let attempt = 0;
    let n = 0;
    const { m } = setup({
      newKey: () => `key-${++n}`,
      extra: {
        'POST /api/v1/units/batch': () => {
          if (++attempt === 1) throw new TypeError('Failed to fetch');
          return { created: [makeUnit('N1')], rejected: [] };
        },
      },
    });
    await ready();
    typeInto(area(), 'N1');
    fireEvent.click(button('Ajouter 1 ref'));
    await see("Confirmer l'ajout");
    fireEvent.click(button("Confirmer l'ajout de 1 ref"));
    await see(/Connexion impossible/);
    expect(valueOf(area())).toBe('N1');
    fireEvent.click(button("Confirmer l'ajout de 1 ref"));
    await see('1 ref ajoutée');
    const keys = m.callsTo('POST /api/v1/units/batch').map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('blocks submissions while offline and shows the banner', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    setup();
    await ready();
    expect(text()).toContain('Hors connexion');
    typeInto(area(), 'N1');
    await waitFor(() => expect(disabled(button('Ajouter 1 ref'))).toBe(true));
  });
});

describe('VariantAction — other states', () => {
  it('loading error with retry, and a close button', async () => {
    const { close } = setup({ extra: { 'GET /api/v1/locations': () => problem(500, 'unknown') } });
    await see('Une erreur inattendue');
    expect(button('Réessayer')).toBeTruthy();
    fireEvent.click(button('Fermer'));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('untracked variant: says where to turn tracking on, no form', async () => {
    setup({ item: null });
    await see("n'est pas suivie par Serialis");
    expect(document.querySelector('s-text-area')).toBeNull();
  });
});

describe('VariantAction — refs already registered', () => {
  it('lists the refs at the selected location with state and date, count in the heading', async () => {
    const { m } = setup();
    await see('Déjà enregistrées à Entrepôt (3)');
    await see('AB-003');
    expect(text()).toContain('Disponible');
    expect(text()).toContain('2026-03-01');
    const q = listCalls(m)[0]!.query;
    expect(q.get('variant')).toBe(VARIANT);
    expect(q.get('location')).toBe('loc-a');
    expect(document.querySelector('s-search-field')).toBeNull(); // 20 refs or fewer: no filter
    // collapsible
    fireEvent.click(button('Masquer'));
    await waitFor(() => expect(text()).not.toContain('AB-003'));
    fireEvent.click(button('Afficher'));
    await see('AB-003');
  });

  it('no ref yet: one line, no list request', async () => {
    const { m } = setup({ extra: { 'GET /api/v1/units': () => page([]) } });
    await ready();
    await see("Aucune ref enregistrée pour l'instant.");
    expect(listCalls(m)).toHaveLength(0);
  });

  it('pages of 20 with « Afficher plus » (cursor), and a filter beyond 20 refs', async () => {
    const all = Array.from({ length: 25 }, (_, i) => makeUnit(`AB-${String(i + 1).padStart(3, '0')}`));
    const { m } = setup({
      extra: {
        'GET /api/v1/units': (c) => {
          if (c.query.get('limit') !== '20') return page(all);
          if (c.query.get('q')) return page(all.filter((u) => u.ref.startsWith(c.query.get('q')!)));
          return c.query.get('cursor') === 'c1' ? page(all.slice(20)) : { items: all.slice(0, 20), nextCursor: 'c1' };
        },
      },
    });
    await see('Déjà enregistrées à Entrepôt (25)');
    await see('AB-020');
    expect(text()).not.toContain('AB-021');
    fireEvent.click(button('Afficher plus'));
    await see('AB-025');
    expect(listCalls(m).at(-1)!.query.get('cursor')).toBe('c1');
    expect(screen.queryByText('Afficher plus', { selector: 's-button' })).toBeNull();
    // filter (prefix, sent to the server as q)
    typeInto(document.querySelector('s-search-field')!, 'ab-02');
    await waitFor(() => expect(listCalls(m).at(-1)!.query.get('q')).toBe('AB-02'));
    await waitFor(() => expect(text()).not.toContain('AB-019'));
    expect(text()).toContain('AB-024');
  });

  it('states the count at other locations in one line, and can show all locations', async () => {
    const units = [makeUnit('AB-001'), makeUnit('AB-002'), makeUnit('BB-001', { locationId: 'loc-b', state: 'SHIPPED' }), makeUnit('BB-002', { locationId: 'loc-b' })];
    const { m } = setup({
      locations: LOCATIONS,
      extra: {
        'GET /api/v1/units': (c) => {
          const loc = c.query.get('location');
          return page(loc ? units.filter((u) => u.locationId === loc) : units);
        },
      },
    });
    await see('Déjà enregistrées à Entrepôt (2)');
    expect(text()).toContain("+ 2 à d'autres emplacements");
    expect(text()).not.toContain('BB-001');
    fireEvent.click(button('Voir tous les emplacements'));
    await see('Déjà enregistrées, tous emplacements (4)');
    await see('BB-001');
    expect(text()).toContain('Expédiée');
    expect(text()).toContain('Boutique');
    expect(listCalls(m).at(-1)!.query.get('location')).toBeNull();
    fireEvent.click(button('Seulement Entrepôt'));
    await see('Déjà enregistrées à Entrepôt (2)');
  });

  it('flags a typed ref already registered for the shop (server check), with its location and state, and leaves it out of the count', async () => {
    const { m } = setup({
      locations: LOCATIONS,
      extra: {
        'POST /api/v1/units/batch/check': (c) => checkAll(c.body as CreateUnitsBatchRequest, ['X-9']),
        'GET /api/v1/lookup': () => ({ unit: makeUnit('X-9', { variantGid: 'gid://shopify/ProductVariant/2002', locationId: 'loc-b', state: 'HELD' }) }),
      },
    });
    await ready();
    typeInto(area(), 'NEW-1\nX-9\nAB-001');
    // the variant's own ref is flagged at once, from the loaded list
    await see('Déjà enregistrée — Entrepôt · Disponible');
    await see('Déjà enregistrée — autre variante · Boutique · Réservée');
    expect(disabled(button('Ajouter 1 ref'))).toBe(false);
    // one check for the refs the client could not rule out, nothing written
    const checks = m.callsTo('POST /api/v1/units/batch/check');
    expect(checks).toHaveLength(1);
    expect((checks[0]!.body as CreateUnitsBatchRequest).refs).toEqual(['NEW-1', 'X-9']);
    expect(m.callsTo('GET /api/v1/lookup')[0]!.query.get('identifier')).toBe('X-9');
    // a ref already checked is not sent again
    typeInto(area(), 'NEW-1\nX-9\nAB-001\nNEW-2');
    await waitFor(() => expect(m.callsTo('POST /api/v1/units/batch/check')).toHaveLength(2));
    expect((m.callsTo('POST /api/v1/units/batch/check')[1]!.body as CreateUnitsBatchRequest).refs).toEqual(['NEW-2']);
  });

  it('a failed check flags nothing: the batch stays the final guard', async () => {
    setup({ extra: { 'POST /api/v1/units/batch/check': () => problem(500, 'unknown') } });
    await ready();
    typeInto(area(), 'N1 N2');
    await new Promise((r) => setTimeout(r, 700));
    expect(disabled(button('Ajouter 2 refs'))).toBe(false);
  });

  it('after an add, the list is read again and shows the new refs first', async () => {
    const { m } = setup({
      extra: { 'POST /api/v1/units/batch': () => ({ created: [makeUnit('NEW-1', { id: 'unit-z1' }), makeUnit('NEW-2', { id: 'unit-z2' })], rejected: [] }) },
    });
    await see('AB-001');
    const before = listCalls(m).length;
    choose(kinds(), 'received');
    typeInto(area(), 'NEW-1 NEW-2');
    fireEvent.click(button('Ajouter 2 refs'));
    await see("Confirmer l'ajout");
    fireEvent.click(button("Confirmer l'ajout de 2 refs"));
    await see('2 refs ajoutées');
    await waitFor(() => expect(listCalls(m).length).toBeGreaterThan(before));
    await see('NEW-1 · nouvelle');
    const t2 = text();
    expect(t2.indexOf('NEW-1 · nouvelle')).toBeLessThan(t2.indexOf('NEW-2 · nouvelle'));
    expect(t2.indexOf('NEW-2 · nouvelle')).toBeLessThan(t2.indexOf('AB-001'));
  });

  it('is available in English', async () => {
    setup({ lang: 'en' });
    await see('Already registered at Entrepôt (3)');
    await see('AB-003');
    expect(text()).toContain('Available');
  });
});
