import { useMemo, useState } from 'preact/hooks';
import type { Gid, Location, TrackedItem } from '@serialis/contract';
import {
  ErrorBanner,
  IdempotencyKeeper,
  Loading,
  OfflineBanner,
  addLocationOptions,
  buildAddPlan,
  codeMessage,
  defaultKind,
  gapAt,
  initialAddLocation,
  loadVariantData,
  summarizeBatch,
  toBatchRequest,
  useOnline,
  useResource,
  type AddKind,
  type AddPlan,
  type ApiClient,
  type BatchOutcome,
  type Translate,
} from '@serialis/extensions-shared';

export interface VariantActionProps {
  api: ApiClient;
  t: Translate;
  variantGid: Gid;
  /** Closes the action modal. */
  close: () => void;
}

/**
 * Variant action "Ajouter des refs" (spec 13.5, 15.5, 15.6): the add form opened from the variant block (or from
 * the "More actions" menu of the variant page). A modal has room for the form; the block keeps its compact summary.
 */
export function VariantAction({ api, t, variantGid, close }: VariantActionProps) {
  const res = useResource((signal) => loadVariantData(api, variantGid, signal), [variantGid]);
  const online = useOnline();
  const ready = res.status === 'ready' ? res.data : null;

  return (
    <s-admin-action heading={t('variantAction.heading')}>
      {ready?.item ? (
        <AddRefsForm
          api={api}
          t={t}
          variantGid={variantGid}
          item={ready.item}
          locations={ready.locations}
          knownRefs={ready.units.map((u) => u.ref)}
          online={online}
          reload={res.reload}
          close={close}
        />
      ) : (
        <>
          <s-stack gap="base">
            {!online ? <OfflineBanner t={t} /> : null}
            {res.status === 'loading' ? <Loading t={t} /> : null}
            {res.status === 'error' ? <ErrorBanner t={t} error={res.error} onRetry={res.reload} /> : null}
            {ready && !ready.item ? <s-text>{t('variantAction.notTracked')}</s-text> : null}
          </s-stack>
          <s-button slot="secondary-actions" onClick={close}>
            {t('common.close')}
          </s-button>
        </>
      )}
    </s-admin-action>
  );
}

// ---------------------------------------------------------------------------
// Form: location, received / already counted, pasted list, effect announced before confirmation (15.7)
// ---------------------------------------------------------------------------

type Step = 'edit' | 'confirm' | 'done';

function AddRefsForm(p: {
  api: ApiClient;
  t: Translate;
  variantGid: Gid;
  item: TrackedItem;
  locations: Location[];
  knownRefs: string[];
  online: boolean;
  reload: () => void;
  close: () => void;
}) {
  const { t, item } = p;
  const options = useMemo(() => addLocationOptions(item, p.locations), [item, p.locations]);
  const [locationId, setLocationId] = useState(() => initialAddLocation(item, options));
  const gap = locationId ? gapAt(item, locationId) : null;
  const [kind, setKind] = useState<AddKind>(() => defaultKind(gap, item.initializing));
  const [kindTouched, setKindTouched] = useState(false);
  const [text, setText] = useState('');
  const [step, setStep] = useState<Step>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<BatchOutcome | null>(null);
  const keeper = useMemo(() => new IdempotencyKeeper(), []);

  const plan = useMemo(() => buildAddPlan({ text, knownRefs: p.knownRefs, kind, gap }), [text, p.knownRefs, kind, gap]);
  const locationName = options.find((l) => l.id === locationId)?.name ?? locationId;
  const count = plan.readyRefs.length;
  const canSubmit = plan.blocked === null && p.online && !busy && locationId !== '';

  const edit = () => {
    setStep('edit');
    setError(null);
  };

  const changeLocation = (id: string) => {
    setLocationId(id);
    edit();
    // The default follows the location until the person picks a kind themselves.
    if (!kindTouched) setKind(defaultKind(gapAt(item, id), item.initializing));
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const req = toBatchRequest(plan, p.variantGid, locationId);
    try {
      const res = await p.api.createUnitsBatch(req, { idempotencyKey: keeper.keyFor(req) });
      keeper.done();
      const result = summarizeBatch(plan, res);
      setOutcome(result);
      setText(result.remainingText);
      // Everything added: show the result and offer to close; refused refs stay in the field for correction.
      setStep(result.rejected.length === 0 ? 'done' : 'edit');
      p.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const blockedMessage =
    plan.blocked === 'no_gap' ? t('variantAction.addNoGap')
    : plan.blocked === 'too_many' ? t('variantAction.addTooMany')
    : null;

  return (
    <>
      <s-stack gap="base">
        {!p.online ? <OfflineBanner t={t} /> : null}
        {outcome ? <OutcomeView t={t} outcome={outcome} done={step === 'done'} /> : null}

        {step !== 'done' ? (
          <>
            {options.length >= 2 ? (
              <s-select
                label={t('variantAction.addLocation')}
                value={locationId}
                disabled={busy || step === 'confirm'}
                onChange={(e: Event) => changeLocation((e.currentTarget as HTMLSelectElement).value)}
              >
                {options.map((l) => (
                  <s-option key={l.id} value={l.id}>
                    {l.name}
                  </s-option>
                ))}
              </s-select>
            ) : options.length === 1 ? (
              <s-text>{t('variantAction.addAt', { location: locationName })}</s-text>
            ) : (
              <s-banner tone="warning">
                <s-text>{t('variantAction.noLocation')}</s-text>
              </s-banner>
            )}

            {item.initializing ? <s-text color="subdued">{t('variantAction.initializingHint')}</s-text> : null}

            <s-choice-list
              label={t('variantAction.addKind')}
              name="kind"
              values={[kind]}
              disabled={busy || step === 'confirm'}
              onChange={(e: Event) => {
                const v = (e.currentTarget as unknown as { values?: string[] }).values?.[0];
                if (v === 'received' || v === 'already_counted') {
                  setKind(v);
                  setKindTouched(true);
                  edit();
                }
              }}
            >
              <s-choice value="already_counted">{t('variantAction.kindAlreadyCounted')}</s-choice>
              <s-choice value="received">{t('variantAction.kindReceived')}</s-choice>
            </s-choice-list>

            <s-text-area
              label={t('variantAction.addRefs')}
              details={t('variantAction.addRefsHelp')}
              rows={8}
              value={text}
              disabled={busy || step === 'confirm'}
              onInput={(e: Event) => {
                setText((e.currentTarget as HTMLTextAreaElement).value);
                edit();
              }}
            />

            {plan.lines.length > 0 ? <LinePreview t={t} plan={plan} /> : null}
            {blockedMessage ? (
              <s-banner tone="warning">
                <s-text>{blockedMessage}</s-text>
              </s-banner>
            ) : null}
            {plan.exceedsGap ? (
              <s-banner tone="warning">
                <s-text>{t('variantAction.addExceedsGap', { count, gap: gap ?? 0 })}</s-text>
              </s-banner>
            ) : null}
            {step === 'confirm' ? (
              <s-banner tone="info" heading={t('variantAction.confirmTitle')}>
                <s-text>
                  {plan.kind === 'received'
                    ? t('variantAction.effectReceived', { count, location: locationName })
                    : t('variantAction.effectCounted', { count, location: locationName })}
                </s-text>
              </s-banner>
            ) : null}
            {error ? <ErrorBanner t={t} error={error} /> : null}
          </>
        ) : null}
      </s-stack>

      {step === 'edit' ? (
        <>
          <s-button slot="primary-action" variant="primary" disabled={!canSubmit} onClick={() => setStep('confirm')}>
            {t('variantAction.confirmAdd', { count })}
          </s-button>
          <s-button slot="secondary-actions" disabled={busy} onClick={p.close}>
            {outcome ? t('common.close') : t('common.cancel')}
          </s-button>
        </>
      ) : step === 'confirm' ? (
        <>
          <s-button slot="primary-action" variant="primary" loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
            {t('variantAction.confirmSubmit', { count })}
          </s-button>
          <s-button slot="secondary-actions" disabled={busy} onClick={edit}>
            {t('common.back')}
          </s-button>
        </>
      ) : (
        <>
          <s-button slot="primary-action" variant="primary" onClick={p.close}>
            {t('common.close')}
          </s-button>
          <s-button
            slot="secondary-actions"
            onClick={() => {
              setOutcome(null);
              edit();
            }}
          >
            {t('variantAction.addMore')}
          </s-button>
        </>
      )}
    </>
  );
}

/** Live count of the pasted lines and the lines that will not be sent (duplicate, known, invalid). */
function LinePreview({ t, plan }: { t: Translate; plan: AddPlan }) {
  const { counts } = plan;
  const flagged = plan.lines.filter((l) => l.status !== 'ready');
  return (
    <s-stack gap="small-300">
      <s-text {...({ 'aria-live': 'polite' } as Record<string, unknown>)}>
        {t('variantAction.previewSummary', {
          ready: counts.ready,
          duplicate: counts.duplicate,
          known: counts.known,
          invalid: counts.invalid,
        })}
      </s-text>
      {flagged.length > 0 ? (
        <s-table>
          <s-table-header-row>
            <s-table-header>{t('variantAction.colRef')}</s-table-header>
            <s-table-header>{t('variantAction.colStatus')}</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {flagged.map((l) => (
              <s-table-row key={l.index}>
                <s-table-cell>{l.ref}</s-table-cell>
                <s-table-cell>
                  <s-badge tone="warning">{t(`variantAction.line_${l.status}`)}</s-badge>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      ) : null}
    </s-stack>
  );
}

function OutcomeView({ t, outcome, done }: { t: Translate; outcome: BatchOutcome; done: boolean }) {
  return (
    <s-banner tone={outcome.rejected.length === 0 ? 'success' : 'warning'} heading={t('variantAction.outcomeTitle', { count: outcome.created })}>
      {outcome.rejected.length > 0 ? (
        <s-stack gap="small-300">
          <s-text>{t('variantAction.outcomeRejected', { count: outcome.rejected.length })}</s-text>
          {outcome.rejected.map((r, i) => (
            <s-text key={`${r.ref}-${i}`}>
              {r.ref} : {codeMessage(t, r.code, r.detail)}
            </s-text>
          ))}
        </s-stack>
      ) : done ? (
        <s-text>{t('variantAction.doneHint')}</s-text>
      ) : null}
    </s-banner>
  );
}
