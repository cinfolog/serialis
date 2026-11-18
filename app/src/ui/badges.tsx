import type { AnomalySeverity, UnitState } from '@serialis/contract';
import { useI18n } from '../i18n';
import { Badge } from './components';

const STATE_TONE: Record<UnitState, 'neutral' | 'info' | 'success' | 'warning' | 'critical'> = {
  INCOMING: 'neutral', AVAILABLE: 'success', HELD: 'info', ALLOCATED: 'info', QUALITY_CONTROL: 'warning', DAMAGED: 'critical',
  IN_TRANSIT: 'neutral', SHIPPED: 'neutral', RETURN_PENDING: 'warning', TO_VERIFY: 'warning', LOST: 'critical', SCRAPPED: 'neutral', UNTRACKED: 'neutral',
};

/** The label always carries the meaning; the colour only reinforces it (15.9). */
export function StateBadge({ state }: { state: UnitState }) {
  const { t } = useI18n();
  return <Badge tone={STATE_TONE[state]}>{t(`state.${state}`)}</Badge>;
}

const SEVERITY_TONE = { critical: 'critical', warning: 'warning', info: 'info' } as const;

export function SeverityBadge({ severity }: { severity: AnomalySeverity }) {
  const { t } = useI18n();
  return <Badge tone={SEVERITY_TONE[severity]}>{t(`severity.${severity}`)}</Badge>;
}
