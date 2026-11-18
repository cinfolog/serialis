import { useMemo } from 'preact/hooks';
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
import { buildRows, loadProductData, type VariantLoader, type VariantRow } from './logic';

export interface ProductBlockProps {
  api: ApiClient;
  t: Translate;
  productGid: Gid;
  loadVariants: VariantLoader;
}

/** Product block (spec 15.6): per variant, tracked or not, available units per location, link to the variant block. */
export function ProductBlock({ api, t, productGid, loadVariants }: ProductBlockProps) {
  const res = useResource((signal) => loadProductData(api, loadVariants, productGid, signal), [productGid]);
  const online = useOnline();
  const rows = useMemo(() => (res.status === 'ready' ? buildRows(res.data, t('productBlock.untitled')) : []), [res, t]);

  if (res.status === 'loading') return <Loading t={t} />;
  if (res.status === 'error') return <ErrorBanner t={t} error={res.error} onRetry={res.reload} />;

  const trackedCount = rows.filter((r) => r.tracked).length;
  return (
    <s-stack gap="base">
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
          <s-text>{t('productBlock.summary', { count: trackedCount, total: rows.length })}</s-text>
          <s-table>
            <s-table-header-row>
              <s-table-header>{t('productBlock.colVariant')}</s-table-header>
              <s-table-header>{t('productBlock.colTracking')}</s-table-header>
              <s-table-header>{t('productBlock.colAvailable')}</s-table-header>
              <s-table-header>{t('productBlock.colGap')}</s-table-header>
              <s-table-header>{t('productBlock.colLink')}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => (
                <Row key={r.variantGid} t={t} row={r} productGid={productGid} />
              ))}
            </s-table-body>
          </s-table>
        </>
      )}
    </s-stack>
  );
}

function Row({ t, row, productGid }: { t: Translate; row: VariantRow; productGid: Gid }) {
  return (
    <s-table-row>
      <s-table-cell>
        <s-stack gap="small-500">
          <s-text>{row.title}</s-text>
          {row.sku ? <s-text color="subdued">{row.sku}</s-text> : null}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-badge tone={row.tracked ? 'success' : 'neutral'}>
          {row.tracked ? (row.initializing ? t('productBlock.trackedInit') : t('productBlock.tracked')) : t('productBlock.notTracked')}
        </s-badge>
      </s-table-cell>
      <s-table-cell>
        {!row.tracked ? (
          '–'
        ) : row.available.length === 0 ? (
          t('productBlock.noneAvailable')
        ) : (
          <s-stack gap="small-500">
            {row.available.map((a) => (
              <s-text key={a.locationId}>{`${a.name} : ${a.count}`}</s-text>
            ))}
          </s-stack>
        )}
      </s-table-cell>
      <s-table-cell>
        {!row.tracked ? '–' : row.gap === 0 ? <s-badge tone="success">{t('productBlock.gapNone')}</s-badge> : <s-badge tone={row.gap > 0 ? 'warning' : 'critical'}>{t('productBlock.gapValue', { count: Math.abs(row.gap), sign: row.gap > 0 ? '+' : '−' })}</s-badge>}
      </s-table-cell>
      <s-table-cell>
        <s-link href={variantAdminHref(productGid, row.variantGid)}>{t('productBlock.openVariant')}</s-link>
      </s-table-cell>
    </s-table-row>
  );
}
