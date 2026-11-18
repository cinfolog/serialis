import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Gid, TrackedItem } from '@serialis/contract';
import {
  ErrorBanner,
  IdempotencyKeeper,
  Loading,
  OfflineBanner,
  StateBadge,
  useOnline,
  useRefreshAfterAction,
  useResource,
  type ApiClient,
  type Translate,
} from '@serialis/extensions-shared';
import {
  MAX_INLINE_REFS,
  MAX_LOCATION_ROWS,
  countStates,
  loadVariantData,
  pickLocations,
  recentUnits,
  summarizeLocations,
  totals,
  unitsAppHref,
  type LocationSummary,
  type VariantData,
} from './logic';

export interface VariantBlockProps {
  api: ApiClient;
  t: Translate;
  variantGid: Gid;
  /** Receives the collapsed summary of the block (`collapsedSummary` of `<s-admin-block>`). */
  onSummary?: (summary: string) => void;
  /**
   * Opens the "Ajouter des refs" action modal (`shopify.navigation.navigate`). Absent when navigation is unavailable:
   * the button then links to the add form of the app's Units screen.
   */
  onAddRefs?: () => void;
  /** Reload rhythm after the action was opened (tests shorten it). */
  refreshMs?: number;
}

/**
 * Variant block (spec 15.6, 19.4): refs per location and state, gap with Shopify, adding refs, tracking.
 * Compact by design: the essential view fits the 300 px of a collapsed admin block (DECISIONS.md).
 */
export function VariantBlock({ api, t, variantGid, onSummary, onAddRefs, refreshMs }: VariantBlockProps) {
  const res = useResource((signal) => loadVariantData(api, variantGid, signal), [variantGid]);
  // The modal tells the block nothing when it closes: reload for a while after opening it (DECISIONS.md, decision 2).
  const refreshAfterAction = useRefreshAfterAction(res.reload, refreshMs);
  const openAdd = onAddRefs
    ? () => {
        onAddRefs();
        refreshAfterAction();
      }
    : null;
  const online = useOnline();
  const summary = res.status === 'ready' ? collapsedSummary(t, res.data) : '';
  useEffect(() => {
    if (summary) onSummary?.(summary);
  }, [summary, onSummary]);

  if (res.status === 'loading') return <Loading t={t} />;
  if (res.status === 'error') return <ErrorBanner t={t} error={res.error} onRetry={res.reload} />;
  const data = res.data;

  return (
    <s-stack gap="base">
      {!online ? <OfflineBanner t={t} /> : null}
      {data.item ? (
        <TrackedView api={api} t={t} variantGid={variantGid} data={data} item={data.item} online={online} reload={res.reload} openAdd={openAdd} />
      ) : (
        <UntrackedView api={api} t={t} variantGid={variantGid} online={online} reload={res.reload} />
      )}
    </s-stack>
  );
}

// ---------------------------------------------------------------------------
// Not tracked: offer to follow refs (POST /tracked-items)
// ---------------------------------------------------------------------------

function UntrackedView(p: { api: ApiClient; t: Translate; variantGid: Gid; online: boolean; reload: () => void }) {
  const { t } = p;
  const [step, setStep] = useState<'idle' | 'confirm'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const keeper = useMemo(() => new IdempotencyKeeper(), []);

  const track = async () => {
    if (busy || !p.online) return;
    setBusy(true);
    setError(null);
    try {
      await p.api.trackVariants([p.variantGid], {}, { idempotencyKey: keeper.keyFor({ track: p.variantGid }) });
      keeper.done();
      p.reload();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <s-stack gap="base">
      <s-text>{t('variantBlock.notTracked')}</s-text>
      {error ? <ErrorBanner t={t} error={error} /> : null}
      {step === 'idle' ? (
        <s-button variant="primary" onClick={() => setStep('confirm')}>
          {t('variantBlock.track')}
        </s-button>
      ) : (
        <s-banner tone="info" heading={t('variantBlock.trackConfirmTitle')}>
          <s-stack gap="small-200">
            <s-text>{t('variantBlock.trackEffect')}</s-text>
            <s-stack direction="inline" gap="small-200">
              <s-button variant="primary" loading={busy} disabled={busy || !p.online} onClick={track}>
                {t('variantBlock.trackConfirm')}
              </s-button>
              <s-button variant="secondary" disabled={busy} onClick={() => setStep('idle')}>
                {t('common.cancel')}
              </s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      )}
    </s-stack>
  );
}

// ---------------------------------------------------------------------------
// Tracked: compact summary (one line per location, 3 recent refs, actions); adding refs opens the action modal
// ---------------------------------------------------------------------------

function TrackedView(p: {
  api: ApiClient;
  t: Translate;
  variantGid: Gid;
  data: VariantData;
  item: TrackedItem;
  online: boolean;
  reload: () => void;
  /** Opens the add action; null: link to the app instead. */
  openAdd: (() => void) | null;
}) {
  const { t, data, item } = p;
  const summaries = useMemo(() => summarizeLocations(item, data.units, data.locations), [item, data]);
  const [untracking, setUntracking] = useState(false);

  const gap = totals(item).gap;
  return (
    <s-stack gap="small-200">
      {data.truncated ? (
        <s-banner tone="warning">
          <s-text>{t('variantBlock.truncated', { count: data.units.length })}</s-text>
        </s-banner>
      ) : null}
      {item.initializing && gap > 0 ? <s-text color="subdued">{t('variantBlock.initializingHint')}</s-text> : null}
      <Locations t={t} summaries={summaries} />
      {/* With the location table (3+ locations) there is no room left for refs: the link opens the full list. */}
      <RecentRefs t={t} data={data} max={summaries.length >= MAX_LOCATION_ROWS ? 0 : MAX_INLINE_REFS} />
      {untracking ? (
        <Untrack api={p.api} t={t} variantGid={p.variantGid} online={p.online} reload={p.reload} onCancel={() => setUntracking(false)} />
      ) : (
        <s-stack direction="inline" gap="small-200" alignItems="center">
          {p.openAdd ? (
            <s-button variant="primary" onClick={p.openAdd}>
              {t('variantBlock.addTitle')}
            </s-button>
          ) : (
            <s-button variant="primary" href={unitsAppHref(p.variantGid, { add: true })}>
              {t('variantBlock.addTitle')}
            </s-button>
          )}
          {data.units.length > 0 ? (
            <s-button variant="tertiary" href={unitsAppHref(p.variantGid)}>
              {t('variantBlock.seeAllRefs', { count: data.units.length })}
            </s-button>
          ) : null}
          <s-button variant="tertiary" icon="menu-horizontal" accessibilityLabel={t('variantBlock.moreActions')} commandFor="serialis-variant-more" command="--toggle" />
          <s-menu id="serialis-variant-more" accessibilityLabel={t('variantBlock.moreActions')}>
            <s-button tone="critical" onClick={() => setUntracking(true)}>
              {t('variantBlock.untrack')}
            </s-button>
          </s-menu>
        </s-stack>
      )}
    </s-stack>
  );
}

function gapLabel(t: Translate, gap: number): string {
  if (gap === 0) return t('variantBlock.gapNone');
  return gap > 0 ? t('variantBlock.gapToRegister', { count: gap }) : t('variantBlock.gapExtra', { count: -gap });
}

function GapBadge({ t, gap }: { t: Translate; gap: number | null }) {
  if (gap === null) return null;
  return <s-badge tone={gap === 0 ? 'success' : gap > 0 ? 'warning' : 'critical'}>{gapLabel(t, gap)}</s-badge>;
}

/** Collapsed summary of the block (`collapsedSummary`, 30 characters at most): « 3 refs · 2 à enregistrer ». */
export function collapsedSummary(t: Translate, data: VariantData): string {
  if (!data.item) return t('variantBlock.notTrackedShort');
  const { registered, gap } = totals(data.item);
  return t('variantBlock.collapsed', { refs: t('variantBlock.refsCount', { count: registered }), status: gapLabel(t, gap) });
}

/** One line per location (« Entrepôt · Shopify 10 · 0 ref [10 à enregistrer] »); a capped table from 3 locations. */
function Locations({ t, summaries }: { t: Translate; summaries: LocationSummary[] }) {
  if (summaries.length === 0) return <s-text>{t('variantBlock.noStock')}</s-text>;
  const name = (s: LocationSummary) => s.name ?? t('variantBlock.noLocation');
  const refs = (s: LocationSummary) => s.registeredUnits ?? s.total;
  if (summaries.length < MAX_LOCATION_ROWS) {
    return (
      <s-stack gap="small-300">
        {summaries.map((s) => (
          <s-stack key={s.locationId ?? 'none'} direction="inline" gap="small-300" alignItems="center">
            <s-text>
              {s.shopifyOnHand === null
                ? t('variantBlock.locationLineNoStock', { location: name(s), refs: t('variantBlock.refsCount', { count: refs(s) }) })
                : t('variantBlock.locationLine', { location: name(s), onHand: s.shopifyOnHand, refs: t('variantBlock.refsCount', { count: refs(s) }) })}
            </s-text>
            <GapBadge t={t} gap={s.gap} />
          </s-stack>
        ))}
      </s-stack>
    );
  }
  const { shown, hidden } = pickLocations(summaries);
  return (
    <s-stack gap="small-300">
      <s-table>
        <s-table-header-row>
          <s-table-header>{t('variantBlock.colLocation')}</s-table-header>
          <s-table-header>{t('variantBlock.colShopify')}</s-table-header>
          <s-table-header>{t('variantBlock.colRegistered')}</s-table-header>
          <s-table-header>{t('variantBlock.colGap')}</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {shown.map((s) => (
            <s-table-row key={s.locationId ?? 'none'}>
              <s-table-cell>{name(s)}</s-table-cell>
              <s-table-cell>{s.shopifyOnHand ?? '–'}</s-table-cell>
              <s-table-cell>{refs(s)}</s-table-cell>
              <s-table-cell>{s.gap === null ? '–' : <GapBadge t={t} gap={s.gap} />}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
      {hidden > 0 ? <s-text color="subdued">{t('variantBlock.otherLocations', { count: hidden })}</s-text> : null}
    </s-stack>
  );
}

/** Counts by state on one line, then the `max` most recent refs; the full list is in the app. */
function RecentRefs({ t, data, max }: { t: Translate; data: VariantData; max: number }) {
  const names = useMemo(() => new Map(data.locations.map((l) => [l.id, l.name])), [data.locations]);
  const recent = useMemo(() => recentUnits(data.units, max), [data.units, max]);
  const states = useMemo(() => countStates(data.units), [data.units]);
  if (data.units.length === 0) return <s-text color="subdued">{t('variantBlock.refsEmpty')}</s-text>;
  return (
    <s-stack gap="small-300">
      <s-stack direction="inline" gap="small-300" alignItems="center">
        {states.map((c) => (
          <s-stack key={c.state} direction="inline" gap="small-400" alignItems="center">
            <StateBadge t={t} state={c.state} />
            <s-text>{c.count}</s-text>
          </s-stack>
        ))}
      </s-stack>
      {recent.map((u) => (
        <s-stack key={u.id} direction="inline" gap="small-300" alignItems="center">
          <s-text type="strong">{u.ref}</s-text>
          <StateBadge t={t} state={u.state} />
          <s-text color="subdued">{u.locationId ? (names.get(u.locationId) ?? u.locationId) : t('variantBlock.noLocation')}</s-text>
        </s-stack>
      ))}
    </s-stack>
  );
}

// ---------------------------------------------------------------------------
// Untrack (EF-01): effect announced before confirmation
// ---------------------------------------------------------------------------

function Untrack(p: { api: ApiClient; t: Translate; variantGid: Gid; online: boolean; reload: () => void; onCancel: () => void }) {
  const { t } = p;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const keeper = useMemo(() => new IdempotencyKeeper(), []);

  const untrack = async () => {
    if (busy || !p.online) return;
    setBusy(true);
    setError(null);
    try {
      await p.api.untrackVariants([p.variantGid], { idempotencyKey: keeper.keyFor({ untrack: p.variantGid }) });
      keeper.done();
      p.reload();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <s-stack gap="small-200">
      {error ? <ErrorBanner t={t} error={error} /> : null}
      <s-banner tone="warning" heading={t('variantBlock.untrackConfirmTitle')}>
        <s-stack gap="small-200">
          <s-text>{t('variantBlock.untrackEffect')}</s-text>
          <s-stack direction="inline" gap="small-200">
            <s-button tone="critical" variant="primary" loading={busy} disabled={busy || !p.online} onClick={untrack}>
              {t('variantBlock.untrackConfirm')}
            </s-button>
            <s-button variant="secondary" disabled={busy} onClick={p.onCancel}>
              {t('common.cancel')}
            </s-button>
          </s-stack>
        </s-stack>
      </s-banner>
    </s-stack>
  );
}

