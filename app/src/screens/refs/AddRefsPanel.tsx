import type { CheckUnitsBatchResponse, CreateUnitsBatchResponse, Location, RefCheckStatus, TrackedItem } from '@serialis/contract';
import { useEffect, useMemo, useRef, useState } from 'react';
import { newIdempotencyKey } from '../../api/client';
import { useAnnounce, useClient } from '../../context';
import { variantLabel } from '../../data';
import { useI18n } from '../../i18n';
import { detailKey, problemMessage } from '../../labels';
import { Badge, Banner, Button, ConfirmDialog, Section, Select, Stack, TextArea } from '../../ui/components';
import { useOnline } from '../../ui/hooks';
import { useErrorMessage } from '../../ui/states';

/** One ref per line; spaces, commas and semicolons are separators too (15.5). */
export function parseRefs(text: string): string[] {
  return text.split(/[\s,;]+/).filter((r) => r.length > 0);
}

const STATUS_TONE: Record<RefCheckStatus, 'success' | 'critical' | 'warning'> = {
  ready: 'success',
  duplicate_in_list: 'warning',
  already_known: 'warning',
  invalid_format: 'critical',
  beyond_gap: 'warning',
};

export interface AddRefsPanelProps {
  items: TrackedItem[];
  locations: Location[];
  /** Wizard: start on "already counted" (existing stock, no write). */
  defaultAlreadyCounted?: boolean;
  initialVariant?: string;
  onDone?: (result: CreateUnitsBatchResponse) => void;
}

/**
 * Paste-and-check flow shared by the Units screen and the startup wizard (15.3 "Marchand qui
 * ajoute ses refs"): paste, check line by line, read the effect on stock, confirm. The submission
 * carries an idempotency key that stays the same while the input is unchanged, so a replay after a
 * network cut cannot be applied twice (15.5, T-UX-02).
 */
export function AddRefsPanel(props: AddRefsPanelProps) {
  const i18n = useI18n();
  const { t, number } = i18n;
  const client = useClient();
  const announce = useAnnounce();
  const errorMessage = useErrorMessage();
  const online = useOnline();

  const [variantGid, setVariantGid] = useState(props.initialVariant ?? props.items[0]?.variantGid ?? '');
  const [locationId, setLocationId] = useState(props.locations[0]?.id ?? '');
  const [alreadyCounted, setAlreadyCounted] = useState(props.defaultAlreadyCounted ?? false);
  const [text, setText] = useState('');
  const [check, setCheck] = useState<CheckUnitsBatchResponse | null>(null);
  const [checkedFor, setCheckedFor] = useState('');
  const [checking, setChecking] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateUnitsBatchResponse | null>(null);
  const submitKey = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    if (!variantGid && props.items[0]) setVariantGid(props.items[0].variantGid);
    if (!locationId && props.locations[0]) setLocationId(props.locations[0].id);
  }, [props.items, props.locations, variantGid, locationId]);

  const item = props.items.find((i) => i.variantGid === variantGid);
  const location = props.locations.find((l) => l.id === locationId);
  const stock = item?.stock.find((s) => s.locationId === locationId);
  const refs = useMemo(() => parseRefs(text), [text]);
  const signature = JSON.stringify([variantGid, locationId, alreadyCounted, refs]);
  const stale = check !== null && checkedFor !== signature;

  const readyRefs = useMemo(() => (check && !stale ? check.rows.filter((r) => r.status === 'ready').map((r) => r.ref) : []), [check, stale]);

  async function runCheck() {
    setError(null);
    setResult(null);
    if (!item) return void setError(t('refs.pick_variant'));
    if (refs.length === 0) return void setError(t('refs.none_to_check'));
    setChecking(true);
    try {
      const response = await client.checkUnitsBatch({ variantGid, locationId, refs, alreadyCounted, mode: 'per_item' });
      setCheck(response);
      setCheckedFor(signature);
      announce(t('refs.summary', { ready: response.ready, total: response.rows.length }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }

  async function submit() {
    if (!check || stale) return;
    setSubmitting(true);
    setError(null);
    const sig = JSON.stringify([signature, readyRefs]);
    if (submitKey.current?.signature !== sig) submitKey.current = { signature: sig, key: newIdempotencyKey() };
    try {
      const response = await client.createUnitsBatch({ variantGid, locationId, refs: readyRefs, alreadyCounted, mode: 'per_item' }, { idempotencyKey: submitKey.current.key });
      setResult(response);
      setConfirmOpen(false);
      setCheck(null);
      setText(response.rejected.length > 0 ? response.rejected.map((r) => r.ref).join('\n') : '');
      submitKey.current = null;
      announce(t('refs.done', { count: response.created.length }), { toast: true });
      props.onDone?.(response);
    } catch (e) {
      // The same key is kept: pressing "Valider" again after a cut replays the same request.
      setError(errorMessage(e));
      setConfirmOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  const effect = (() => {
    if (!check || stale || !location) return null;
    if (alreadyCounted) return t('refs.effect.counted', { count: check.ready, location: location.name });
    const from = stock?.shopifyOnHand ?? 0;
    return t('refs.effect.received', { from: number(from), to: number(from + check.ready), location: location.name });
  })();

  const confirmBody = (() => {
    if (!check || !location) return '';
    if (alreadyCounted) return t('refs.confirm.counted', { count: check.ready, location: location.name });
    const from = stock?.shopifyOnHand ?? 0;
    return t('refs.confirm.received', { from: number(from), to: number(from + check.ready), count: check.ready, location: location.name });
  })();

  const gapHint = alreadyCounted && stock ? (stock.shopifyOnHand - stock.registeredUnits > 0 ? t('refs.gap_hint.counted', { location: location?.name ?? '', gap: stock.shopifyOnHand - stock.registeredUnits }) : t('refs.gap_hint.none')) : null;

  if (props.items.length === 0) {
    return (
      <Section heading={t('refs.heading')}>
        <s-paragraph>{t('refs.no_items')}</s-paragraph>
      </Section>
    );
  }

  return (
    <Section heading={t('refs.heading')}>
      <Stack>
        <s-paragraph>{t('refs.intro')}</s-paragraph>
        <Select
          label={t('refs.variant')}
          value={variantGid}
          options={props.items.map((i) => ({ value: i.variantGid, label: variantLabel(i) }))}
          onChange={setVariantGid}
          testId="refs-variant"
        />
        <Select label={t('refs.location')} value={locationId} options={props.locations.map((l) => ({ value: l.id, label: l.name }))} onChange={setLocationId} testId="refs-location" />
        <Select
          label={t('refs.type')}
          value={alreadyCounted ? 'counted' : 'received'}
          options={[
            { value: 'received', label: t('refs.type.received') },
            { value: 'counted', label: t('refs.type.counted') },
          ]}
          onChange={(v) => setAlreadyCounted(v === 'counted')}
          details={gapHint ?? undefined}
          testId="refs-type"
        />
        <TextArea label={t('refs.pasted')} value={text} onChange={setText} rows={8} placeholder={t('refs.pasted.placeholder')} testId="refs-text" />
        <div>
          <Button onPress={() => void runCheck()} loading={checking} disabled={!online} testId="refs-check">
            {t('refs.check')}
          </Button>
        </div>

        {error ? <Banner tone="critical" testId="refs-error">{error}</Banner> : null}

        {check && !stale ? (
          <Stack gap="small">
            <s-text type="strong" data-testid="refs-summary">{t('refs.summary', { ready: check.ready, total: check.rows.length })}</s-text>
            <s-table data-testid="refs-check-table">
              <s-table-header-row>
                <s-table-header>{t('refs.table.ref')}</s-table-header>
                <s-table-header>{t('refs.table.status')}</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {check.rows.map((r) => (
                  <s-table-row key={r.index}>
                    <s-table-cell>{r.ref}</s-table-cell>
                    <s-table-cell>
                      <Badge tone={STATUS_TONE[r.status]}>{t(`refs.status.${r.status}`)}</Badge>
                      {detailKey(r.detail) ? <s-text> {t(`error.detail.${detailKey(r.detail)!}`)}</s-text> : null}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            {effect ? <s-text data-testid="refs-effect">{effect}</s-text> : null}
            <div>
              <Button variant="primary" onPress={() => setConfirmOpen(true)} disabled={check.ready === 0 || !online} loading={submitting} testId="refs-submit">
                {t('refs.submit', { count: check.ready })}
              </Button>
            </div>
          </Stack>
        ) : null}

        {result ? (
          <Stack gap="small">
            <Banner tone="success" testId="refs-result">{t('refs.done', { count: result.created.length })}</Banner>
            {result.rejected.length > 0 ? (
              <Banner tone="warning" heading={t('refs.rejected_heading')} testId="refs-rejected">
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                  {result.rejected.map((r) => (
                    <li key={r.index}>{t('refs.rejected.line', { ref: r.ref, reason: problemMessage(i18n, r.code, r.detail) })}</li>
                  ))}
                </ul>
              </Banner>
            ) : null}
          </Stack>
        ) : null}
      </Stack>

      <ConfirmDialog
        open={confirmOpen}
        heading={t('refs.confirm.heading')}
        confirmLabel={t('refs.submit', { count: check?.ready ?? 0 })}
        cancelLabel={t('common.cancel')}
        busy={submitting}
        onConfirm={() => void submit()}
        onClose={() => setConfirmOpen(false)}
      >
        <s-paragraph>{confirmBody}</s-paragraph>
      </ConfirmDialog>
    </Section>
  );
}
