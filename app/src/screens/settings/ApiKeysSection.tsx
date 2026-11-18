import { API_SCOPES, PUBLIC_BASE, PUBLIC_PATH_BASE, type ApiKey, type ApiScope, type CreateApiKeyResponse } from '@serialis/contract';
import { useState } from 'react';
import { isApiError } from '../../api/client';
import { useAnnounce, useClient, useSession } from '../../context';
import { useI18n, type MessageKey } from '../../i18n';
import { Badge, Banner, Button, Checkbox, ConfirmDialog, Section, Stack, TextField } from '../../ui/components';
import { useAsync } from '../../ui/hooks';
import { ErrorState, Loading, useErrorMessage } from '../../ui/states';

/** OpenAPI document of the public API: on the api host when the app runs on the app host, else under /public/v1 (14.1). */
function openApiUrl(): string {
  const host = globalThis.location?.hostname ?? '';
  return host.startsWith('app.') ? `https://api.${host.slice(4)}${PUBLIC_BASE}/openapi.json` : `${PUBLIC_PATH_BASE}/openapi.json`;
}

/**
 * Settings › API keys (15.4, 14.1): create a key with its scopes (the full key is shown ONCE),
 * list the keys (start of the key, scopes, created, last used) and revoke one. Administrators only
 * (15.8); key management is never possible through the API itself (O5).
 */
export function ApiKeysSection() {
  const { canAdmin } = useSession();
  const { t } = useI18n();
  return (
    <Section heading={t('apikeys.heading')}>
      <Stack>
        <s-paragraph>{t('apikeys.intro')}</s-paragraph>
        {canAdmin ? (
          <ApiKeysAdmin />
        ) : (
          <s-paragraph>{t('common.read_only_admin')}</s-paragraph>
        )}
      </Stack>
    </Section>
  );
}

function ApiKeysAdmin() {
  const { t, dateTime } = useI18n();
  const client = useClient();
  const announce = useAnnounce();
  const errorMessage = useErrorMessage();
  const keys = useAsync(() => client.listApiKeys(), [client]);

  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['units:read', 'units:write']);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreateApiKeyResponse | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  function toggle(scope: ApiScope, on: boolean) {
    setError(null);
    setScopes((s) => (on ? API_SCOPES.filter((x) => x === scope || s.includes(x)) : s.filter((x) => x !== scope)));
  }

  async function create() {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 100) {
      setNameError(t('apikeys.name_error'));
      return;
    }
    if (scopes.length === 0) {
      setError(t('apikeys.scopes_error'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await client.createApiKey({ name: trimmed, scopes });
      setCreated(response);
      setName('');
      keys.reload();
      announce(t('apikeys.created.announce'));
    } catch (e) {
      const field = isApiError(e) ? e.errors?.[0]?.field : undefined;
      if (field === 'name') setNameError(t('apikeys.name_error'));
      else if (field === 'scopes') setError(t('apikeys.scopes_error'));
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: ApiKey) {
    setBusy(true);
    setError(null);
    try {
      await client.revokeApiKey(key.prefix);
      setRevoking(null);
      keys.reload();
      announce(t('apikeys.revoked'), { toast: true });
    } catch (e) {
      setRevoking(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(key: string) {
    try {
      await globalThis.navigator?.clipboard?.writeText(key);
      announce(t('apikeys.created.copied'), { toast: true });
    } catch {
      // Clipboard refused (iframe permissions): the key stays selectable in the field.
    }
  }

  return (
    <Stack>
      <s-link href={openApiUrl()} target="_blank">
        {t('apikeys.docs')}
      </s-link>

      {created ? (
        <Banner tone="warning" heading={t('apikeys.created.heading')} testId="api-key-created">
          <Stack gap="small">
            <s-paragraph>{t('apikeys.created.body')}</s-paragraph>
            <TextField label={t('apikeys.created.field', { name: created.apiKey.name })} value={created.key} onChange={() => undefined} testId="api-key-secret" />
            <Stack direction="inline" gap="small">
              <Button onPress={() => void copy(created.key)} testId="api-key-copy">
                {t('apikeys.created.copy')}
              </Button>
              <Button variant="primary" onPress={() => setCreated(null)} testId="api-key-done">
                {t('apikeys.created.done')}
              </Button>
            </Stack>
          </Stack>
        </Banner>
      ) : null}

      {error ? <Banner tone="critical" testId="api-keys-error">{error}</Banner> : null}

      <Stack gap="small">
        <TextField
          label={t('apikeys.name')}
          value={name}
          details={t('apikeys.name_details')}
          error={nameError}
          onChange={(v) => {
            setName(v);
            setNameError(undefined);
          }}
          testId="api-key-name"
        />
        <s-text type="strong">{t('apikeys.scopes')}</s-text>
        {API_SCOPES.map((scope) => (
          <Checkbox
            key={scope}
            label={`${scope} — ${t(`apikeys.scope.${scope}` as MessageKey)}`}
            checked={scopes.includes(scope)}
            onChange={(on) => toggle(scope, on)}
            testId={`api-key-scope-${scope}`}
          />
        ))}
        <div>
          <Button variant="primary" loading={busy} onPress={() => void create()} testId="api-key-create">
            {t('apikeys.create')}
          </Button>
        </div>
      </Stack>

      {keys.error ? (
        <ErrorState error={keys.error} onRetry={keys.reload} />
      ) : !keys.data ? (
        <Loading />
      ) : keys.data.items.length === 0 ? (
        <s-paragraph data-testid="api-keys-empty">{t('apikeys.list.empty')}</s-paragraph>
      ) : (
        <ul style={{ margin: 0, paddingInlineStart: 0, listStyle: 'none' }} data-testid="api-keys-list">
          {keys.data.items.map((k) => (
            <li key={k.prefix} data-testid={`api-key-${k.prefix}`} style={{ marginBlockEnd: 12 }}>
              <Stack gap="small">
                <Stack direction="inline" gap="small" alignItems="center">
                  <s-text type="strong">{k.name}</s-text>
                  {k.revokedAt ? <Badge>{t('apikeys.list.revoked', { date: dateTime(k.revokedAt) })}</Badge> : <Badge tone="success">{t('apikeys.list.active')}</Badge>}
                </Stack>
                <s-text>
                  <code>{k.hint}</code>
                </s-text>
                <Stack direction="inline" gap="small">
                  {k.scopes.map((s) => (
                    <Badge key={s} tone="info">
                      {s}
                    </Badge>
                  ))}
                </Stack>
                <s-text>
                  {t('apikeys.list.created', { date: dateTime(k.createdAt) })}
                  {' · '}
                  {k.lastUsedAt ? t('apikeys.list.last_used', { date: dateTime(k.lastUsedAt) }) : t('apikeys.list.never_used')}
                </s-text>
                {k.revokedAt ? null : (
                  <div>
                    <Button tone="critical" variant="secondary" onPress={() => setRevoking(k)} accessibilityLabel={t('apikeys.revoke.accessibility', { name: k.name })} testId={`api-key-revoke-${k.prefix}`}>
                      {t('apikeys.revoke')}
                    </Button>
                  </div>
                )}
              </Stack>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={revoking !== null}
        heading={t('apikeys.revoke.heading', { name: revoking?.name ?? '' })}
        confirmLabel={t('apikeys.revoke.confirm')}
        cancelLabel={t('common.cancel')}
        tone="critical"
        busy={busy}
        onConfirm={() => revoking && void revoke(revoking)}
        onClose={() => setRevoking(null)}
      >
        <s-paragraph>{t('apikeys.revoke.body')}</s-paragraph>
      </ConfirmDialog>
    </Stack>
  );
}
