import { EXTENSION_KEYS } from '@serialis/contract';
import { describe, expect, it } from 'vitest';
import { MockClient } from '../api/mock';
import { button, field, findButton, findField, pageHeading, press, renderApp, screen, setChecked, text, typeIn, waitFor, within } from './utils';

describe('Assistant de démarrage', () => {
  it('walks a new shop through products, refs, gap and blocks, then closes the start card (T-UX-08)', async () => {
    const { mock } = renderApp('/start', { empty: true });
    await pageHeading('Assistant de démarrage');

    // 1. Products: pick in Shopify, then turn tracking on (no stock write, open orders not blocked).
    const steps = await screen.findByTestId('wizard-steps');
    expect(within(steps).getByText(/Choisir les produits/).closest('li')).toHaveAttribute('aria-current', 'step');
    expect(document.body.textContent).toContain('Aucune écriture de stock n’a lieu à cette étape');
    expect(document.body.textContent).toContain('Les commandes déjà ouvertes ne sont pas bloquées');
    press(button('Choisir les produits dans Shopify'));
    await waitFor(() => expect(screen.getByTestId('wizard-picked').children).toHaveLength(2));
    press(button('Activer le suivi'));
    await waitFor(() => expect(mock.trackedItems).toHaveLength(2));
    expect(screen.getByTestId('live-region').textContent).toContain('2 articles suivis.');

    // 2. Refs: existing stock is pasted as "already counted" (no write).
    await findField('Refs à ajouter');
    expect(field('Ces unités sont…').getAttribute('value')).toBe('counted');
    const te80 = mock.trackedItems[0]!;
    typeIn(field('Article suivi'), te80.variantGid); // no change event: the select keeps its default (first initializing item)
    typeIn(field('Refs à ajouter'), 'SN-TE80-10001, SN-TE80-10002; SN-TE80-10003');
    press(button('Contrôler les refs'));
    await waitFor(() => expect(screen.getByTestId('refs-summary')).toBeInTheDocument());
    expect(text(screen.getByTestId('refs-effect'))).toContain('aucune écriture dans Shopify');
    press(button('Valider 3 refs'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('refs-result')).toBeInTheDocument());
    expect(mock.trackedItems[0]?.stock[0]?.shopifyOnHand).toBe(5); // untouched: no stock write
    expect(mock.trackedItems[0]?.stock[0]?.registeredUnits).toBe(3);
    press(screen.getByTestId('wizard-next'));

    // 3. Gap: 2 units still to register on the first item, 5 on the second; must be acknowledged.
    await screen.findByTestId('wizard-gap-table');
    expect(screen.getByTestId('wizard-gap-table').textContent).toContain('2 unités à enregistrer');
    expect(screen.getByTestId('wizard-gap-table').textContent).toContain('5 unités à enregistrer');
    press(screen.getByTestId('wizard-next')); // blocked until understood
    expect(screen.queryByTestId('wizard-blocks')).toBeNull();
    setChecked(screen.getByTestId('wizard-gap-understood'), true);
    await waitFor(() => expect(screen.getByTestId('wizard-next')).not.toHaveAttribute('disabled'));
    press(screen.getByTestId('wizard-next'));

    // 4. Blocks: the card stays open until every extension has been displayed once.
    await screen.findByTestId('wizard-blocks');
    expect(screen.getByTestId('wizard-blocks-pending')).toBeInTheDocument();
    expect(screen.getByTestId('ext-variant_block').textContent).toContain('pas encore affiché');
    for (const key of EXTENSION_KEYS) mock.markExtensionShown(key);
    press(screen.getByTestId('wizard-verify'));
    await waitFor(() => expect(screen.getByTestId('wizard-blocks-ok')).toBeInTheDocument());
    expect(screen.getByTestId('ext-variant_block').textContent).toContain('affiché');
    press(screen.getByTestId('wizard-finish'));

    // Home: the start card has closed by itself.
    await pageHeading('Accueil');
    await waitFor(() => expect(screen.getByTestId('kpi-under60')).toBeInTheDocument());
    expect(screen.queryByTestId('start-step')).toBeNull();
  });

  it('keeps the start card open while an extension has never been displayed', async () => {
    const mock = new MockClient();
    mock.markExtensionShown('variant_block');
    mock.markExtensionShown('product_block');
    mock.markExtensionShown('order_block');
    renderApp('/', { mock });
    await waitFor(() => expect(screen.getByTestId('start-extensions')).toBeInTheDocument());
    expect(screen.getByTestId('start-extensions').textContent).toContain('Action « Modifier les unités » (commande) : pas encore affiché');
    expect(screen.getByTestId('start-step').textContent).toContain('Étape 4 sur 4 : Activer les blocs');
  });

  it('an operator cannot turn tracking on (admin right, 15.8)', async () => {
    renderApp('/start', { empty: true, role: 'operator' });
    await pageHeading('Assistant de démarrage');
    await findButton('Choisir les produits dans Shopify');
    expect(button('Choisir les produits dans Shopify')).toHaveAttribute('disabled');
    expect(document.body.textContent).toContain('Réservé aux administrateurs');
  });
});

describe('Articles suivis', () => {
  it('lists tracked items with the Shopify gap and activates new ones after a confirmation', async () => {
    const { mock } = renderApp('/tracked-items');
    await waitFor(() => expect(screen.getByTestId('tracked-table')).toBeInTheDocument());
    expect(screen.getByTestId('tracked-table').textContent).toContain('Entrepôt Bordeaux : 6 dans Shopify, 4 enregistrées');
    press(button('Suivre des articles'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    expect(document.querySelector('[data-testid="dialog-root"]')?.textContent).toContain('Aucune écriture de stock n’a lieu à l’activation');
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.trackedItems).toHaveLength(5));
  });
});
