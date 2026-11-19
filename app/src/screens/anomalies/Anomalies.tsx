import type { Anomaly, Unit } from '@serialis/contract';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { isApiError, newIdempotencyKey } from '../../api/client';
import { useAnnounce, useClient, useSession } from '../../context';
import { SEVERITY_ORDER, useLocations } from '../../data';
import { useI18n } from '../../i18n';
import { adminUrl, gidNumber } from '../../shopify';
import { Badge, Banner, Button, ConfirmDialog, Section, Select, Stack } from '../../ui/components';
import { SeverityBadge } from '../../ui/badges';
import { DesignationInput } from '../../ui/DesignationInput';
import { LIVE_POLL_MS, useAsync } from '../../ui/hooks';
import { AdminLink } from '../../ui/Link';
import { Page } from '../../ui/Page';
import { EmptyState, ErrorState, Loading, useErrorMessage } from '../../ui/states';

type Action = Anomaly['actions'][number];

function AnomalyCard({ anomaly, locationName, onChanged }: { anomaly: Anomaly; locationName: string; onChanged: (a: Anomaly) => void }) {
  const { t, tMaybe, dateTime } = useI18n();
  const client = useClient();
  const { canAdmin } = useSession();
  const announce = useAnnounce();
  const errorMessage = useErrorMessage();
  const [active, setActive] = useState<Action | null>(null);
  const [candidates, setCandidates] = useState<Unit[] | null>(null);
  const [pending, setPending] = useState<{ action: Action; ref?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());

  const keyFor = (signature: string) => {
    let key = keys.current.get(signature);
    if (!key) keys.current.set(signature, (key = newIdempotencyKey()));
    return key;
  };

  // Candidate units for a typed designation: the anomaly's variant and location only (15.5).
  useEffect(() => {
    if (!active?.needsRef) return;
    let cancelled = false;
    setCandidates(null);
    client
      .listUnits({ ...(anomaly.variantGid ? { variant: anomaly.variantGid } : {}), ...(anomaly.locationId ? { location: anomaly.locationId } : {}), limit: 250 })
      .then((page) => !cancelled && setCandidates(page.items))
      .catch((e: unknown) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.action, anomaly.id, client]);

  async function resolve(action: Action, ref?: string) {
    setBusy(true);
    setError(null);
    const signature = `${anomaly.id}|${action.action}|${ref ?? ''}`;
    try {
      const updated = await client.resolveAnomaly(anomaly.id, { action: action.action, ...(ref ? { params: { ref } } : {}) }, { idempotencyKey: keyFor(signature) });
      keys.current.delete(signature);
      // A unit of a multi-unit anomaly: say what is left until the anomaly really closes (recette 3).
      announce(
        updated.status === 'resolved' || !updated.remaining
          ? t('anomalies.resolved_done')
          : t(action.action === 'confirm_shipped' || action.action === 'designate_shipped' ? 'anomalies.partial_confirmed' : 'anomalies.partial_done', { count: updated.remaining }),
        { toast: true },
      );
      setPending(null);
      setActive(null);
      onChanged(updated);
    } catch (e) {
      // A refused designation keeps the input and says what to do; the key is renewed because the answer was a refusal.
      if (isApiError(e) && e.status >= 400 && e.status < 500) keys.current.delete(signature);
      setError(errorMessage(e));
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  async function acknowledge() {
    setBusy(true);
    setError(null);
    try {
      const updated = await client.acknowledgeAnomaly(anomaly.id, { idempotencyKey: keyFor(`ack|${anomaly.id}`) });
      announce(t('anomalies.acknowledged_done'));
      onChanged(updated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function choose(action: Action) {
    setError(null);
    if (action.needsRef) {
      setActive(active?.action === action.action ? null : action);
    } else {
      setActive(null);
      setPending({ action });
    }
  }

  const typeLabel = tMaybe(`anomaly.type.${anomaly.type}`) ?? t('anomalies.type.other');
  const resolved = anomaly.status === 'resolved';
  const statusTone = { open: 'warning', acknowledged: 'info', resolved: 'success' } as const;

  return (
    <Section>
      <article aria-label={typeLabel} data-testid={`anomaly-${anomaly.id}`}>
        <Stack>
          <Stack direction="inline" gap="small" alignItems="center">
            <SeverityBadge severity={anomaly.severity} />
            <s-heading>{typeLabel}</s-heading>
            <Badge tone={statusTone[anomaly.status]}>{t(`anomalies.status.${anomaly.status}`)}</Badge>
          </Stack>
          <s-paragraph>{anomaly.summary}</s-paragraph>
          <Stack direction="inline" gap="base" alignItems="center">
            <s-text>{t('anomalies.opened_at', { date: dateTime(anomaly.openedAt) })}</s-text>
            {anomaly.resolvedAt ? <s-text>{t('anomalies.resolved_at', { date: dateTime(anomaly.resolvedAt) })}</s-text> : null}
            {anomaly.locationId ? <s-text>{t('anomalies.location', { location: locationName })}</s-text> : null}
            {anomaly.orderGid ? <AdminLink href={adminUrl(`orders/${gidNumber(anomaly.orderGid)}`)}>{t('common.order_link')}</AdminLink> : null}
          </Stack>

          {!resolved ? (
            <Stack gap="small">
              <s-text type="strong">{t('anomalies.resolve_heading')}</s-text>
              {anomaly.actions.length === 0 ? <s-text>{t('anomalies.no_actions')}</s-text> : null}
              <Stack direction="inline" gap="small" alignItems="center">
                {anomaly.actions.map((a) =>
                  a.writesStock && !canAdmin ? (
                    <s-text key={a.action}>
                      {a.label} ({t('anomalies.admin_only')})
                    </s-text>
                  ) : (
                    <Button key={a.action} onPress={() => choose(a)} disabled={busy} testId={`action-${anomaly.id}-${a.action}`}>
                      {a.writesStock ? `${a.label} (${t('anomalies.writes_stock')})` : a.label}
                    </Button>
                  ),
                )}
                {anomaly.status === 'open' ? (
                  <Button variant="tertiary" onPress={() => void acknowledge()} disabled={busy} testId={`ack-${anomaly.id}`}>
                    {t('anomalies.acknowledge')}
                  </Button>
                ) : null}
              </Stack>
              {active?.needsRef ? (
                <s-box padding="base" border="base" borderRadius="base">
                  <Stack gap="small">
                    <s-text>{t('anomalies.ref_prompt', { action: active.label })}</s-text>
                    <DesignationInput
                      candidates={candidates ?? []}
                      lookup={async (ref) => (await client.lookup(ref)).unit}
                      busy={busy}
                      error={error}
                      onDesignate={(ref) => (active.writesStock ? setPending({ action: active, ref }) : resolve(active, ref))}
                    />
                  </Stack>
                </s-box>
              ) : null}
            </Stack>
          ) : null}
          {error && !active?.needsRef ? <Banner tone="critical" testId={`anomaly-error-${anomaly.id}`}>{error}</Banner> : null}
        </Stack>
      </article>

      <ConfirmDialog
        open={pending !== null}
        heading={t('anomalies.confirm.heading', { action: pending?.action.label ?? '' })}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        tone={pending?.action.writesStock ? 'critical' : undefined}
        busy={busy}
        onConfirm={() => pending && void resolve(pending.action, pending.ref)}
        onClose={() => setPending(null)}
      >
        <Stack gap="small">
          <s-paragraph>{anomaly.summary}</s-paragraph>
          {pending?.ref ? <s-paragraph>{t('anomalies.confirm.with_ref', { ref: pending.ref })}</s-paragraph> : null}
          <s-paragraph>{pending?.action.writesStock ? t('anomalies.confirm.writes_stock') : t('anomalies.confirm.no_write')}</s-paragraph>
        </Stack>
      </ConfirmDialog>
    </Section>
  );
}

/** Anomalies queue (EF-30): sorted by severity then age, filters kept in the URL, resolutions per type (12.7). */
export function Anomalies() {
  const { t, tMaybe } = useI18n();
  const client = useClient();
  const locations = useLocations();
  const [params, setParams] = useSearchParams();
  const view = params.get('status') === 'resolved' ? 'resolved' : 'active';
  const severity = params.get('severity') ?? '';
  const type = params.get('type') ?? '';

  // The answer of a resolution is shown at once; it only applies to the page it was made on: the refetch
  // that follows every write (decision 38) brings the server's state, other anomalies closed with it included.
  const [overrides, setOverrides] = useState<{ base: unknown; byId: Record<string, Anomaly> }>({ base: undefined, byId: {} });
  const [more, setMore] = useState<{ key: string; items: Anomaly[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const key = JSON.stringify([view, severity, type]);

  const page = useAsync(
    () => client.listAnomalies({ ...(view === 'resolved' ? { status: 'resolved' as const } : {}), ...(severity ? { severity: severity as Anomaly['severity'] } : {}), ...(type ? { type } : {}), limit: 100 }),
    [client, key],
    { live: true, pollMs: LIVE_POLL_MS },
  );
  useEffect(() => {
    setMore(null);
  }, [key]);

  const all = useMemo(() => {
    const byId = overrides.base === page.data ? overrides.byId : {};
    const seen = new Set<string>();
    const items = [...(page.data?.items ?? []), ...(more?.key === key ? more.items : [])]
      .filter((a) => !seen.has(a.id) && Boolean(seen.add(a.id)))
      .map((a) => byId[a.id] ?? a);
    const filtered = view === 'active' ? items.filter((a) => a.status !== 'resolved') : items;
    return filtered.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.openedAt.localeCompare(b.openedAt));
  }, [page.data, more, overrides, view, key]);
  const nextCursor = more?.key === key ? more.cursor : (page.data?.nextCursor ?? null);

  const types = useMemo(() => [...new Set(all.map((a) => a.type))].sort(), [all]);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const response = await client.listAnomalies({ ...(view === 'resolved' ? { status: 'resolved' as const } : {}), ...(severity ? { severity: severity as Anomaly['severity'] } : {}), ...(type ? { type } : {}), cursor: nextCursor, limit: 100 });
      setMore((m) => ({ key, items: [...(m?.key === key ? m.items : []), ...response.items], cursor: response.nextCursor }));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Page heading={t('anomalies.heading')}>
      <Section>
        <Stack direction="inline" gap="base">
          <Select
            label={t('anomalies.filter.status')}
            value={view}
            options={[
              { value: 'active', label: t('anomalies.filter.active') },
              { value: 'resolved', label: t('anomalies.filter.resolved') },
            ]}
            onChange={(v) => set('status', v === 'resolved' ? 'resolved' : '')}
            testId="anomalies-status"
          />
          <Select
            label={t('anomalies.filter.severity')}
            value={severity}
            options={[{ value: '', label: t('common.all') }, ...(['critical', 'warning', 'info'] as const).map((s) => ({ value: s, label: t(`severity.${s}`) }))]}
            onChange={(v) => set('severity', v)}
            testId="anomalies-severity"
          />
          <Select
            label={t('anomalies.filter.type')}
            value={type}
            options={[{ value: '', label: t('common.all') }, ...(type && !types.includes(type) ? [type] : types).map((x) => ({ value: x, label: tMaybe(`anomaly.type.${x}`) ?? t('anomalies.type.other') }))]}
            onChange={(v) => set('type', v)}
            testId="anomalies-type"
          />
        </Stack>
      </Section>

      {page.error ? (
        <ErrorState error={page.error} onRetry={page.reload} />
      ) : !page.data ? (
        <Loading />
      ) : all.length === 0 ? (
        <Section>
          <EmptyState heading={t('anomalies.empty.heading')}>{severity || type ? t('anomalies.empty.filtered') : t('anomalies.empty.active')}</EmptyState>
        </Section>
      ) : (
        <>
          {all.map((a) => (
            <AnomalyCard key={a.id} anomaly={a} locationName={locations.name(a.locationId)} onChanged={(updated) => setOverrides((o) => ({ base: page.data, byId: { ...(o.base === page.data ? o.byId : {}), [updated.id]: updated } }))} />
          ))}
          {nextCursor ? (
            <Section>
              <Button onPress={() => void loadMore()} loading={loadingMore}>
                {t('common.load_more')}
              </Button>
            </Section>
          ) : null}
        </>
      )}
    </Page>
  );
}
