import type { HomeStatsResponse, ExtensionKey, TrackedItem, UnitState } from '@serialis/contract';
import { useMemo } from 'react';
import { useClient, useSession } from '../../context';
import { UNIT_STATES, variantLabel } from '../../data';
import { useI18n, type MessageKey } from '../../i18n';
import { Badge, Button, Section, Stack } from '../../ui/components';
import { useAsync } from '../../ui/hooks';
import { Link } from '../../ui/Link';
import { Page } from '../../ui/Page';
import { EmptyState, ErrorState, Loading } from '../../ui/states';

export const WIZARD_STEPS = ['products', 'refs', 'gap', 'blocks', 'done'] as const;
export const EXTENSIONS: ExtensionKey[] = ['variant_block', 'product_block', 'order_block', 'order_action'];

function Sparkline({ history, label }: { history: HomeStatsResponse['assignedUnder60s']['history30d']; label: string }) {
  const points = history.map((h, i) => ({ i, rate: h.rate }));
  const known = points.filter((p): p is { i: number; rate: number } => p.rate !== null);
  if (known.length < 2) return null;
  const w = 240;
  const h = 48;
  const min = Math.min(...known.map((p) => p.rate));
  const max = Math.max(...known.map((p) => p.rate));
  const span = max - min || 1;
  const x = (i: number) => (i / Math.max(history.length - 1, 1)) * w;
  const y = (r: number) => h - 4 - ((r - min) / span) * (h - 8);
  const path = known.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.rate).toFixed(1)}`).join(' ');
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${w} ${h}`} width="100%" style={{ maxWidth: w }} data-testid="sparkline">
      <title>{label}</title>
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function StartCard({ items }: { items: TrackedItem[] }) {
  const { t } = useI18n();
  const { me } = useSession();
  const stepIndex = WIZARD_STEPS.indexOf(me.onboarding.step);
  const shown = me.extensionsShown;
  return (
    <Section heading={t('home.start.heading')}>
      <Stack>
        <s-paragraph>{t('home.start.body')}</s-paragraph>
        <s-text type="strong" data-testid="start-step">
          {t('home.start.step', { current: stepIndex + 1, total: WIZARD_STEPS.length - 1, name: t(`wizard.step.${me.onboarding.step}`) })}
        </s-text>
        {items.length > 0 && shown ? (
          <ul style={{ margin: 0, paddingInlineStart: 20 }} data-testid="start-extensions">
            {EXTENSIONS.map((k) => (
              <li key={k}>
                {t(`wizard.ext.${k}`)} : {shown[k] ? t('home.start.extension.shown') : t('home.start.extension.not_shown')}
              </li>
            ))}
          </ul>
        ) : null}
        <Link to="/start">
          <Button variant="primary">{t('home.start.continue')}</Button>
        </Link>
      </Stack>
    </Section>
  );
}

export function Home() {
  const { t, number, percent, dateTime } = useI18n();
  const client = useClient();
  const { me } = useSession();
  const state = useAsync(async () => {
    const [stats, items, locations] = await Promise.all([client.homeStats(), client.listTrackedItems({ limit: 250 }), client.listLocations()]);
    return { stats, items: items.items, locations: locations.items };
  }, [client]);

  const unitsTable = useMemo(() => {
    if (!state.data) return null;
    const { stats, locations } = state.data;
    const states = UNIT_STATES.filter((s) => stats.unitsByState.some((u) => u.state === s));
    const rows = locations
      .map((l) => ({ location: l, counts: Object.fromEntries(states.map((s) => [s, stats.unitsByState.find((u) => u.locationId === l.id && u.state === s)?.count ?? 0])) as Record<UnitState, number> }))
      .filter((r) => states.some((s) => r.counts[s] > 0));
    return { states, rows };
  }, [state.data]);

  if (!state.data) {
    return (
      <Page heading={t('home.heading')}>
        {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : <Loading />}
      </Page>
    );
  }

  const { stats, items, locations } = state.data;
  const locName = (id: string) => locations.find((l) => l.id === id)?.name ?? id;
  const todo: Array<{ key: string; message: MessageKey; count: number; to: string }> = [
    { key: 'lines', message: 'home.todo.lines', count: stats.toDo.linesWithoutUnit, to: '/anomalies?type=awaiting_unit' },
    { key: 'critical', message: 'home.todo.critical', count: stats.toDo.criticalAnomalies, to: '/anomalies?severity=critical' },
    { key: 'returns', message: 'home.todo.returns', count: stats.toDo.returnsToIdentify, to: '/anomalies?type=return_unidentified' },
    { key: 'shipped', message: 'home.todo.shipped', count: stats.toDo.shippedUnitsToDesignate, to: '/anomalies?type=shipped_unit_to_confirm' },
  ];
  const openTodo = todo.filter((c) => c.count > 0);
  const initializing = items.filter((i) => i.initializing);
  const syncTone = { green: 'success', orange: 'warning', red: 'critical' } as const;
  const rate = stats.assignedUnder60s.rate;
  const rates = stats.assignedUnder60s.history30d.flatMap((h) => (h.rate === null ? [] : [h.rate]));

  return (
    <Page heading={t('home.heading')}>
      {!me.onboarding.completed ? <StartCard items={items} /> : null}

      {items.length === 0 ? (
        <Section>
          <EmptyState
            heading={t('home.empty.heading')}
            action={
              <Link to="/start">
                <Button variant="primary">{t('home.empty.action')}</Button>
              </Link>
            }
          >
            {t('home.empty.body')}
          </EmptyState>
        </Section>
      ) : null}

      {initializing.length > 0 ? (
        <Section heading={t('home.init.heading')}>
          <Stack gap="small">
            {initializing.flatMap((item) =>
              item.stock
                .filter((s) => s.registeredUnits < s.shopifyOnHand)
                .map((s) => (
                  <s-paragraph key={`${item.variantGid}-${s.locationId}`}>
                    {t('home.init.line', { title: variantLabel(item), shopify: s.shopifyOnHand, registered: s.registeredUnits, location: locName(s.locationId) })}
                  </s-paragraph>
                )),
            )}
            <Link to="/start">
              <Button>{t('home.init.action')}</Button>
            </Link>
          </Stack>
        </Section>
      ) : null}

      <Section heading={t('home.sync.heading')}>
        <Stack gap="small">
          <Badge tone={syncTone[stats.sync.level]}>{t(`home.sync.${stats.sync.level}`)}</Badge>
          <s-text>{t('home.sync.last_webhook', { date: stats.sync.lastWebhookAt ? dateTime(stats.sync.lastWebhookAt) : t('home.sync.never') })}</s-text>
          <s-text>{t('home.sync.last_reconciliation', { date: stats.sync.lastReconciliationAt ? dateTime(stats.sync.lastReconciliationAt) : t('home.sync.never') })}</s-text>
          <s-text>{stats.sync.delaySeconds > 0 ? t('home.sync.delay', { seconds: number(stats.sync.delaySeconds) }) : t('home.sync.no_delay')}</s-text>
          <s-text>{stats.sync.pendingWrites > 0 ? t('home.sync.pending', { count: stats.sync.pendingWrites }) : t('home.sync.pending_none')}</s-text>
        </Stack>
      </Section>

      <Section heading={t('home.todo.heading')}>
        {openTodo.length === 0 ? (
          <s-paragraph data-testid="todo-empty">{t('home.todo.empty')}</s-paragraph>
        ) : (
          <Stack gap="small">
            {openTodo.map((c) => (
              <Stack key={c.key} direction="inline" gap="base" alignItems="center">
                <s-text data-testid={`todo-${c.key}`}>{t(c.message, { count: c.count })}</s-text>
                <Link to={c.to}>{t('home.todo.open')}</Link>
              </Stack>
            ))}
          </Stack>
        )}
      </Section>

      <Section heading={t('home.kpi.heading')}>
        <Stack>
          <Stack gap="small">
            <s-text type="strong">{t('home.kpi.under60')}</s-text>
            <s-heading data-testid="kpi-under60">{rate === null ? t('home.kpi.no_data') : percent(rate)}</s-heading>
            {rate !== null ? <s-text>{t('home.kpi.under60.sample', { count: stats.assignedUnder60s.sample })}</s-text> : null}
            {rates.length > 1 ? (
              <Sparkline history={stats.assignedUnder60s.history30d} label={t('home.kpi.history', { min: percent(Math.min(...rates)), max: percent(Math.max(...rates)) })} />
            ) : null}
          </Stack>
          <Stack gap="small">
            <s-text type="strong">{t('home.kpi.units_heading')}</s-text>
            {unitsTable && unitsTable.rows.length > 0 ? (
              <s-table data-testid="units-by-state">
                <s-table-header-row>
                  <s-table-header>{t('home.kpi.location')}</s-table-header>
                  {unitsTable.states.map((s) => (
                    <s-table-header key={s} format="numeric">
                      {t(`state.${s}`)}
                    </s-table-header>
                  ))}
                </s-table-header-row>
                <s-table-body>
                  {unitsTable.rows.map((r) => (
                    <s-table-row key={r.location.id}>
                      <s-table-cell>{r.location.name}</s-table-cell>
                      {unitsTable.states.map((s) => (
                        <s-table-cell key={s}>{number(r.counts[s])}</s-table-cell>
                      ))}
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            ) : (
              <s-paragraph>{t('home.kpi.units_empty')}</s-paragraph>
            )}
          </Stack>
        </Stack>
      </Section>
    </Page>
  );
}
