import type { HealthAlert, HealthResponse } from '@serialis/contract';
import { useAnnounce, useClient, useSession } from '../../context';
import { useI18n, type MessageKey } from '../../i18n';
import { Badge, Banner, Button, Section, Stack } from '../../ui/components';
import { useAsync } from '../../ui/hooks';
import { Link } from '../../ui/Link';
import { Page } from '../../ui/Page';
import { ErrorState, Loading } from '../../ui/states';

/** Database size thresholds of 17.2 (alert at 5 GB, critical at 8 GB). */
const SIZE_WARNING_BYTES = 5_000_000_000;

/** Alerts that also stop the whole shop (critical tone); the others are warnings. */
const CRITICAL_ALERTS = new Set<HealthAlert>(['task_dead', 'outbox_dead', 'reconnect_required']);

/**
 * Settings › Health (17.1, 17.2): admin view of `GET /health` — overall status and alerts, shop state and
 * access to Shopify, work queues, regular passes (R1 to R4, purge), dead tasks and given-up writes.
 * Administrators only (15.8): an operator sees the explanation, no call is made.
 */
export function Health() {
  const { t } = useI18n();
  const { canAdmin } = useSession();
  const back = <Link to="/settings">{t('health.back')}</Link>;
  if (!canAdmin) {
    return (
      <Page heading={t('health.heading')} back={back}>
        <Banner tone="info" testId="health-read-only">
          {t('common.read_only_admin')}
        </Banner>
      </Page>
    );
  }
  return <HealthReport back={back} />;
}

function HealthReport({ back }: { back: React.ReactNode }) {
  const { t, dateTime } = useI18n();
  const client = useClient();
  const announce = useAnnounce();
  const state = useAsync(async () => ({ report: await client.health(), at: new Date().toISOString() }), [client]);

  if (!state.data) {
    return (
      <Page heading={t('health.heading')} back={back}>
        {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : <Loading />}
      </Page>
    );
  }

  const { report, at } = state.data;
  return (
    <Page heading={t('health.heading')} back={back}>
      <s-paragraph>{t('health.intro')}</s-paragraph>
      {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
      <Overview report={report} />
      <ShopSection report={report} />
      <QueuesSection report={report} />
      <PassesSection report={report} />
      <DeadTasksSection report={report} />
      <DeadWritesSection report={report} />
      <Section>
        <Stack direction="inline" gap="base" alignItems="center">
          <Button
            loading={state.loading}
            onPress={() => {
              state.reload();
              announce(t('health.refreshed'));
            }}
            testId="health-refresh"
          >
            {t('health.refresh')}
          </Button>
          <s-text data-testid="health-updated">{t('health.updated', { date: dateTime(at) })}</s-text>
        </Stack>
      </Section>
    </Page>
  );
}

function Overview({ report }: { report: HealthResponse }) {
  const { t } = useI18n();
  const alerts = report.alerts;
  return (
    <Section heading={t('health.status.heading')}>
      <Stack gap="small">
        <div data-testid="health-status">
          {alerts.length === 0 ? <Badge tone="success">{t('health.status.ok')}</Badge> : <Badge tone={alerts.some((a) => CRITICAL_ALERTS.has(a)) ? 'critical' : 'warning'}>{t('health.status.attention')}</Badge>}
        </div>
        {alerts.length === 0 ? (
          <s-paragraph data-testid="health-no-alert">{t('health.status.ok_body')}</s-paragraph>
        ) : (
          <Stack gap="small">
            <s-text type="strong">{t('health.alerts.heading', { count: alerts.length })}</s-text>
            {alerts.map((a) => (
              <Banner key={a} tone={CRITICAL_ALERTS.has(a) ? 'critical' : 'warning'} testId={`health-alert-${a}`}>
                {t(`health.alert.${a}` as MessageKey)}
              </Banner>
            ))}
          </Stack>
        )}
      </Stack>
    </Section>
  );
}

function useBytes(): (bytes: number) => string {
  const { locale } = useI18n();
  return (bytes) => {
    const units = [
      ['gigabyte', 1e9],
      ['megabyte', 1e6],
      ['kilobyte', 1e3],
    ] as const;
    const [unit, size] = units.find(([, s]) => bytes >= s) ?? ['byte', 1];
    return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(bytes / size);
  };
}

function Line({ label, value, testId }: { label: string; value: React.ReactNode; testId: string }) {
  return (
    <Stack direction="inline" gap="small" alignItems="center">
      <s-text type="strong">{label}</s-text>
      <span data-testid={testId}>{value}</span>
    </Stack>
  );
}

function ShopSection({ report }: { report: HealthResponse }) {
  const { t, dateTime, number } = useI18n();
  const bytes = useBytes();
  const stateTone = { active: 'success', frozen: 'warning', uninstalled: 'critical' } as const;
  const tokenTone = { valid: 'success', refreshing: 'info', missing: 'critical', reconnect_required: 'critical' } as const;
  return (
    <Section heading={t('health.shop.heading')}>
      <Stack gap="small">
        <Line label={t('health.shop.state')} testId="health-shop-state" value={<Badge tone={stateTone[report.shopState]}>{t(`health.shop.state.${report.shopState}`)}</Badge>} />
        <Line label={t('health.shop.token')} testId="health-token" value={<Badge tone={tokenTone[report.token]}>{t(`health.shop.token.${report.token}`)}</Badge>} />
        <Line label={t('health.shop.last_webhook')} testId="health-last-webhook" value={<s-text>{report.lastWebhookAt ? dateTime(report.lastWebhookAt) : t('health.shop.never')}</s-text>} />
        <Line label={t('health.shop.schema')} testId="health-schema" value={<s-text>{number(report.schemaVersion)}</s-text>} />
        <Line label={t('health.shop.size')} testId="health-size" value={<s-text>{report.databaseBytes === null ? t('health.shop.size_unknown') : bytes(report.databaseBytes)}</s-text>} />
        {report.databaseBytes !== null && report.databaseBytes >= SIZE_WARNING_BYTES ? (
          <Banner tone="warning" testId="health-size-warning">
            {t('health.shop.size_warning')}
          </Banner>
        ) : null}
      </Stack>
    </Section>
  );
}

function QueuesSection({ report }: { report: HealthResponse }) {
  const { t, number } = useI18n();
  const c = report.counters;
  const rows: Array<{ key: string; label: MessageKey; value: string; alert: boolean }> = [
    { key: 'tasks-dead', label: 'health.queues.tasks_dead', value: number(c.tasksDead), alert: c.tasksDead > 0 },
    { key: 'tasks-overdue', label: 'health.queues.tasks_overdue', value: number(c.tasksOverdue), alert: c.tasksOverdue > 0 },
    { key: 'outbox-pending', label: 'health.queues.outbox_pending', value: number(c.outboxPending), alert: false },
    { key: 'outbox-over-1h', label: 'health.queues.outbox_over_1h', value: number(c.outboxPendingOver1h), alert: c.outboxPendingOver1h > 0 },
    { key: 'outbox-dead', label: 'health.queues.outbox_dead', value: number(c.outboxDead), alert: c.outboxDead > 0 },
    {
      key: 'oldest',
      label: 'health.queues.oldest',
      value: c.outboxOldestPendingSeconds === null ? t('health.queues.oldest_none') : t('health.queues.minutes', { count: Math.floor(c.outboxOldestPendingSeconds / 60) }),
      alert: false,
    },
  ];
  return (
    <Section heading={t('health.queues.heading')}>
      <s-table data-testid="health-queues">
        <s-table-header-row>
          <s-table-header>{t('health.queues.name')}</s-table-header>
          <s-table-header format="numeric">{t('health.queues.value')}</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {rows.map((r) => (
            <s-table-row key={r.key}>
              <s-table-cell>{t(r.label)}</s-table-cell>
              <s-table-cell>
                <span data-testid={`health-counter-${r.key}`}>{r.alert ? <Badge tone="critical">{r.value}</Badge> : r.value}</span>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </Section>
  );
}

function PassesSection({ report }: { report: HealthResponse }) {
  const { t, dateTime } = useI18n();
  return (
    <Section heading={t('health.passes.heading')}>
      <Stack gap="small">
        <s-paragraph>{t('health.passes.intro')}</s-paragraph>
        <s-table data-testid="health-passes">
          <s-table-header-row>
            <s-table-header>{t('health.passes.pass')}</s-table-header>
            <s-table-header>{t('health.passes.last')}</s-table-header>
            <s-table-header>{t('health.passes.next')}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {report.passes.map((p) => (
              <s-table-row key={p.pass}>
                <s-table-cell>{t(`health.pass.${p.pass}`)}</s-table-cell>
                <s-table-cell>{p.lastRunAt ? dateTime(p.lastRunAt) : t('health.passes.never')}</s-table-cell>
                <s-table-cell>{p.nextRunAt ? dateTime(p.nextRunAt) : t('health.passes.none')}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </Stack>
    </Section>
  );
}

function DeadTasksSection({ report }: { report: HealthResponse }) {
  const { t, dateTime, number } = useI18n();
  return (
    <Section heading={t('health.dead_tasks.heading')}>
      {report.deadTasks.length === 0 ? (
        <s-paragraph data-testid="health-dead-tasks-empty">{t('health.dead_tasks.empty')}</s-paragraph>
      ) : (
        <s-table data-testid="health-dead-tasks">
          <s-table-header-row>
            <s-table-header>{t('health.dead_tasks.task')}</s-table-header>
            <s-table-header format="numeric">{t('health.dead_tasks.attempts')}</s-table-header>
            <s-table-header>{t('health.dead_tasks.error')}</s-table-header>
            <s-table-header>{t('health.dead_tasks.at')}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {report.deadTasks.map((d) => (
              <s-table-row key={d.key}>
                <s-table-cell>
                  <code style={{ overflowWrap: 'anywhere' }}>{d.kind}</code>
                </s-table-cell>
                <s-table-cell>{number(d.attempts)}</s-table-cell>
                <s-table-cell>
                  <span style={{ overflowWrap: 'anywhere' }}>{d.lastError ?? t('health.no_error')}</span>
                </s-table-cell>
                <s-table-cell>{dateTime(d.updatedAt)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      )}
    </Section>
  );
}

function DeadWritesSection({ report }: { report: HealthResponse }) {
  const { t, dateTime } = useI18n();
  return (
    <Section heading={t('health.dead_writes.heading')}>
      {report.deadWrites.length === 0 ? (
        <s-paragraph data-testid="health-dead-writes-empty">{t('health.dead_writes.empty')}</s-paragraph>
      ) : (
        <s-table data-testid="health-dead-writes">
          <s-table-header-row>
            <s-table-header>{t('health.dead_writes.write')}</s-table-header>
            <s-table-header>{t('health.dead_writes.error')}</s-table-header>
            <s-table-header>{t('health.dead_writes.at')}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {report.deadWrites.map((w) => (
              <s-table-row key={w.id}>
                <s-table-cell>
                  <code style={{ overflowWrap: 'anywhere' }}>{`${w.kind} #${w.id}`}</code>
                </s-table-cell>
                <s-table-cell>
                  <span style={{ overflowWrap: 'anywhere' }}>{w.lastError ?? t('health.no_error')}</span>
                </s-table-cell>
                <s-table-cell>{dateTime(w.updatedAt)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      )}
    </Section>
  );
}

/** Settings › Health entry (15.4): link to the health screen for administrators. */
export function HealthLinkSection() {
  const { t } = useI18n();
  const { canAdmin } = useSession();
  return (
    <Section heading={t('settings.health.heading')}>
      <Stack gap="small">
        <s-paragraph>{t('settings.health.body')}</s-paragraph>
        {canAdmin ? (
          <div data-testid="settings-health-link">
            <Link to="/settings/health">{t('settings.health.open')}</Link>
          </div>
        ) : (
          <s-paragraph>{t('common.read_only_admin')}</s-paragraph>
        )}
      </Stack>
    </Section>
  );
}
