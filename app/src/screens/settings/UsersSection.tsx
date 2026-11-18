import type { AppUser } from '@serialis/contract';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { useAnnounce, useClient, useSession } from '../../context';
import { useI18n, type MessageKey } from '../../i18n';
import { Badge, Banner, Button, ConfirmDialog, Section, Stack } from '../../ui/components';
import { useAsync } from '../../ui/hooks';
import { ErrorState, Loading, useErrorMessage } from '../../ui/states';

/** Refusals of `PATCH /app-users` with their own explanation (`workers/src/api/users.ts`). */
const PATCH_ERRORS: Record<string, MessageKey> = {
  owner_required: 'users.error.owner_required',
  owner_is_admin: 'users.error.owner_is_admin',
  user_never_opened_the_app: 'users.error.not_found',
};

/**
 * Settings › Users (15.4 « Utilisateurs : propriétaire et administrateurs », 15.8): the users who opened
 * the app, with the owner and administrator badges, first visit and who designated them. Only the owner
 * designates or withdraws administrators (never the owner itself); a designated administrator sees the
 * list read-only; an operator sees the explanation and no call is made (the Worker answers 403 anyway).
 */
export function UsersSection() {
  const { t } = useI18n();
  const { canAdmin } = useSession();
  return (
    <Section heading={t('users.heading')}>
      <Stack>
        <s-paragraph>{t('users.intro')}</s-paragraph>
        {canAdmin ? <UsersList /> : <s-paragraph data-testid="users-read-only">{t('users.admin_only')}</s-paragraph>}
      </Stack>
    </Section>
  );
}

type Change = { user: AppUser; role: AppUser['role'] };

function UsersList() {
  const { t, date } = useI18n();
  const client = useClient();
  const announce = useAnnounce();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const isOwner = me.owner === true;
  const users = useAsync(() => client.listAppUsers(), [client]);
  const [change, setChange] = useState<Change | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const all = users.data?.items ?? [];
  const nameOf = (u: Pick<AppUser, 'userId' | 'firstName'>) => u.firstName ?? t('users.unnamed', { id: u.userId });
  const nameById = (id: string) => {
    const u = all.find((x) => x.userId === id);
    return u ? nameOf(u) : t('users.unnamed', { id });
  };

  async function apply(c: Change) {
    setBusy(true);
    setError(null);
    try {
      await client.patchAppUser({ userId: c.user.userId, role: c.role });
      const message = t(c.role === 'admin' ? 'users.granted' : 'users.revoked', { name: nameOf(c.user) });
      announce(message, { toast: true });
      users.reload();
    } catch (e) {
      const known = e instanceof ApiError && e.detail ? PATCH_ERRORS[e.detail] : undefined;
      const message = known ? t(known) : errorMessage(e);
      setError(message);
      announce(message);
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) users.reload();
    } finally {
      setBusy(false);
      setChange(null);
    }
  }

  if (users.error && !users.data) return <ErrorState error={users.error} onRetry={users.reload} />;
  if (!users.data) return <Loading />;

  const others = all.filter((u) => u.userId !== me.userId);
  return (
    <Stack>
      {isOwner ? null : (
        <Banner tone="info" testId="users-owner-only">
          {t('users.owner_only')}
        </Banner>
      )}
      {error ? (
        <Banner tone="critical" testId="users-error">
          {error}
        </Banner>
      ) : null}
      {users.error ? <ErrorState error={users.error} onRetry={users.reload} /> : null}
      <ul style={{ margin: 0, paddingInlineStart: 0, listStyle: 'none' }} data-testid="users-list">
        {all.map((u) => (
          <li key={u.userId} data-testid={`user-${u.userId}`} style={{ marginBlockEnd: 12 }}>
            <Stack gap="small">
              <Stack direction="inline" gap="small" alignItems="center">
                <s-text type="strong">{nameOf(u)}</s-text>
                {u.userId === me.userId ? <Badge tone="info">{t('users.badge.you')}</Badge> : null}
                {u.owner ? <Badge tone="success">{t('users.badge.owner')}</Badge> : null}
                {u.role === 'admin' ? <Badge tone="success">{t('users.badge.admin')}</Badge> : <Badge>{t('users.badge.operator')}</Badge>}
              </Stack>
              <s-text>
                {t('users.first_seen', { date: date(u.firstSeenAt) })}
                {u.designatedBy && !u.owner ? ` · ${t('users.designated_by', { name: nameById(u.designatedBy) })}` : null}
              </s-text>
              {isOwner && !u.owner ? (
                <div>
                  {u.role === 'admin' ? (
                    <Button
                      variant="secondary"
                      tone="critical"
                      disabled={busy}
                      onPress={() => setChange({ user: u, role: 'operator' })}
                      accessibilityLabel={t('users.revoke.accessibility', { name: nameOf(u) })}
                      testId={`user-revoke-${u.userId}`}
                    >
                      {t('users.revoke')}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onPress={() => setChange({ user: u, role: 'admin' })}
                      accessibilityLabel={t('users.grant.accessibility', { name: nameOf(u) })}
                      testId={`user-grant-${u.userId}`}
                    >
                      {t('users.grant')}
                    </Button>
                  )}
                </div>
              ) : null}
            </Stack>
          </li>
        ))}
      </ul>
      {others.length === 0 ? <s-paragraph data-testid="users-empty">{t('users.empty')}</s-paragraph> : null}

      <ConfirmDialog
        open={change !== null}
        heading={change ? t(change.role === 'admin' ? 'users.grant.heading' : 'users.revoke.heading', { name: nameOf(change.user) }) : ''}
        confirmLabel={t(change?.role === 'operator' ? 'users.revoke.confirm' : 'users.grant.confirm')}
        cancelLabel={t('common.cancel')}
        {...(change?.role === 'operator' ? { tone: 'critical' as const } : {})}
        busy={busy}
        onConfirm={() => change && void apply(change)}
        onClose={() => setChange(null)}
      >
        <s-paragraph>{change ? t(change.role === 'admin' ? 'users.grant.body' : 'users.revoke.body', { name: nameOf(change.user) }) : null}</s-paragraph>
      </ConfirmDialog>
    </Stack>
  );
}
