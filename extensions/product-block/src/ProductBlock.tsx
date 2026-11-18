import { useEffect, useMemo } from 'preact/hooks';
import type { Gid } from '@serialis/contract';
import {
  ErrorBanner,
  Loading,
  OfflineBanner,
  useOnline,
  useResource,
  variantAdminHref,
  type ApiClient,
  type Translate,
} from '@serialis/extensions-shared';
import { buildRows, loadProductData, pickRows, type VariantLoader, type VariantRow } from './logic';

export interface ProductBlockProps {
  api: ApiClient;
  t: Translate;
  productGid: Gid;
  loadVariants: VariantLoader;
  /** Receives the collapsed summary of the block (`collapsedSummary` of `<s-admin-block>`). */
  onSummary?: (summary: string) => void;
}

/**
 * Product block (spec 15.6): per variant, tracked or not, available units per location, link to the variant block.
 * One line per variant, 5 at most (tracked first), the rest counted with a link to the app (DECISIONS.md).
 */
export function ProductBlock({ api, t, productGid, loadVariants, onSummary }: ProductBlockProps) {
  const res = useResource((signal) => loadProductData(api, loadVariants, productGid, signal), [productGid]);
  const online = useOnline();
  const rows = useMemo(() => (res.status === 'ready' ? buildRows(res.data, t('productBlock.untitled')) : []), [res, t]);

  const summary = res.status === 'ready' && rows.length > 0
    ? t('productBlock.summary', { count: rows.filter((r) => r.tracked).length, total: rows.length })
    : '';
  useEffect(() => {
    if (summary) onSummary?.(summary);
  }, [summary, onSummary]);

  if (res.status === 'loading') return <Loading t={t} />;
  if (res.status === 'error') return <ErrorBanner t={t} error={res.error} onRetry={res.reload} />;

  const trackedCount = rows.filter((r) => r.tracked).length;
  const { shown, hidden } = pickRows(rows);
  return (
    <s-stack gap="small-200">
      {!online ? <OfflineBanner t={t} /> : null}
      {res.data.variants === null ? (
        <s-banner tone="warning">
          <s-text>{t('productBlock.variantsUnavailable')}</s-text>
        </s-banner>
      ) : null}
      {rows.length === 0 ? (
        <s-text>{t('productBlock.empty')}</s-text>
      ) : (
        <>
          <s-text color="subdued">{t('productBlock.summary', { count: trackedCount, total: rows.length })}</s-text>
          {shown.map((r) => (
            <Row key={r.variantGid} t={t} row={r} productGid={productGid} />
          ))}
          {hidden > 0 ? (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text color="subdued">{t('productBlock.otherVariants', { count: hidden })}</s-text>
              <s-link href="app:tracked-items">{t('productBlock.openApp')}</s-link>
            </s-stack>
          ) : null}
        </>
      )}
    </s-stack>
  );
}

/** One line per variant: title (link to the variant page), tracking, available units per location, gap. */
function Row({ t, row, productGid }: { t: Translate; row: VariantRow; productGid: Gid }) {
  const available = row.available.length === 0
    ? t('productBlock.noneAvailable')
    : row.available.map((a) => `${a.name} : ${a.count}`).join(' · ');
  return (
    <s-stack direction="inline" gap="small-300" alignItems="center">
      <s-link href={variantAdminHref(productGid, row.variantGid)}>{row.title}</s-link>
      {row.sku ? <s-text color="subdued">{row.sku}</s-text> : null}
      <s-badge tone={row.tracked ? 'success' : 'neutral'}>
        {row.tracked ? (row.initializing ? t('productBlock.trackedInit') : t('productBlock.tracked')) : t('productBlock.notTracked')}
      </s-badge>
      {row.tracked ? <s-text>{t('productBlock.available', { list: available })}</s-text> : null}
      {!row.tracked ? null : row.gap === 0 ? (
        <s-badge tone="success">{t('productBlock.gapNone')}</s-badge>
      ) : (
        <s-badge tone={row.gap > 0 ? 'warning' : 'critical'}>{t('productBlock.gapValue', { count: Math.abs(row.gap), sign: row.gap > 0 ? '+' : '−' })}</s-badge>
      )}
    </s-stack>
  );
}
