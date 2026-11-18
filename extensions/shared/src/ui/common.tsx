import type { ComponentChildren } from 'preact';
import type { UnitState } from '@serialis/contract';
import { ApiError } from '../api-client';
import { errorMessage, type Translate } from '../i18n';
import { useSlow } from '../hooks';

/** `aria-*` attributes are not part of the typed props of Polaris web components: spread them untyped. */
export function aria(attrs: Record<string, string>): Record<string, unknown> {
  return attrs;
}

/** Loading state: spinner and, after 3 s, "Encore un instant" (15.7). */
export function Loading({ t }: { t: Translate }) {
  const slow = useSlow(true);
  return (
    <s-stack direction="inline" gap="base" alignItems="center">
      <s-spinner accessibilityLabel={t('common.loading')} />
      <s-text>{slow ? t('common.stillLoading') : t('common.loading')}</s-text>
    </s-stack>
  );
}

/** Failed call: clear message and a retry button when `onRetry` is given. */
export function ErrorBanner({ t, error, onRetry }: { t: Translate; error: unknown; onRetry?: () => void }) {
  return (
    <s-banner tone="critical" heading={t('common.errorTitle')}>
      <s-stack gap="small-200">
        <s-text>{errorMessage(t, error)}</s-text>
        {onRetry ? (
          <s-button variant="secondary" onClick={onRetry}>
            {t('common.retry')}
          </s-button>
        ) : null}
      </s-stack>
    </s-banner>
  );
}

/** Permanent banner while offline: submissions are blocked, typed input is kept (15.5, 15.7). */
export function OfflineBanner({ t }: { t: Translate }) {
  return (
    <s-banner tone="warning" heading={t('common.offlineTitle')}>
      <s-text>{t('common.offlineBody')}</s-text>
    </s-banner>
  );
}

/** True for failures that mean "the app is not usable right now" (shown as a permanent banner, 15.7). */
export function isEmergencyStop(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'emergency_stop';
}

const STATE_TONE: Record<UnitState, 'neutral' | 'info' | 'success' | 'warning' | 'critical'> = {
  INCOMING: 'info',
  AVAILABLE: 'success',
  HELD: 'info',
  ALLOCATED: 'info',
  QUALITY_CONTROL: 'warning',
  DAMAGED: 'critical',
  IN_TRANSIT: 'info',
  SHIPPED: 'neutral',
  RETURN_PENDING: 'warning',
  TO_VERIFY: 'warning',
  LOST: 'critical',
  SCRAPPED: 'neutral',
  UNTRACKED: 'neutral',
};

/** State badge: the label always carries the information, never the colour alone (15.9). */
export function StateBadge({ t, state }: { t: Translate; state: UnitState }) {
  return <s-badge tone={STATE_TONE[state]}>{t(`states.${state}`)}</s-badge>;
}

export function Section({ heading, children }: { heading?: string; children: ComponentChildren }) {
  return (
    <s-stack gap="small-300">
      {heading ? <s-heading>{heading}</s-heading> : null}
      {children}
    </s-stack>
  );
}
