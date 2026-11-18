import { useEffect, useRef } from 'preact/hooks';
import type { Gid, OrderAllocationsResponse } from '@serialis/contract';
import {
  ErrorBanner,
  Loading,
  OfflineBanner,
  useOnline,
  useResource,
  type ApiClient,
  type Translate,
} from '@serialis/extensions-shared';
import {
  POLL_INTERVAL_MS,
  buildLineViews,
  canEdit,
  originKey,
  shouldPoll,
  statusView,
  untrackedLineCount,
  type LineView,
} from './logic';

export interface OrderBlockProps {
  api: ApiClient;
  t: Translate;
  orderGid: Gid;
  /** Opens the "Modifier les unités" action (navigation to the action extension). */
  onEdit: () => void;
  /** Formats the last synchronization time in the user's locale. */
  formatDateTime?: (iso: string) => string;
  pollMs?: number;
}

/** Order block (spec 15.6): one row per unit under each tracked line, missing units, synchronization state. */
export function OrderBlock({ api, t, orderGid, onEdit, formatDateTime, pollMs = POLL_INTERVAL_MS }: OrderBlockProps) {
  const res = useResource((signal) => api.orderAllocations(orderGid, { signal }), [orderGid]);
  const online = useOnline();
  const polls = useRef(0);

  const syncState = res.status === 'ready' ? res.data.syncState : null;
  const { reload } = res;
  useEffect(() => {
    if (syncState === null || !shouldPoll(syncState, polls.current)) return;
    const id = setTimeout(() => {
      polls.current += 1;
      reload();
    }, pollMs);
    return () => clearTimeout(id);
  }, [syncState, res.status === 'ready' ? res.data : null, pollMs, reload]);

  if (res.status === 'loading') return <Loading t={t} />;
  if (res.status === 'error') return <ErrorBanner t={t} error={res.error} onRetry={res.reload} />;

  const data = res.data;
  const lines = buildLineViews(data);
  const untracked = untrackedLineCount(data);

  return (
    <s-stack gap="base">
      {!online ? <OfflineBanner t={t} /> : null}
      <SyncBanner t={t} data={data} formatDateTime={formatDateTime} stalled={!shouldPoll(data.syncState, polls.current) && data.syncState === 'pending'} />
      {lines.length === 0 ? (
        <s-text>{t('orderBlock.noTrackedLine')}</s-text>
      ) : (
        lines.map((v) => <LineSection key={v.line.lineItemGid} t={t} view={v} />)
      )}
      {untracked > 0 && lines.length > 0 ? <s-text color="subdued">{t('orderBlock.untrackedLines', { count: untracked })}</s-text> : null}
      {canEdit(data) ? (
        <s-stack direction="inline">
          <s-button variant="secondary" onClick={onEdit}>
            {t('orderBlock.edit')}
          </s-button>
        </s-stack>
      ) : null}
    </s-stack>
  );
}

function SyncBanner(p: {
  t: Translate;
  data: OrderAllocationsResponse;
  formatDateTime: ((iso: string) => string) | undefined;
  stalled: boolean;
}) {
  const { t, data } = p;
  if (data.syncState === 'pending') {
    return (
      <s-banner tone="info" heading={t('orderBlock.pendingTitle')}>
        <s-text>{p.stalled ? t('orderBlock.pendingStalled') : t('orderBlock.pendingBody')}</s-text>
      </s-banner>
    );
  }
  if (data.syncState === 'error') {
    return (
      <s-banner tone="critical" heading={t('orderBlock.errorTitle')}>
        <s-text>{t('orderBlock.errorBody')}</s-text>
      </s-banner>
    );
  }
  if (data.syncedAt) {
    const when = p.formatDateTime ? p.formatDateTime(data.syncedAt) : data.syncedAt;
    return <s-text color="subdued">{t('orderBlock.syncedAt', { when })}</s-text>;
  }
  return null;
}

function LineSection({ t, view }: { t: Translate; view: LineView }) {
  const { line, rows } = view;
  return (
    <s-stack gap="small-300">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-heading>{line.title}</s-heading>
        <s-text color="subdued">{t('orderBlock.quantity', { count: line.quantity })}</s-text>
        {view.missing > 0 ? <s-badge tone="warning">{t('orderBlock.missing', { count: view.missing })}</s-badge> : null}
      </s-stack>
      {rows.length === 0 ? (
        <s-text>{t('orderBlock.noUnits')}</s-text>
      ) : (
        <s-table>
          <s-table-header-row>
            <s-table-header>{t('orderBlock.colRef')}</s-table-header>
            <s-table-header>{t('orderBlock.colState')}</s-table-header>
            <s-table-header>{t('orderBlock.colOrigin')}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((row) =>
              row.kind === 'allocation' ? (
                <s-table-row key={row.allocation.id}>
                  <s-table-cell>{row.allocation.ref}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-300">
                      <s-badge tone={statusView(row.allocation.status).tone}>{t(statusView(row.allocation.status).key)}</s-badge>
                      {row.allocation.toConfirm ? <s-badge tone="warning">{t('orderBlock.toConfirm')}</s-badge> : null}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{t(originKey(row.allocation.source))}</s-table-cell>
                </s-table-row>
              ) : (
                <s-table-row key={`missing-${row.position}`}>
                  <s-table-cell>{t('orderBlock.toAllocate')}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone="warning">{t('orderBlock.status_missing')}</s-badge>
                  </s-table-cell>
                  <s-table-cell>–</s-table-cell>
                </s-table-row>
              ),
            )}
          </s-table-body>
        </s-table>
      )}
    </s-stack>
  );
}
