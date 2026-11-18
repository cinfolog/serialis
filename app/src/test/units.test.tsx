import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { MockClient } from '../api/mock';
import { actOnFirstAppearance, button, choose, field, findField, pageHeading, press, renderApp, screen, typeIn, waitFor, text, flush } from './utils';

describe('Unités : liste', () => {
  it('lists units with state badges and location names, and filters from the URL', async () => {
    renderApp('/units?state=DAMAGED');
    await pageHeading('Unités');
    await waitFor(() => expect(screen.getByTestId('units-table')).toBeInTheDocument());
    const rows = [...document.querySelectorAll('s-table-row')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Endommagée');
    expect(rows[0]?.textContent).toContain('Entrepôt Bordeaux');
    expect(rows[0]?.textContent).toContain('Vélo urbain UR500 — M');
  });

  it('opens the unit sheet directly when a full ref is searched', async () => {
    renderApp('/units');
    await waitFor(() => expect(screen.getByTestId('units-table')).toBeInTheDocument());
    typeIn(field('Rechercher une ref'), 'sn-ur500-m-51203');
    press(button('Rechercher'));
    await pageHeading('Unité SN-UR500-M-51203');
    await waitFor(() => expect(screen.getByTestId('unit-events')).toBeInTheDocument());
  });

  it('keeps a ref typed right after the search field appears (decision 29)', async () => {
    actOnFirstAppearance('units-q', (el) => typeIn(el, 'sn-ur500-m-51203'));
    renderApp('/units');
    await pageHeading('Unités');
    press(screen.getByTestId('units-search'));
    await pageHeading('Unité SN-UR500-M-51203');
  });

  it('shows an empty state with a useful message when nothing matches', async () => {
    renderApp('/units?q=ZZZ');
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeInTheDocument());
    expect(screen.getByTestId('empty-state').textContent).toContain('Aucune unité ne correspond');
  });

  it('shows an error state with a retry when the API fails', async () => {
    const mock = new MockClient();
    vi.spyOn(mock, 'listUnits').mockRejectedValueOnce(new ApiError({ status: 0, code: 'network' }));
    renderApp('/units', { mock });
    await waitFor(() => expect(screen.getByTestId('error-state')).toBeInTheDocument());
    expect(screen.getByTestId('error-state').textContent).toContain('injoignable');
    press(button('Réessayer'));
    await waitFor(() => expect(screen.getByTestId('units-table')).toBeInTheDocument());
  });
});

function fiftyRefs(): string {
  const refs = Array.from({ length: 47 }, (_, i) => `SN-UR500-M-${90000 + i}`);
  refs.splice(10, 0, 'SN-UR500-M-90003'); // duplicate in the list
  refs.splice(20, 0, 'SN-UR500-M-51203'); // already known
  refs.splice(30, 0, 'XX'); // invalid format
  return refs.join('\n');
}

describe('Ajout de refs par collage (T-UX-02)', () => {
  async function openPanel() {
    const rendered = renderApp('/units?add=1');
    await findField('Refs à ajouter');
    return rendered;
  }

  it('checks 50 pasted refs line by line, announces the stock effect and validates the 47 valid ones', async () => {
    const { mock } = await openPanel();
    typeIn(field('Refs à ajouter'), fiftyRefs());
    press(button('Contrôler les refs'));
    await waitFor(() => expect(screen.getByTestId('refs-summary')).toBeInTheDocument());
    expect(text(screen.getByTestId('refs-summary'))).toBe('47 prêtes sur 50. Seules les lignes prêtes seront validées.');
    const table = screen.getByTestId('refs-check-table');
    expect(table.textContent).toContain('Doublon dans la liste');
    expect(table.textContent).toContain('Déjà connue');
    expect(table.textContent).toContain('Format invalide');
    expect(text(screen.getByTestId('refs-effect'))).toBe('Effet : Shopify passera de 8 à 55 en stock à Entrepôt Bordeaux.');

    const before = mock.units.length;
    press(button('Valider 47 refs'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    expect(document.querySelector('s-modal')?.textContent).toContain('Shopify passera de 8 à 55 en stock à Entrepôt Bordeaux (47 unités reçues).');
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('refs-result')).toBeInTheDocument());
    expect(text(screen.getByTestId('refs-result'))).toBe('47 unités créées.');
    expect(mock.units.length).toBe(before + 47);
    expect(mock.trackedItems[0]?.stock[0]?.shopifyOnHand).toBe(55);
    // The 47 are cleared from the box.
    expect((field('Refs à ajouter') as unknown as { value: string }).value).toBe('');
  });

  it('"already counted" announces no stock write and is limited to the Shopify gap', async () => {
    const { mock } = await openPanel();
    // GR300-54 at Bordeaux: 6 in Shopify, 4 registered: gap of 2.
    choose(field('Article suivi'), mock.trackedItems[2]!.variantGid);
    choose(field('Ces unités sont…'), 'counted');
    await waitFor(() => expect(screen.getByTestId('refs-type')).toHaveAttribute('details', 'Écart restant à Entrepôt Bordeaux : 2.'));
    typeIn(field('Refs à ajouter'), 'SN-GR300-54-80001\nSN-GR300-54-80002\nSN-GR300-54-80003');
    press(button('Contrôler les refs'));
    await waitFor(() => expect(screen.getByTestId('refs-summary')).toBeInTheDocument());
    expect(text(screen.getByTestId('refs-summary'))).toContain('2 prêtes sur 3');
    expect(screen.getByTestId('refs-check-table').textContent).toContain('Au-delà de l’écart avec Shopify');
    expect(text(screen.getByTestId('refs-effect'))).toBe('Effet : aucune écriture dans Shopify, ces 2 unités sont déjà comptées à Entrepôt Bordeaux.');
  });

  it('a validation sent again after a network cut reuses the idempotency key and is not applied twice', async () => {
    const { mock } = await openPanel();
    typeIn(field('Refs à ajouter'), 'SN-UR500-M-91001\nSN-UR500-M-91002');
    press(button('Contrôler les refs'));
    await waitFor(() => expect(screen.getByTestId('refs-summary')).toBeInTheDocument());

    // The server applies the batch, but the response is lost.
    const real = mock.createUnitsBatch.bind(mock);
    let first = true;
    vi.spyOn(mock, 'createUnitsBatch').mockImplementation(async (req, opts) => {
      const response = await real(req, opts);
      if (first) {
        first = false;
        throw new ApiError({ status: 0, code: 'network' });
      }
      return response;
    });
    const before = mock.units.length;
    press(button('Valider 2 refs'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('refs-error')).toBeInTheDocument());
    expect(screen.getByTestId('refs-error').textContent).toContain('injoignable');

    press(button('Valider 2 refs'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('refs-result')).toBeInTheDocument());
    expect(mock.units.length).toBe(before + 2);
    const keys = mock.postLog.filter((p) => p.name === 'createUnitsBatch').map((p) => p.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    await flush();
  });
});
