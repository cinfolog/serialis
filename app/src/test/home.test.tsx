import { describe, expect, it } from 'vitest';
import { MockClient } from '../api/mock';
import { pageHeading, renderApp, screen, waitFor, text } from './utils';

describe('Accueil', () => {
  it('shows sync health, things to handle, key figures and the units table', async () => {
    renderApp('/', { extensionsShown: true });
    await pageHeading('Accueil');
    await waitFor(() => expect(screen.getByTestId('kpi-under60')).toBeInTheDocument());
    expect(text(screen.getByTestId('kpi-under60'))).toBe('99,1 %');
    expect(document.body.textContent).toContain('Tout va bien');
    expect(document.body.textContent).toContain('Dernier webhook reçu');
    expect(text(screen.getByTestId('todo-critical'))).toBe('1 anomalie critique');
    expect(text(screen.getByTestId('todo-returns'))).toBe('1 retour à identifier');
    const table = screen.getByTestId('units-by-state');
    expect(table.textContent).toContain('Entrepôt Bordeaux');
    expect(table.textContent).toContain('Boutique Lyon');
    expect(screen.getByTestId('sparkline')).toHaveAttribute('role', 'img');
    // Onboarding finished: no start card.
    expect(screen.queryByTestId('start-step')).toBeNull();
  });

  it('says that lines without a unit wait for the end of the emergency stop, not for a unit', async () => {
    const mock = new MockClient({ extensionsShown: true });
    mock.emergencyStop = true;
    renderApp('/', { mock });
    await waitFor(() => expect(screen.getByTestId('todo-lines')).toBeInTheDocument());
    expect(screen.getByTestId('todo-lines').parentElement?.textContent).toContain('Automatisation en pause (arrêt d’urgence)');
  });

  it('shows the start card while an extension has never been displayed (T-UX-08)', async () => {
    const mock = new MockClient();
    renderApp('/', { mock });
    await waitFor(() => expect(screen.getByTestId('start-step')).toBeInTheDocument());
    expect(screen.getByTestId('start-extensions').textContent).toContain('Bloc variante : pas encore affiché');
  });

  it('shows the empty state with the first-product action when nothing is tracked', async () => {
    renderApp('/', { empty: true });
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeInTheDocument());
    expect(screen.getByTestId('empty-state').textContent).toContain('Suivre les refs d’un premier produit');
  });

  it('renders in English when /me says so', async () => {
    renderApp('/', { locale: 'en', extensionsShown: true });
    await pageHeading('Home');
    await waitFor(() => expect(document.body.textContent).toContain('All good'));
  });
});
