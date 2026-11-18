import { useMemo, useState } from 'preact/hooks';
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
  buildAddPlan,
  defaultKind,
  filterUnits,
  loadVariantData,
  summarizeBatch,
  summarizeLocations,
  toBatchRequest,
  type AddKind,
  type BatchOutcome,
  type LocationSummary,
  type VariantData,
} from './logic';

const LIST_PAGE = 25;

export interface VariantBlockProps {
  api: ApiClient;
  t: Translate;
  variantGid: Gid;
}

/** Variant block (spec 15.6, 19.4): refs per location and state, gap with Shopify, adding refs, tracking. */
export function VariantBlock({ api, t, variantGid }: VariantBlockProps) {
  const res = useResource((signal) => loadVariantData(api, variantGid, signal), [variantGid]);
  const online = useOnline();

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
// Tracked: summary table, units list, add refs, untrack
// ---------------------------------------------------------------------------

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

  return (
    <s-stack gap="large-100">
      {item.initializing ? (
        <s-banner tone="info" heading={t('variantBlock.initializingTitle')}>
          <s-text>{t('variantBlock.initializingBody')}</s-text>
        </s-banner>
      ) : null}
      {data.truncated ? (
        <s-banner tone="warning">
          <s-text>{t('variantBlock.truncated', { count: data.units.length })}</s-text>
        </s-banner>
      ) : null}
      <LocationTable t={t} summaries={summaries} />
      <UnitList t={t} data={data} />
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
      />
      <Untrack api={p.api} t={t} variantGid={p.variantGid} online={p.online} reload={p.reload} />
    </s-stack>
  );
}

function gapLabel(t: Translate, s: LocationSummary): string {
  if (s.gap === null) return '';
  if (s.gap === 0) return t('variantBlock.gapNone');
  return s.gap > 0 ? t('variantBlock.gapToRegister', { count: s.gap }) : t('variantBlock.gapExtra', { count: -s.gap });
}

function LocationTable({ t, summaries }: { t: Translate; summaries: LocationSummary[] }) {
  if (summaries.length === 0) return <s-text>{t('variantBlock.noStock')}</s-text>;
  return (
    <s-stack gap="small-300">
      <s-heading>{t('variantBlock.byLocation')}</s-heading>
      <s-table>
        <s-table-header-row>
          <s-table-header>{t('variantBlock.colLocation')}</s-table-header>
          <s-table-header>{t('variantBlock.colShopify')}</s-table-header>
          <s-table-header>{t('variantBlock.colRegistered')}</s-table-header>
          <s-table-header>{t('variantBlock.colGap')}</s-table-header>
          <s-table-header>{t('variantBlock.colStates')}</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {summaries.map((s) => (
            <s-table-row key={s.locationId ?? 'none'}>
              <s-table-cell>{s.name ?? t('variantBlock.noLocation')}</s-table-cell>
              <s-table-cell>{s.shopifyOnHand ?? '–'}</s-table-cell>
              <s-table-cell>{s.registeredUnits ?? s.total}</s-table-cell>
              <s-table-cell>
                {s.gap === null ? '–' : <s-badge tone={s.gap === 0 ? 'success' : s.gap > 0 ? 'warning' : 'critical'}>{gapLabel(t, s)}</s-badge>}
              </s-table-cell>
              <s-table-cell>
                <s-stack direction="inline" gap="small-300">
                  {s.counts.map((c) => (
                    <s-stack key={c.state} direction="inline" gap="small-400" alignItems="center">
                      <StateBadge t={t} state={c.state} />
                      <s-text>{c.count}</s-text>
                    </s-stack>
                  ))}
                </s-stack>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-stack>
  );
}

function UnitList({ t, data }: { t: Translate; data: VariantData }) {
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(LIST_PAGE);
  const names = useMemo(() => new Map(data.locations.map((l) => [l.id, l.name])), [data.locations]);
  const filtered = useMemo(() => filterUnits(data.units, query), [data.units, query]);

  if (data.units.length === 0) {
    return (
      <s-stack gap="small-300">
        <s-heading>{t('variantBlock.refsTitle')}</s-heading>
        <s-text>{t('variantBlock.refsEmpty')}</s-text>
      </s-stack>
    );
  }
  return (
    <s-stack gap="small-300">
      <s-heading>{t('variantBlock.refsTitle')}</s-heading>
      <s-search-field
        label={t('variantBlock.refsSearch')}
        labelAccessibilityVisibility="exclusive"
        value={query}
        onInput={(e: Event) => {
          setQuery((e.currentTarget as HTMLInputElement).value);
          setShown(LIST_PAGE);
        }}
      />
      {filtered.length === 0 ? (
        <s-text>{t('variantBlock.refsNoMatch')}</s-text>
      ) : (
        <s-table>
          <s-table-header-row>
            <s-table-header>{t('variantBlock.colRef')}</s-table-header>
            <s-table-header>{t('variantBlock.colState')}</s-table-header>
            <s-table-header>{t('variantBlock.colLocation')}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {filtered.slice(0, shown).map((u) => (
              <s-table-row key={u.id}>
                <s-table-cell>{u.ref}</s-table-cell>
                <s-table-cell>
                  <StateBadge t={t} state={u.state} />
                </s-table-cell>
                <s-table-cell>{u.locationId ? (names.get(u.locationId) ?? u.locationId) : t('variantBlock.noLocation')}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      )}
      {filtered.length > shown ? (
        <s-button variant="secondary" onClick={() => setShown(shown + LIST_PAGE)}>
          {t('variantBlock.showMore', { count: filtered.length - shown })}
        </s-button>
      ) : null}
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
    <s-stack gap="base">
      <s-heading>{t('variantBlock.addTitle')}</s-heading>
      {outcome ? <OutcomeView t={t} outcome={outcome} /> : null}
      <s-select
        label={t('variantBlock.addLocation')}
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
        rows={5}
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
        <s-button variant="primary" disabled={plan.blocked !== null || !p.online} onClick={() => setStep('confirm')}>
          {t('variantBlock.addReview', { count: plan.readyRefs.length })}
        </s-button>
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

function Untrack(p: { api: ApiClient; t: Translate; variantGid: Gid; online: boolean; reload: () => void }) {
  const { t } = p;
  const [step, setStep] = useState<'idle' | 'confirm'>('idle');
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

  if (step === 'idle') {
    return (
      <s-button variant="tertiary" tone="critical" onClick={() => setStep('confirm')}>
        {t('variantBlock.untrack')}
      </s-button>
    );
  }
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
            <s-button variant="secondary" disabled={busy} onClick={() => setStep('idle')}>
              {t('common.cancel')}
            </s-button>
          </s-stack>
        </s-stack>
      </s-banner>
    </s-stack>
  );
}

