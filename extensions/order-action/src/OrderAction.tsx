import { useMemo, useState } from 'preact/hooks';
import type { Allocation, Gid, Location, Unit } from '@serialis/contract';
import {
  ApiError,
  DesignationInput,
  ErrorBanner,
  IdempotencyKeeper,
  Loading,
  OfflineBanner,
  StateBadge,
  useOnline,
  useResource,
  type ApiClient,
  type Resolution,
  type Translate,
} from '@serialis/extensions-shared';
import {
  describeEffect,
  editableLines,
  isEditable,
  loadCandidates,
  planCall,
  runCall,
  type Choice,
  type Line,
  type PanelAction,
} from './logic';

export interface OrderActionProps {
  api: ApiClient;
  t: Translate;
  orderGid: Gid;
  /** Closes the action modal. */
  close: () => void;
}

/** Order action "Modifier les unités" (spec 15.6, MVP): allocate, replace or remove an allocation of a tracked line. */
export function OrderAction({ api, t, orderGid, close }: OrderActionProps) {
  const res = useResource(async (signal) => {
    const [allocations, locations] = await Promise.all([
      api.orderAllocations(orderGid, { signal }),
      api.listLocations({ signal }).catch((): null => null),
    ]);
    return { allocations, locations: locations?.items ?? [] };
  }, [orderGid]);
  const online = useOnline();
  const [panel, setPanel] = useState<PanelAction | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const onDone = (messageKey: string) => {
    setPanel(null);
    setDone(messageKey);
    res.reload();
  };

  return (
    <s-admin-action heading={t('orderAction.heading')}>
      <s-stack gap="base">
        {!online ? <OfflineBanner t={t} /> : null}
        {done ? (
          <s-banner tone="success" dismissible onDismiss={() => setDone(null)}>
            <s-text>{t(done)}</s-text>
          </s-banner>
        ) : null}
        {res.status === 'loading' ? <Loading t={t} /> : null}
        {res.status === 'error' ? <ErrorBanner t={t} error={res.error} onRetry={res.reload} /> : null}
        {res.status === 'ready' && panel === null ? (
          <LineList
            t={t}
            lines={editableLines(res.data.allocations)}
            pending={res.data.allocations.syncState === 'pending'}
            onPick={(a) => {
              setDone(null);
              setPanel(a);
            }}
          />
        ) : null}
        {res.status === 'ready' && panel !== null ? (
          <Panel
            key={panelKey(panel)}
            api={api}
            t={t}
            orderGid={orderGid}
            action={panel}
            locations={res.data.locations}
            online={online}
            onCancel={() => setPanel(null)}
            onDone={onDone}
            onReload={() => {
              setPanel(null);
              res.reload();
            }}
          />
        ) : null}
      </s-stack>
      {panel === null ? (
        <s-button slot="primary-action" variant="primary" onClick={close}>
          {t('common.close')}
        </s-button>
      ) : null}
    </s-admin-action>
  );
}

function panelKey(a: PanelAction): string {
  return a.type === 'allocate' ? `allocate:${a.line.lineItemGid}` : `${a.type}:${a.allocation.id}`;
}

// ---------------------------------------------------------------------------
// List of lines and their units
// ---------------------------------------------------------------------------

function LineList(p: { t: Translate; lines: Line[]; pending: boolean; onPick: (a: PanelAction) => void }) {
  const { t } = p;
  if (p.lines.length === 0) return <s-text>{t('orderAction.noTrackedLine')}</s-text>;
  return (
    <s-stack gap="large-100">
      {p.pending ? (
        <s-banner tone="info" heading={t('orderBlock.pendingTitle')}>
          <s-text>{t('orderAction.pendingBody')}</s-text>
        </s-banner>
      ) : null}
      {p.lines.map((line) => (
        <s-stack key={line.lineItemGid} gap="small-300">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-heading>{line.title}</s-heading>
            <s-text color="subdued">{t('orderBlock.quantity', { count: line.quantity })}</s-text>
          </s-stack>
          {line.allocations.map((a) => (
            <AllocationRow key={a.id} t={t} line={line} allocation={a} onPick={p.onPick} />
          ))}
          {Array.from({ length: Math.max(0, line.missing) }, (_, i) => (
            <s-stack key={`missing-${i}`} direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
              <s-badge tone="warning">{t('orderBlock.toAllocate')}</s-badge>
              <s-button variant="secondary" onClick={() => p.onPick({ type: 'allocate', line })}>
                {t('orderAction.allocate')}
              </s-button>
            </s-stack>
          ))}
        </s-stack>
      ))}
    </s-stack>
  );
}

function AllocationRow(p: { t: Translate; line: Line; allocation: Allocation; onPick: (a: PanelAction) => void }) {
  const { t, allocation, line } = p;
  const editable = isEditable(allocation);
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-text>{allocation.ref}</s-text>
        <s-badge tone={editable ? 'info' : 'neutral'}>{t(`orderBlock.status_${allocation.status}`)}</s-badge>
      </s-stack>
      {editable ? (
        <s-stack direction="inline" gap="small-200">
          <s-button variant="secondary" onClick={() => p.onPick({ type: 'replace', line, allocation })}>
            {t('orderAction.replace')}
          </s-button>
          <s-button variant="secondary" tone="critical" onClick={() => p.onPick({ type: 'remove', line, allocation })}>
            {t('orderAction.remove')}
          </s-button>
        </s-stack>
      ) : (
        <s-text color="subdued">{t('orderAction.locked')}</s-text>
      )}
    </s-stack>
  );
}

// ---------------------------------------------------------------------------
// Action panel (allocate / replace / remove) with effect announced before confirmation
// ---------------------------------------------------------------------------

function Panel(p: {
  api: ApiClient;
  t: Translate;
  orderGid: Gid;
  action: PanelAction;
  locations: Location[];
  online: boolean;
  onCancel: () => void;
  onDone: (messageKey: string) => void;
  onReload: () => void;
}) {
  const { t, action } = p;
  const needsUnit = action.type !== 'remove';
  const variantGid = action.line.variantGid;
  const candidates = useResource((signal) => (needsUnit ? loadCandidates(p.api, variantGid, signal) : Promise.resolve({ units: [] as Unit[], truncated: false })), [variantGid, needsUnit]);
  const [mode, setMode] = useState<'list' | 'typed'>('list');
  const [listUnitId, setListUnitId] = useState('');
  const [typed, setTyped] = useState('');
  const [resolution, setResolution] = useState<Resolution<Unit>>({ kind: 'empty' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const keeper = useMemo(() => new IdempotencyKeeper(), []);
  const names = useMemo(() => new Map(p.locations.map((l) => [l.id, l.name])), [p.locations]);

  const units = candidates.status === 'ready' ? candidates.data.units : [];
  const truncated = candidates.status === 'ready' && candidates.data.truncated;

  // The unit the person chose: from the list, or designated by typing (full ref, or unique last 4 characters).
  let chosenUnit: Unit | null = null;
  let choice: Choice | null = null;
  if (mode === 'list') {
    chosenUnit = units.find((u) => u.id === listUnitId) ?? null;
    if (chosenUnit) choice = { unitId: chosenUnit.id };
  } else if (resolution.kind === 'exact' || resolution.kind === 'suffix') {
    chosenUnit = resolution.unit;
    choice = { unitId: resolution.unit.id };
  } else if (truncated && resolution.kind === 'unknown' && typed.trim()) {
    choice = { ref: typed.trim() };
  }
  const effect = describeEffect(action, chosenUnit ?? (choice && 'ref' in choice ? { ref: choice.ref } : null));
  const call = planCall(p.orderGid, action, choice);
  const canConfirm = call !== null && !busy && p.online && (action.type === 'remove' || candidates.status === 'ready');

  const confirm = async () => {
    if (!call || !canConfirm) return;
    setBusy(true);
    setError(null);
    try {
      await runCall(p.api, call, keeper.keyFor(call));
      keeper.done();
      p.onDone(`orderAction.done_${action.type}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const conflict = error instanceof ApiError && error.code === 'precondition_failed';
  const describe = (u: Unit) => (u.locationId ? (names.get(u.locationId) ?? u.locationId) : '');

  return (
    <s-stack gap="base">
      <s-heading>{t(`orderAction.title_${action.type}`, { line: action.line.title })}</s-heading>
      {action.type !== 'allocate' ? (
        <s-text>{t('orderAction.current', { ref: action.allocation.ref })}</s-text>
      ) : null}

      {needsUnit && candidates.status === 'loading' ? <Loading t={t} /> : null}
      {needsUnit && candidates.status === 'error' ? <ErrorBanner t={t} error={candidates.error} onRetry={candidates.reload} /> : null}

      {needsUnit && candidates.status === 'ready' ? (
        <s-stack gap="base">
          {units.length === 0 ? (
            <s-banner tone="warning">
              <s-text>{t('orderAction.noAvailableUnit')}</s-text>
            </s-banner>
          ) : null}
          {truncated ? (
            <s-banner tone="info">
              <s-text>{t('orderAction.truncated')}</s-text>
            </s-banner>
          ) : null}
          <s-choice-list
            label={t('orderAction.chooseHow')}
            name="mode"
            values={[mode]}
            disabled={busy}
            onChange={(e: Event) => {
              const v = (e.currentTarget as unknown as { values?: string[] }).values?.[0];
              if (v === 'list' || v === 'typed') setMode(v);
            }}
          >
            <s-choice value="list">{t('orderAction.modeList')}</s-choice>
            <s-choice value="typed">{t('orderAction.modeTyped')}</s-choice>
          </s-choice-list>
          {mode === 'list' ? (
            <s-select
              label={t('orderAction.unitList')}
              value={listUnitId}
              disabled={busy}
              onChange={(e: Event) => setListUnitId((e.currentTarget as HTMLSelectElement).value)}
            >
              <s-option value="">{t('orderAction.unitListPlaceholder')}</s-option>
              {units.map((u) => (
                <s-option key={u.id} value={u.id}>
                  {describe(u) ? `${u.ref} · ${describe(u)}` : u.ref}
                </s-option>
              ))}
            </s-select>
          ) : (
            <DesignationInput
              t={t}
              label={t('orderAction.typedRef')}
              candidates={units}
              value={typed}
              disabled={busy}
              describe={describe}
              onChange={(v, r) => {
                setTyped(v);
                setResolution(r);
              }}
              onEnter={() => void confirm()}
            />
          )}
          {chosenUnit ? (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text>{chosenUnit.ref}</s-text>
              <StateBadge t={t} state={chosenUnit.state} />
            </s-stack>
          ) : null}
        </s-stack>
      ) : null}

      {effect ? (
        <s-banner tone="info" heading={t('orderAction.effectTitle')}>
          <s-stack gap="small-200">
            <s-text>{t(effect.key, effect.vars)}</s-text>
            <s-text>{t('orderAction.noStockWrite')}</s-text>
          </s-stack>
        </s-banner>
      ) : null}

      {error ? (
        conflict ? (
          <s-banner tone="critical" heading={t('common.conflictTitle')}>
            <s-stack gap="small-200">
              <s-text>{t('errors.precondition_failed')}</s-text>
              <s-button variant="secondary" onClick={p.onReload}>
                {t('common.reload')}
              </s-button>
            </s-stack>
          </s-banner>
        ) : (
          <ErrorBanner t={t} error={error} />
        )
      ) : null}

      <s-stack direction="inline" gap="small-200">
        <s-button
          variant="primary"
          tone={action.type === 'remove' ? 'critical' : 'auto'}
          loading={busy}
          disabled={!canConfirm}
          onClick={() => void confirm()}
        >
          {t(`orderAction.confirm_${action.type}`)}
        </s-button>
        <s-button variant="secondary" disabled={busy} onClick={p.onCancel}>
          {t('common.back')}
        </s-button>
      </s-stack>
    </s-stack>
  );
}
