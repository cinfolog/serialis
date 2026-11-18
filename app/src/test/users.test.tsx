import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { MockClient, MOCK_USER_IDS } from '../api/mock';
import { pageHeading, press, renderApp, screen, text, waitFor, within } from './utils';

const usersSection = () => document.querySelector<HTMLElement>('s-section[heading="Utilisateurs"]')!;

describe('Réglages › Utilisateurs (15.8)', () => {
  it('lists the users with owner and admin badges, first visit and who designated them', async () => {
    renderApp('/settings');
    await pageHeading('Réglages');
    await waitFor(() => expect(screen.getByTestId('users-list')).toBeInTheDocument());
    const owner = screen.getByTestId(`user-${MOCK_USER_IDS.owner}`);
    expect(text(owner)).toContain('Camille');
    expect(text(owner)).toContain('Vous');
    expect(text(owner)).toContain('Propriétaire');
    expect(text(owner)).toContain('Administrateur');
    expect(text(owner)).toMatch(/Première visite le \d/);
    const admin = screen.getByTestId(`user-${MOCK_USER_IDS.admin}`);
    expect(text(admin)).toContain('Désigné administrateur par Camille');
    expect(text(admin)).not.toContain('Propriétaire');
    // Without first name: the Shopify user id, never an e-mail.
    expect(text(screen.getByTestId(`user-${MOCK_USER_IDS.operator}`))).toContain(`Utilisateur Shopify n° ${MOCK_USER_IDS.operator}`);
    expect(text(screen.getByTestId(`user-${MOCK_USER_IDS.operator}`))).toContain('Opérateur');
    // The owner can never be withdrawn: no button on its line.
    expect(within(owner).queryByTestId(`user-revoke-${MOCK_USER_IDS.owner}`)).toBeNull();
    expect(screen.queryByTestId('users-owner-only')).toBeNull();
    expect(screen.queryByTestId('users-empty')).toBeNull();
  });

  it('the owner designates an administrator after a confirmation that names the effect, then withdraws it', async () => {
    const { mock } = renderApp('/settings');
    await waitFor(() => expect(screen.getByTestId(`user-grant-${MOCK_USER_IDS.operator2}`)).toBeInTheDocument());
    const grant = screen.getByTestId(`user-grant-${MOCK_USER_IDS.operator2}`);
    expect(grant.getAttribute('accessibilityLabel')).toBe('Nommer administrateur : Inès');
    press(grant);
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    const dialog = document.querySelector('s-modal')!;
    expect(dialog.getAttribute('heading')).toBe('Nommer Inès administrateur ?');
    expect(within(dialog as HTMLElement).getByText(/écrivent dans le stock Shopify/)).toBeInTheDocument();
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(text(screen.getByTestId(`user-${MOCK_USER_IDS.operator2}`))).toContain('Désigné administrateur par Camille'));
    expect(screen.getByTestId('live-region').textContent).toContain('Inès est maintenant administrateur.');
    expect(mock.appUsers.find((u) => u.userId === MOCK_USER_IDS.operator2)).toMatchObject({ role: 'admin', designatedBy: MOCK_USER_IDS.owner });

    press(screen.getByTestId(`user-revoke-${MOCK_USER_IDS.operator2}`));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    expect(document.querySelector('s-modal')!.getAttribute('heading')).toBe('Retirer le droit d’administration de Inès ?');
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId(`user-grant-${MOCK_USER_IDS.operator2}`)).toBeInTheDocument());
    expect(mock.appUsers.find((u) => u.userId === MOCK_USER_IDS.operator2)).toMatchObject({ role: 'operator', designatedBy: null });
  });

  it('cancelling the dialog changes nothing', async () => {
    const { mock } = renderApp('/settings');
    await waitFor(() => expect(screen.getByTestId(`user-grant-${MOCK_USER_IDS.operator}`)).toBeInTheDocument());
    press(screen.getByTestId(`user-grant-${MOCK_USER_IDS.operator}`));
    await waitFor(() => expect(screen.getByTestId('dialog-cancel')).toBeInTheDocument());
    press(screen.getByTestId('dialog-cancel'));
    await waitFor(() => expect(document.querySelector('s-modal')).toBeNull());
    expect(mock.appUsers.find((u) => u.userId === MOCK_USER_IDS.operator)?.role).toBe('operator');
  });

  it('a designated administrator sees the list read-only (only the owner designates)', async () => {
    renderApp('/settings', { owner: false });
    await waitFor(() => expect(screen.getByTestId('users-list')).toBeInTheDocument());
    expect(text(screen.getByTestId('users-owner-only'))).toContain('Seul le propriétaire');
    expect(text(screen.getByTestId(`user-${MOCK_USER_IDS.admin}`))).toContain('Vous');
    expect(usersSection().querySelector('[data-testid^="user-grant-"], [data-testid^="user-revoke-"]')).toBeNull();
  });

  it('an operator gets the explanation and no call is made', async () => {
    const mock = new MockClient({ role: 'operator' });
    let calls = 0;
    mock.listAppUsers = async () => {
      calls += 1;
      throw new Error('must not be called');
    };
    renderApp('/settings', { mock });
    await waitFor(() => expect(screen.getByTestId('users-read-only')).toBeInTheDocument());
    expect(screen.queryByTestId('users-list')).toBeNull();
    expect(calls).toBe(0);
  });

  it('says when nobody else opened the app yet', async () => {
    renderApp('/settings', { empty: true });
    await waitFor(() => expect(screen.getByTestId('users-empty')).toBeInTheDocument());
    expect(screen.getByTestId('users-list').querySelectorAll('li')).toHaveLength(1);
  });

  it('shows the loading state, then an error with a retry that recovers', async () => {
    const mock = new MockClient();
    const original = mock.listAppUsers.bind(mock);
    let fail = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mock.listAppUsers = async () => {
      await gate;
      if (fail) throw new ApiError({ status: 0, code: 'network' });
      return original();
    };
    renderApp('/settings', { mock });
    await waitFor(() => expect(within(usersSection()).getByTestId('loading')).toBeInTheDocument());
    release();
    await waitFor(() => expect(within(usersSection()).getByTestId('error-state')).toBeInTheDocument());
    fail = false;
    press(within(usersSection()).getByTestId('error-state').querySelector<HTMLElement>('s-button')!);
    await waitFor(() => expect(screen.getByTestId('users-list')).toBeInTheDocument());
  });

  it('explains a refusal of the server (403 owner_required) and refreshes the list', async () => {
    const mock = new MockClient();
    mock.patchAppUser = async () => {
      throw new ApiError({ status: 403, code: 'forbidden', detail: 'owner_required' });
    };
    renderApp('/settings', { mock });
    await waitFor(() => expect(screen.getByTestId(`user-grant-${MOCK_USER_IDS.operator}`)).toBeInTheDocument());
    press(screen.getByTestId(`user-grant-${MOCK_USER_IDS.operator}`));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('users-error')).toBeInTheDocument());
    expect(text(screen.getByTestId('users-error'))).toContain('Seul le propriétaire');
  });

  it('is translated in English', async () => {
    renderApp('/settings', { locale: 'en' });
    await pageHeading('Settings');
    await waitFor(() => expect(screen.getByTestId('users-list')).toBeInTheDocument());
    expect(document.querySelector('s-section[heading="Users"]')).not.toBeNull();
    const owner = text(screen.getByTestId(`user-${MOCK_USER_IDS.owner}`));
    expect(owner).toContain('Owner');
    expect(owner).toContain('You');
    expect(text(screen.getByTestId(`user-grant-${MOCK_USER_IDS.operator}`))).toBe('Make administrator');
    expect(text(screen.getByTestId(`user-${MOCK_USER_IDS.operator}`))).toContain(`Shopify user no. ${MOCK_USER_IDS.operator}`);
  });
});
