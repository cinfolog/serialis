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
    await see('2 prête(s), 1 doublon(s) dans la liste, 1 déjà connue(s), 1 au format invalide');
    expect(text()).toContain('Doublon dans la liste');
    expect(text()).toContain('Déjà connue');
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
