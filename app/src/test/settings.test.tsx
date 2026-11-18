import { describe, expect, it } from 'vitest';
import { actOnFirstAppearance, choose, navLink, field, pageHeading, press, renderApp, screen, text, typeIn, waitFor, within } from './utils';

async function openSettings(options: Parameters<typeof renderApp>[1] = {}) {
  const rendered = renderApp('/settings', { extensionsShown: true, ...options });
  await pageHeading('Réglages');
  await waitFor(() => expect(screen.getByTestId('setting-S-05')).toBeInTheDocument());
  return rendered;
}

describe('Réglages (MVP)', () => {
  it('shows the MVP settings with their default marked, and S-01 / S-24 as fixed read-only values', async () => {
    await openSettings();
    for (const key of ['S-05', 'S-08', 'S-09', 'S-11', 'S-17', 'S-22', 'S-25', 'S-35', 'S-36.strip_spaces', 'S-36.normalize_upper', 'S-37', 'S-38', 'S-40']) {
      expect(screen.getByTestId(`setting-${key}`)).toBeInTheDocument();
    }
    const s05 = screen.getByTestId('input-S-05');
    expect(s05.getAttribute('label')).toBe('Quelle unité proposer en premier ?');
    expect([...s05.querySelectorAll('s-option')].map((o) => o.textContent)).toEqual(['Premier entré, premier sorti (par défaut)', 'Première échéance', 'Manuelle']);
    expect(s05.getAttribute('details')).toContain('en stock depuis le plus longtemps');

    // S-01 and S-24: shown, fixed, no input.
    for (const key of ['S-01', 'S-24']) {
      expect(screen.getByTestId(`fixed-${key}`).textContent).toContain('Fixe');
      expect(screen.queryByTestId(`input-${key}`)).toBeNull();
    }
    expect(screen.getByTestId('fixed-S-01').textContent).toContain('Ne pas bloquer, signaler seulement');
    expect(screen.getByTestId('fixed-S-24').textContent).toContain('Ne pas les bloquer');
    // Nothing changed yet: no save bar, "Mes choix" empty.
    expect(screen.queryByTestId('save-bar')).toBeNull();
    expect(screen.getByTestId('mine-empty')).toBeInTheDocument();
  });

  it('saves an immediate setting from the save bar, lists it in "Mes choix" and reverts to default', async () => {
    const { mock } = await openSettings();
    choose(screen.getByTestId('input-S-05'), 'manual');
    await waitFor(() => expect(screen.getByTestId('save-bar')).toBeInTheDocument());
    press(screen.getByTestId('save-bar-save'));
    await waitFor(() => expect(mock.settings['S-05']).toBe('manual'));
    await waitFor(() => expect(screen.queryByTestId('save-bar')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('mine-list').textContent).toContain('Manuelle'));
    expect(screen.getByTestId('live-region').textContent).toContain('Réglages enregistrés.');

    press(screen.getByTestId('revert-S-05'));
    await waitFor(() => expect(screen.getByTestId('save-bar')).toBeInTheDocument());
    press(screen.getByTestId('save-bar-save'));
    await waitFor(() => expect(mock.settings['S-05']).toBe('fifo'));
    await waitFor(() => expect(screen.getByTestId('mine-empty')).toBeInTheDocument());
  });

  it('keeps a change made right after the settings appear (decision 29)', async () => {
    // The change lands in the same task as the commit that shows the loaded values, before that
    // commit's effects run: it must not be overwritten when the effects flush.
    actOnFirstAppearance('input-S-05', (el) => choose(el, 'manual'));
    const { mock } = renderApp('/settings', { extensionsShown: true });
    await waitFor(() => expect(screen.getByTestId('save-bar')).toBeInTheDocument());
    press(screen.getByTestId('save-bar-save'));
    await waitFor(() => expect(mock.settings['S-05']).toBe('manual'));
  });

  it('keeps a change made while a save is in flight (decision 29)', async () => {
    const { mock } = await openSettings();
    choose(screen.getByTestId('input-S-05'), 'manual');
    await waitFor(() => expect(screen.getByTestId('save-bar')).toBeInTheDocument());
    press(screen.getByTestId('save-bar-save'));
    choose(screen.getByTestId('input-S-08'), 'first'); // before PATCH answers
    await waitFor(() => expect(mock.settings['S-05']).toBe('manual'));
    await waitFor(() => expect(screen.getByTestId('mine-list').textContent).toContain('Manuelle'));
    expect(screen.getByTestId('save-bar')).toBeInTheDocument();
    press(screen.getByTestId('save-bar-save'));
    await waitFor(() => expect(mock.settings['S-08']).toBe('first'));
    await waitFor(() => expect(screen.queryByTestId('save-bar')).toBeNull());
  });

  it('discards unsaved changes', async () => {
    const { mock } = await openSettings();
    choose(screen.getByTestId('input-S-08'), 'first');
    await waitFor(() => expect(screen.getByTestId('save-bar')).toBeInTheDocument());
    press(screen.getByTestId('save-bar-discard'));
    await waitFor(() => expect(screen.queryByTestId('save-bar')).toBeNull());
    expect(mock.settings['S-08']).toBe('last');
  });

  it('a "simulation" setting shows what will change and the weakened guarantee before saving', async () => {
    const { mock } = await openSettings();
    choose(screen.getByTestId('input-S-17'), 'no');
    await waitFor(() => expect(screen.getByTestId('warn-S-17')).toBeInTheDocument());
    expect(screen.getByTestId('warn-S-17').textContent).toContain('Une unité mal désignée au retour n’est plus détectable');
    press(screen.getByTestId('save-bar-save'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    expect(screen.getByTestId('simulation-effects').textContent).toContain('1 retour en attente d’identification sera traité sans saisie de ref.');
    expect(screen.getByTestId('simulation-warnings').textContent).toContain('S-17 = non');
    expect(mock.settings['S-17']).toBe(true); // not saved before confirmation
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.settings['S-17']).toBe(false));
  });

  it('warns before saving an immediate value that weakens a guarantee (S-25 on decision)', async () => {
    const { mock } = await openSettings();
    choose(screen.getByTestId('input-S-25'), 'on_decision');
    press(screen.getByTestId('save-bar-save'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    expect(screen.getByTestId('simulation-warnings').textContent).toContain('sans anomalie tant que la phase n’est pas close');
    expect(mock.settings['S-25']).toBe('automatic');
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.settings['S-25']).toBe('on_decision'));
  });

  it('validates the grace period (5 to 1440 minutes) and warns beyond 10 minutes', async () => {
    const { mock } = await openSettings();
    const input = screen.getByTestId('input-S-22');
    typeIn(input, '3');
    await waitFor(() => expect(input.getAttribute('error')).toBe('Saisissez un nombre de minutes entre 5 et 1440.'));
    await waitFor(() => expect(screen.getByTestId('save-bar-save')).toHaveAttribute('disabled'));
    typeIn(input, '30');
    await waitFor(() => expect(input.getAttribute('error')).toBeNull());
    expect(screen.getByTestId('warn-S-22').textContent).toContain('Au-delà de 10 minutes');
    press(screen.getByTestId('save-bar-save'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.settings['S-22']).toBe(30));
  });

  it('shows the regular expression field only for the "regex" validation and rejects an invalid pattern', async () => {
    await openSettings();
    expect(screen.queryByTestId('input-S-37.pattern')).toBeNull();
    choose(screen.getByTestId('input-S-37'), 'regex');
    await waitFor(() => expect(screen.getByTestId('input-S-37.pattern')).toBeInTheDocument());
    typeIn(screen.getByTestId('input-S-37.pattern'), '^SN-(');
    await waitFor(() => expect(screen.getByTestId('input-S-37.pattern').getAttribute('error')).toBe('Cette expression régulière n’est pas valide.'));
    expect(screen.getByTestId('save-bar-save')).toHaveAttribute('disabled');
  });

  it('operators see the settings read-only (15.8)', async () => {
    await openSettings({ role: 'operator' });
    expect(screen.getByTestId('settings-read-only')).toBeInTheDocument();
    expect(screen.getByTestId('input-S-05')).toHaveAttribute('disabled');
    expect(screen.queryByTestId('emergency-toggle')).toBeNull();
  });

  it('renders in English', async () => {
    renderApp('/settings', { locale: 'en', extensionsShown: true });
    await pageHeading('Settings');
    await waitFor(() => expect(screen.getByTestId('input-S-05')).toBeInTheDocument());
    expect(screen.getByTestId('input-S-05').getAttribute('label')).toBe('Which unit should be offered first?');
    expect(screen.getByTestId('fixed-S-01').textContent).toContain('Fixed');
  });
});

describe('Arrêt d’urgence', () => {
  it('names the effect before activating, shows the banner on every screen and resumes from it', async () => {
    const { mock } = await openSettings();
    expect(screen.queryByTestId('banner-emergency')).toBeNull();
    press(screen.getByTestId('emergency-toggle'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    const dialog = document.querySelector('s-modal') as HTMLElement;
    expect(dialog.getAttribute('heading')).toBe('Activer l’arrêt d’urgence ?');
    expect(dialog.textContent).toContain('L’attribution automatique des unités est suspendue pour toutes les nouvelles commandes suivies');
    expect(mock.emergencyStop).toBe(false);
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.emergencyStop).toBe(true));
    await waitFor(() => expect(screen.getByTestId('banner-emergency')).toBeInTheDocument());
    expect(screen.getByTestId('banner-emergency')).toHaveAttribute('heading', 'Arrêt d’urgence actif');

    // The banner stays on other screens and carries the action that lifts it.
    press(navLink('Anomalies'));
    await pageHeading('Anomalies');
    expect(screen.getByTestId('banner-emergency')).toBeInTheDocument();
    press(screen.getByTestId('resume-open'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    expect(document.querySelector('s-modal')?.textContent).toContain('L’attribution automatique reprend pour les nouvelles commandes suivies');
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.emergencyStop).toBe(false));
    await waitFor(() => expect(screen.queryByTestId('banner-emergency')).toBeNull());
  });

  it('a refused action (not admin) is explained', async () => {
    const { mock } = await openSettings();
    mock.options.role = 'operator'; // the server now refuses, although the UI still thinks the user is an admin
    press(screen.getByTestId('emergency-toggle'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('emergency-error')).toBeInTheDocument());
    expect(text(screen.getByTestId('emergency-error'))).toContain('réservée aux administrateurs');
    expect(within(document.body).queryByTestId('banner-emergency')).toBeNull();
  });
});
