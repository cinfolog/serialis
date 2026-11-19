import { type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useI18n } from '../i18n';
import { problemMessage } from '../labels';
import { Banner, Button, Stack } from './components';
import { useSlow } from './hooks';

/** Human message for an API error: what happened, why and what to do (15.1, 15.7). */
export function useErrorMessage(): (error: unknown) => string {
  const i18n = useI18n();
  return (error) => {
    if (error instanceof ApiError) return error.code === 'network' ? i18n.t('error.network') : problemMessage(i18n, error.code, error.detail);
    return i18n.t('error.unknown');
  };
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const message = useErrorMessage()(error);
  return (
    <Banner tone="critical" heading={t('common.error_title')} testId="error-state">
      <Stack gap="small">
        <s-paragraph>{message}</s-paragraph>
        {onRetry ? <Button onPress={onRetry}>{t('common.retry')}</Button> : null}
      </Stack>
    </Banner>
  );
}

/** Skeleton-like loading state; after 3 s it adds "Encore un instant" (15.7). */
export function Loading({ active = true }: { active?: boolean }) {
  const { t } = useI18n();
  const slow = useSlow(active);
  return (
    <div role="status" aria-busy="true" data-testid="loading">
      <Stack direction="inline" gap="small" alignItems="center">
        <s-spinner accessibilityLabel={t('common.loading')} />
        <s-text>{slow ? t('common.still_loading') : t('common.loading')}</s-text>
      </Stack>
    </div>
  );
}

export function EmptyState({ heading, children, action }: { heading: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <s-box padding="large" data-testid="empty-state">
      <Stack gap="small" alignItems="center">
        <s-heading>{heading}</s-heading>
        {children ? <s-paragraph>{children}</s-paragraph> : null}
        {action}
      </Stack>
    </s-box>
  );
}
