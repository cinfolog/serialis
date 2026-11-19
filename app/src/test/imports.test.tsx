import { describe, expect, it } from 'vitest';
import { button, field, fireEvent, pageHeading, press, renderApp, screen, text, typeIn, waitFor } from './utils';

const CSV = [
  'ref,sku,location,already_counted',
  'SN-UR500-M-52001,UR500-M,Entrepôt Bordeaux,non',
  'SN-UR500-M-52002,UR500-M,Entrepôt Bordeaux,non',
  'SN-GR300-54-72001,GR300-54,Entrepôt Bordeaux,oui',
  'SN-GR300-54-72002,GR300-54,Entrepôt Bordeaux,oui',
  'SN-GR300-54-72003,GR300-54,Entrepôt Bordeaux,oui',
  'SN-UR500-M-51203,UR500-M,Entrepôt Bordeaux,non',
  ',UR500-M,Entrepôt Bordeaux,non',
  'SN-XX-0001,INCONNU,Entrepôt Bordeaux,non',
].join('\n');

describe('Import CSV : simulation puis confirmation', () => {
  it('simulates without writing, lists the error rows and the stock effect, then confirms', async () => {
    const { mock } = renderApp('/imports');
    await pageHeading('Imports');
    await waitFor(() => expect(screen.getByTestId('import-steps')).toBeInTheDocument());
    expect(screen.getByTestId('import-steps').querySelector('[aria-current="step"]')?.textContent).toContain('Fichier');

    typeIn(field('Contenu du fichier'), CSV);
    const before = mock.units.length;
    press(button('Simuler l’import'));
    await waitFor(() => expect(screen.getByTestId('import-report')).toBeInTheDocument());

    const report = screen.getByTestId('import-report').textContent ?? '';
    expect(report).toContain('Lignes lues : 8');
    expect(report).toContain('Lignes valides : 4');
    expect(report).toContain('Lignes en erreur : 4');
    expect(report).toContain('Lignes au-delà de l’écart avec Shopify : 1');
    expect(text(screen.getByTestId('import-effect'))).toBe('Effet prévu sur le stock : 2 écritures dans Shopify ; les 2 autres lignes valides sont déjà comptées (aucune écriture).');
    const errors = screen.getByTestId('import-errors').textContent ?? '';
    // Worker detail keys, shown as specific messages and never raw (recette 2).
    expect(errors).toContain('Aucun écart dans Shopify à cet emplacement : choisissez « Reçues maintenant » (stock Shopify +1 par ref).');
    expect(errors).toContain('Cette ref est déjà enregistrée.');
    expect(errors).toContain('Ref manquante sur cette ligne.');
    expect(errors).toContain('Variante inconnue ou non suivie');
    for (const raw of ['no_usable_deficit', 'already_known', 'empty_ref', 'unknown_or_untracked_variant', 'validation_failed', 'not_tracked', 'identifier_conflict']) expect(errors).not.toContain(raw);
    expect(mock.units.length).toBe(before); // nothing written by the simulation
    expect(screen.getByTestId('import-steps').querySelector('[aria-current="step"]')?.textContent).toContain('Simulation');

    press(screen.getByTestId('import-confirm'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    expect(document.querySelector('s-modal')?.textContent).toContain('4 unités seront créées. Shopify recevra 2 unités en stock');
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('import-done')).toBeInTheDocument());
    expect(text(screen.getByTestId('import-done'))).toBe('Import confirmé : 4 unités créées.');
    expect(mock.units.length).toBe(before + 4);
    expect(screen.getByTestId('import-steps').querySelector('[aria-current="step"]')?.textContent).toContain('Confirmation');
  });

  it('reads a chosen CSV file', async () => {
    renderApp('/imports');
    await waitFor(() => expect(screen.getByTestId('import-file')).toBeInTheDocument());
    const file = new File([CSV], 'stock.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [file] } });
    await waitFor(() => expect(field('Contenu du fichier').getAttribute('value')).toBe(CSV));
  });

  it('refuses a file with the wrong columns with an explicit message', async () => {
    renderApp('/imports');
    await waitFor(() => expect(screen.getByTestId('import-text')).toBeInTheDocument());
    typeIn(field('Contenu du fichier'), 'numero;article\nA1;B2');
    press(button('Simuler l’import'));
    await waitFor(() => expect(screen.getByTestId('import-error')).toBeInTheDocument());
    expect(screen.getByTestId('import-error').textContent).toContain('Colonnes attendues : ref, sku');
  });

  it('asks for content when nothing was chosen', async () => {
    renderApp('/imports');
    await waitFor(() => expect(screen.getByTestId('import-simulate')).toBeInTheDocument());
    press(button('Simuler l’import'));
    await waitFor(() => expect(screen.getByTestId('import-error')).toBeInTheDocument());
    expect(screen.getByTestId('import-error').textContent).toContain('Le fichier est vide');
  });
});
