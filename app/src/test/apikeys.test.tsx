import { describe, expect, it } from 'vitest';
import { MockClient } from '../api/mock';
import { pageHeading, press, renderApp, screen, setChecked, text, typeIn, waitFor, within } from './utils';

async function openApiKeys(options: Parameters<typeof renderApp>[1] = {}) {
  const rendered = renderApp('/settings', { extensionsShown: true, ...options });
  await pageHeading(options.locale === 'en' ? 'Settings' : 'Réglages');
  return rendered;
}

describe('Réglages › Clés d’API (15.4, 14.1)', () => {
  it('creates a key with its scopes, shows the full key once, then lists only its start', async () => {
    const { mock } = await openApiKeys();
    await waitFor(() => expect(screen.getByTestId('api-keys-empty')).toBeInTheDocument());

    typeIn(screen.getByTestId('api-key-name'), 'ERP');
    setChecked(screen.getByTestId('api-key-scope-units:write'), false);
    setChecked(screen.getByTestId('api-key-scope-allocations:read'), true);
    press(screen.getByTestId('api-key-create'));

    await waitFor(() => expect(screen.getByTestId('api-key-created')).toBeInTheDocument());
    expect(mock.apiKeys).toHaveLength(1);
    expect(mock.apiKeys[0]).toMatchObject({ name: 'ERP', scopes: ['units:read', 'allocations:read'] });
    const fullKey = screen.getByTestId('api-key-secret').getAttribute('value') ?? '';
    expect(fullKey).toMatch(/^srl_1_global_mock-shop\.myshopify\.com_\w{16}_[0-9a-f]{32}\.\S{43}$/);
    expect(screen.getByTestId('live-region').textContent).toContain('Copiez-la maintenant');

    await waitFor(() => expect(screen.getByTestId('api-keys-list')).toBeInTheDocument());
    const row = screen.getByTestId(`api-key-${mock.apiKeys[0]!.prefix}`);
    expect(text(row)).toContain('ERP');
    expect(text(row)).toContain(`${mock.apiKeys[0]!.hint}`);
    expect(text(row)).toContain('Jamais utilisée');
    expect(text(row)).toContain('allocations:read');

    // Once acknowledged, the full key is gone from the page for good.
    press(screen.getByTestId('api-key-done'));
    await waitFor(() => expect(screen.queryByTestId('api-key-created')).toBeNull());
    expect(document.body.innerHTML).not.toContain(fullKey);
    expect(screen.queryByTestId('api-key-secret')).toBeNull();
  });

  it('asks for a name and at least one scope before creating anything', async () => {
    const { mock } = await openApiKeys();
    await waitFor(() => expect(screen.getByTestId('api-keys-empty')).toBeInTheDocument());
    press(screen.getByTestId('api-key-create'));
    await waitFor(() => expect(screen.getByTestId('api-key-name').getAttribute('error')).toBe('Donnez un nom à la clé (100 caractères au plus).'));
    typeIn(screen.getByTestId('api-key-name'), 'n8n');
    setChecked(screen.getByTestId('api-key-scope-units:read'), false);
    setChecked(screen.getByTestId('api-key-scope-units:write'), false);
    press(screen.getByTestId('api-key-create'));
    await waitFor(() => expect(screen.getByTestId('api-keys-error').textContent).toContain('Cochez au moins une portée.'));
    expect(mock.apiKeys).toHaveLength(0);
  });

  it('revokes a key after a confirmation that names the effect', async () => {
    const existing = new MockClient({ extensionsShown: true });
    await existing.createApiKey({ name: 'Make', scopes: ['units:read'] });
    const { mock } = await openApiKeys({ mock: existing });
    const prefix = mock.apiKeys[0]!.prefix;
    await waitFor(() => expect(screen.getByTestId(`api-key-${prefix}`)).toBeInTheDocument());
    // The list reloaded on mount shows the key; revoke it.
    press(screen.getByTestId(`api-key-revoke-${prefix}`));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    const dialog = document.querySelector('[data-testid="dialog-root"]')!;
    expect(document.querySelector('[data-testid="dialog-heading"]')!.textContent).toBe('Révoquer la clé « Make » ?');
    expect(within(dialog as HTMLElement).getByText(/refusé immédiatement/)).toBeInTheDocument();
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.apiKeys[0]!.revokedAt).not.toBeNull());
    await waitFor(() => expect(text(screen.getByTestId(`api-key-${prefix}`))).toContain('Révoquée le'));
    expect(screen.queryByTestId(`api-key-revoke-${prefix}`)).toBeNull();
  });

  it('is read-only for operators (15.8): no form, no list', async () => {
    const { mock } = await openApiKeys({ role: 'operator' });
    await waitFor(() => expect(screen.getByTestId('setting-S-05')).toBeInTheDocument());
    expect(document.querySelector('s-section[heading="Clés d’API"]')).not.toBeNull();
    expect(mock.postLog).toHaveLength(0);
    expect(screen.queryByTestId('api-key-create')).toBeNull();
    expect(screen.queryByTestId('api-keys-list')).toBeNull();
  });

  it('is translated in English', async () => {
    await openApiKeys({ locale: 'en' });
    await waitFor(() => expect(screen.getByTestId('api-keys-empty').textContent).toBe('No API key yet.'));
    expect(text(screen.getByTestId('api-key-create'))).toBe('Create key');
  });
});
