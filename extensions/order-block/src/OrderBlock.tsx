import { useEffect, useRef } from 'preact/hooks';
import type { Gid, OrderAllocationsResponse } from '@serialis/contract';
import {
  ErrorBanner,
  Loading,
  OfflineBanner,
  useLivePolling,
  useOnline,
  useRefreshAfterAction,
  type LivePoll,
  useResource,
  type ApiClient,
  type Translate,
} from '@serialis/extensions-shared';
import {
  POLL_INTERVAL_MS,
  buildLineViews,
  canEdit,
  compactLines,
  quantityLabel,
  originKey,
  rowStatusView,
  shouldPoll,
  untrackedLineCount,
  type LineView,
  type UnitRow,
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
  /** Receives the collapsed summary of the block (`collapsedSummary` of `<s-admin-block>`). */
  onSummary?: (summary: string) => void;
  /** Reload rhythm after the action was opened (tests shorten it). */
  refreshMs?: number;
  /** Background refresh while visible (native admin actions notify nothing; tests shorten it). */
  livePoll?: LivePoll;
}

/**
 * Order block (spec 15.6): one row per unit under each tracked line, missing units, synchronization state.
 * Capped to 2 lines and 4 unit rows; the rest is counted next to « Modifier les unités » (DECISIONS.md).
 */
export function OrderBlock({ api, t, orderGid, onEdit, formatDateTime, pollMs = POLL_INTERVAL_MS, onSummary, refreshMs, livePoll }: OrderBlockProps) {
  const res = useResource((signal) => api.orderAllocations(orderGid, { signal }), [orderGid]);
  // The action modal tells the block nothing when it closes: reload for a while after opening it (recette 2,
  // extensions/DECISIONS.md 5), as the variant block does.
  const refreshAfterAction = useRefreshAfterAction(res.reload, refreshMs);
  const edit = () => {
    onEdit();
    refreshAfterAction();
  };
  // Fulfillments and order edits made in the native admin notify nothing (recette 3): light background refresh,
  // conditional (304 when unchanged), paused while the document is hidden (extensions/DECISIONS.md 8).
  useLivePolling(res.reload, livePoll);
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
  }, [syncState, res.loads, pollMs, reload]);

  const summary = res.status === 'ready' ? orderSummary(t, res.data) : '';
  useEffect(() => {
    if (summary) onSummary?.(summary);
  }, [summary, onSummary]);

  if (res.status === 'loading') return <Loading t={t} />;
  if (res.status === 'error') return <ErrorBanner t={t} error={res.error} onRetry={res.reload} />;

  const data = res.data;
  const lines = buildLineViews(data);
  const untracked = untrackedLineCount(data);
  const compact = compactLines(lines);
  const more = [
    compact.hiddenUnits > 0 ? t('orderBlock.moreUnits', { count: compact.hiddenUnits }) : null,
    compact.hiddenLines > 0 ? t('orderBlock.moreLines', { count: compact.hiddenLines }) : null,
    untracked > 0 && lines.length > 0 ? t('orderBlock.untrackedLines', { count: untracked }) : null,
  ].filter((x): x is string => x !== null);

  return (
    <s-stack gap="small-200">
      {!online ? <OfflineBanner t={t} /> : null}
      <SyncBanner t={t} data={data} formatDateTime={formatDateTime} stalled={!shouldPoll(data.syncState, polls.current) && data.syncState === 'pending'} />
      {lines.length === 0 ? (
        <s-text>{t('orderBlock.noTrackedLine')}</s-text>
      ) : (
        compact.shown.map((s) => <LineSection key={s.view.line.lineItemGid} t={t} view={s.view} rows={s.rows} paused={data.automationPaused === true} />)
      )}
      {canEdit(data) || more.length > 0 ? (
        <s-stack direction="inline" gap="small-200" alignItems="center">
          {canEdit(data) ? (
            <s-button variant="secondary" onClick={edit}>
              {t('orderBlock.edit')}
            </s-button>
          ) : null}
          {more.length > 0 ? <s-text color="subdued">{more.join(' · ')}</s-text> : null}
        </s-stack>
      ) : null}
    </s-stack>
  );
}

/** Collapsed summary of the block (`collapsedSummary`, 30 characters at most). */
export function orderSummary(t: Translate, data: OrderAllocationsResponse): string {
  if (data.syncState === 'pending') return t('orderBlock.pendingTitle');
  if (data.syncState === 'error') return t('orderBlock.errorTitle');
  const lines = buildLineViews(data);
  if (lines.length === 0) return '';
  const missing = lines.reduce((n, v) => n + v.missing, 0);
  return missing > 0 ? t('orderBlock.missing', { count: missing }) : t('orderBlock.allAllocated');
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

/** « × 2 », or « × 2 (3 ordered) » once the order was edited down (recette 3). */
function quantityText(t: Translate, view: LineView): string {
  const q = quantityLabel(view);
  return q.ordered === null ? t('orderBlock.quantity', { count: q.current }) : t('orderBlock.quantityOrdered', { count: q.current, ordered: q.ordered });
}

/** A tracked line: title, quantity and units to allocate on one row, then one compact row per shown unit. */
function LineSection({ t, view, rows, paused }: { t: Translate; view: LineView; rows: UnitRow[]; paused: boolean }) {
  const { line } = view;
  return (
    <s-stack gap="small-300">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-heading>{line.title}</s-heading>
        <s-text color="subdued">{quantityText(t, view)}</s-text>
        {view.returnPending > 0 ? <s-text color="subdued">{t('orderBlock.returnPending', { count: view.returnPending })}</s-text> : null}
        {view.returned > 0 ? <s-text color="subdued">{t('orderBlock.returnedCount', { count: view.returned })}</s-text> : null}
        {view.missing > 0 ? <s-badge tone="warning">{t('orderBlock.missing', { count: view.missing })}</s-badge> : null}
      </s-stack>
      {rows.length === 0 ? (
        <s-text>{t('orderBlock.noUnits')}</s-text>
      ) : (
        rows.map((row) =>
          row.kind === 'allocation' ? (
            <s-stack key={row.allocation.id} direction="inline" gap="small-300" alignItems="center">
              <s-text type="strong">{row.allocation.ref}</s-text>
              <s-badge tone={rowStatusView(row.allocation).tone}>{t(rowStatusView(row.allocation).key)}</s-badge>
              {row.allocation.toConfirm ? <s-badge tone="warning">{t('orderBlock.toConfirm')}</s-badge> : null}
              <s-text color="subdued">{t(originKey(row.allocation.source))}</s-text>
            </s-stack>
          ) : (
            <s-stack key={`missing-${row.position}`} direction="inline" gap="small-300" alignItems="center">
              <s-text>{t('orderBlock.toAllocate')}</s-text>
              {/* Emergency stop (P-02): the line waits for the resumption, not for a unit (workers/DECISIONS.md 77). */}
              <s-badge tone="warning">{t(paused ? 'orderBlock.status_paused' : 'orderBlock.status_missing')}</s-badge>
            </s-stack>
          ),
        )
      )}
    </s-stack>
  );
}
