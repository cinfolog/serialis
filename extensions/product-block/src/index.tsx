import { render } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { createApiClient, fromShopifyI18n } from '@serialis/extensions-shared';
import { ProductBlock } from './ProductBlock';
import { createVariantLoader } from './logic';

// Product details block (spec 13.5, 15.6): summary of refs per variant and location.
function Root() {
  const [summary, setSummary] = useState('');
  const productGid = shopify.data.selected[0]?.id ?? '';
  const api = useMemo(() => createApiClient(), []);
  const t = useMemo(() => fromShopifyI18n(shopify.i18n), []);
  const loadVariants = useMemo(() => createVariantLoader((query, options) => shopify.query(query, options)), []);
  return (
    <s-admin-block heading={shopify.i18n.translate('productBlock.heading')} collapsedSummary={summary || undefined}>
      <ProductBlock api={api} t={t} productGid={productGid} loadVariants={loadVariants} onSummary={setSummary} />
    </s-admin-block>
  );
}

export default async () => {
  render(<Root />, document.body);
};
