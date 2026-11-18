import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Gid, Location, TrackedItem } from '@serialis/contract';
import {
  ErrorBanner,
  IdempotencyKeeper,
  Loading,
  OfflineBanner,
  StateBadge,
  codeMessage,
  useOnline,
  useResource,
  type ApiClient,
  type Translate,
} from '@serialis/extensions-shared';
import {
  MAX_INLINE_REFS,
  MAX_LOCATION_ROWS,
  buildAddPlan,
  countStates,
  defaultKind,
  loadVariantData,
  pickLocations,
  recentUnits,
  summarizeBatch,
  summarizeLocations,
  toBatchRequest,
  totals,
  unitsAppHref,
  type AddKind,
  type BatchOutcome,
  type LocationSummary,
  type VariantData,
} from './logic';

export interface VariantBlockProps {
  api: ApiClient;
  t: Translate;
  variantGid: Gid;
  /** Receives the collapsed summary of the block (`collapsedSummary` of `<s-admin-block>`). */
  onSummary?: (summary: string) => void;
}

/**
 * Variant block (spec 15.6, 19.4): refs per location and state, gap with Shopify, adding refs, tracking.
 * Compact by design: the essential view fits the 300 px of a collapsed admin block (DECISIONS.md).
 */
export function VariantBlock({ api, t, variantGid, onSummary }: VariantBlockProps) {
  const res = useResource((signal) => loadVariantData(api, variantGid, signal), [variantGid]);
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
        <TrackedView api={api} t={t} variantGid={variantGid} data={data} item={data.item} online={online} reload={res.reload} />
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
// Tracked: compact summary (one line per location, 3 recent refs, actions), or the add form in its place
// ---------------------------------------------------------------------------

type TrackedMode = 'summary' | 'add' | 'untrack';

function TrackedView(p: {
  api: ApiClient;
  t: Translate;
  variantGid: Gid;
  data: VariantData;
  item: TrackedItem;
  online: boolean;
  reload: () => void;
}) {
  const { t, data, item } = p;
  const summaries = useMemo(() => summarizeLocations(item, data.units, data.locations), [item, data]);
  const [mode, setMode] = useState<TrackedMode>('summary');

  // The add form replaces the summary instead of stacking under it (block height, DECISIONS.md).
  if (mode === 'add') {
    return (
      <AddRefs
        api={p.api}
        t={t}
        variantGid={p.variantGid}
        item={item}
        locations={data.locations}
        summaries={summaries}
        knownRefs={data.units.map((u) => u.ref)}
        online={p.online}
        reload={p.reload}
        onBack={() => setMode('summary')}
      />
    );
  }

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
      {mode === 'untrack' ? (
        <Untrack api={p.api} t={t} variantGid={p.variantGid} online={p.online} reload={p.reload} onCancel={() => setMode('summary')} />
      ) : (
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-button variant="primary" onClick={() => setMode('add')}>
            {t('variantBlock.addTitle')}
          </s-button>
          {data.units.length > 0 ? (
            <s-button variant="tertiary" href={unitsAppHref(p.variantGid)}>
              {t('variantBlock.seeAllRefs', { count: data.units.length })}
            </s-button>
          ) : null}
          <s-button variant="tertiary" icon="menu-horizontal" accessibilityLabel={t('variantBlock.moreActions')} commandFor="serialis-variant-more" command="--toggle" />
          <s-menu id="serialis-variant-more" accessibilityLabel={t('variantBlock.moreActions')}>
            <s-button tone="critical" onClick={() => setMode('untrack')}>
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
// Add refs
// ---------------------------------------------------------------------------

function AddRefs(p: {
  api: ApiClient;
  t: Translate;
  variantGid: Gid;
  item: TrackedItem;
  locations: Location[];
  summaries: LocationSummary[];
  knownRefs: string[];
  online: boolean;
  reload: () => void;
  onBack: () => void;
}) {
  const { t } = p;
  const stockLocations = p.item.stock.map((s) => s.locationId);
  const options = p.locations.filter((l) => l.active || stockLocations.includes(l.id));
  const firstWithGap = p.summaries.find((s) => s.gap !== null && s.gap > 0 && s.locationId !== null);
  const [locationId, setLocationId] = useState<string>(
    firstWithGap?.locationId ?? options[0]?.id ?? stockLocations[0] ?? '',
  );
  const gap = p.item.stock.find((s) => s.locationId === locationId);
  const gapValue = gap ? gap.shopifyOnHand - gap.registeredUnits : null;
  const [kind, setKind] = useState<AddKind>(defaultKind(gapValue, p.item.initializing));
  const [kindTouched, setKindTouched] = useState(false);
  const [text, setText] = useState('');
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<BatchOutcome | null>(null);
  const keeper = useMemo(() => new IdempotencyKeeper(), []);

  const plan = useMemo(
    () => buildAddPlan({ text, knownRefs: p.knownRefs, kind, gap: gapValue }),
    [text, p.knownRefs, kind, gapValue],
  );
  const locationName = options.find((l) => l.id === locationId)?.name ?? locationId;

  const changeLocation = (id: string) => {
    setLocationId(id);
    setStep('edit');
    if (!kindTouched) {
      const g = p.item.stock.find((s) => s.locationId === id);
      setKind(defaultKind(g ? g.shopifyOnHand - g.registeredUnits : null, p.item.initializing));
    }
  };

  const submit = async () => {
    if (busy || !p.online || plan.blocked) return;
    setBusy(true);
    setError(null);
    const req = toBatchRequest(plan, p.variantGid, locationId);
    try {
      const res = await p.api.createUnitsBatch(req, { idempotencyKey: keeper.keyFor(req) });
      keeper.done();
      const result = summarizeBatch(plan, res);
      setOutcome(result);
      setText(result.remainingText);
      setStep('edit');
      p.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const blockedMessage =
    plan.blocked === 'no_gap' ? t('variantBlock.addNoGap')
    : plan.blocked === 'too_many' ? t('variantBlock.addTooMany')
    : null;

  return (
    <s-stack gap="small-200">
      {/* Heading and location on one row: the form replaces the summary and stays within the block budget. */}
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-heading>{t('variantBlock.addTitle')}</s-heading>
        {options.length > 1 ? (
          <s-select
            label={t('variantBlock.addLocation')}
            labelAccessibilityVisibility="exclusive"
            value={locationId}
            disabled={busy}
            onChange={(e: Event) => changeLocation((e.currentTarget as HTMLSelectElement).value)}
          >
            {options.map((l) => (
              <s-option key={l.id} value={l.id}>
                {l.name}
              </s-option>
            ))}
          </s-select>
        ) : (
          <s-text color="subdued">{t('variantBlock.addAt', { location: locationName })}</s-text>
        )}
      </s-stack>
      {outcome ? <OutcomeView t={t} outcome={outcome} /> : null}
      <s-choice-list
        label={t('variantBlock.addKind')}
        name="kind"
        values={[kind]}
        disabled={busy}
        onChange={(e: Event) => {
          const v = (e.currentTarget as unknown as { values?: string[] }).values?.[0];
          if (v === 'received' || v === 'already_counted') {
            setKind(v);
            setKindTouched(true);
            setStep('edit');
          }
        }}
      >
        <s-choice value="already_counted">{t('variantBlock.kindAlreadyCounted')}</s-choice>
        <s-choice value="received">{t('variantBlock.kindReceived')}</s-choice>
      </s-choice-list>
      <s-text-area
        label={t('variantBlock.addRefs')}
        details={t('variantBlock.addRefsHelp')}
        rows={3}
        value={text}
        disabled={busy}
        onInput={(e: Event) => {
          setText((e.currentTarget as HTMLTextAreaElement).value);
          setStep('edit');
        }}
      />

      {plan.lines.length > 0 ? <LinePreview t={t} plan={plan} /> : null}
      {blockedMessage ? <s-banner tone="warning"><s-text>{blockedMessage}</s-text></s-banner> : null}
      {plan.exceedsGap ? (
        <s-banner tone="warning">
          <s-text>{t('variantBlock.addExceedsGap', { count: plan.readyRefs.length, gap: gapValue ?? 0 })}</s-text>
        </s-banner>
      ) : null}
      {error ? <ErrorBanner t={t} error={error} /> : null}

      {step === 'edit' ? (
        <s-stack direction="inline" gap="small-200">
          <s-button variant="primary" disabled={plan.blocked !== null || !p.online} onClick={() => setStep('confirm')}>
            {t('variantBlock.addReview', { count: plan.readyRefs.length })}
          </s-button>
          <s-button variant="secondary" disabled={busy} onClick={p.onBack}>
            {t('variantBlock.addBack')}
          </s-button>
        </s-stack>
      ) : (
        <s-banner tone="info" heading={t('variantBlock.confirmTitle')}>
          <s-stack gap="small-200">
            <s-text>
              {plan.kind === 'received'
                ? t('variantBlock.effectReceived', { count: plan.readyRefs.length, location: locationName })
                : t('variantBlock.effectCounted', { count: plan.readyRefs.length, location: locationName })}
            </s-text>
            <s-stack direction="inline" gap="small-200">
              <s-button variant="primary" loading={busy} disabled={busy || !p.online} onClick={submit}>
                {t('variantBlock.confirmAdd', { count: plan.readyRefs.length })}
              </s-button>
              <s-button variant="secondary" disabled={busy} onClick={() => setStep('edit')}>
                {t('common.cancel')}
              </s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      )}
    </s-stack>
  );
}

function LinePreview({ t, plan }: { t: Translate; plan: ReturnType<typeof buildAddPlan> }) {
  const { counts } = plan;
  return (
    <s-stack gap="small-300">
      <s-text {...({ 'aria-live': 'polite' } as Record<string, unknown>)}>
        {t('variantBlock.previewSummary', {
          ready: counts.ready,
          duplicate: counts.duplicate,
          known: counts.known,
          invalid: counts.invalid,
        })}
      </s-text>
      {plan.lines.some((l) => l.status !== 'ready') ? (
        <s-table>
          <s-table-header-row>
            <s-table-header>{t('variantBlock.colRef')}</s-table-header>
            <s-table-header>{t('variantBlock.colStatus')}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {plan.lines
              .filter((l) => l.status !== 'ready')
              .map((l) => (
                <s-table-row key={l.index}>
                  <s-table-cell>{l.ref}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone="warning">{t(`variantBlock.line_${l.status}`)}</s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
          </s-table-body>
        </s-table>
      ) : null}
    </s-stack>
  );
}

function OutcomeView({ t, outcome }: { t: Translate; outcome: BatchOutcome }) {
  return (
    <s-banner tone={outcome.rejected.length === 0 ? 'success' : 'warning'} heading={t('variantBlock.outcomeTitle', { count: outcome.created })}>
      {outcome.rejected.length > 0 ? (
        <s-stack gap="small-300">
          <s-text>{t('variantBlock.outcomeRejected', { count: outcome.rejected.length })}</s-text>
          {outcome.rejected.map((r, i) => (
            <s-text key={`${r.ref}-${i}`}>
              {r.ref} : {codeMessage(t, r.code, r.detail)}
            </s-text>
          ))}
        </s-stack>
      ) : null}
    </s-banner>
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

