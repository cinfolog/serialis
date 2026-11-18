import { render } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { createApiClient, fromShopifyI18n } from '@serialis/extensions-shared';
import { VariantBlock } from './VariantBlock';

// Variant details block (spec 13.5, 15.6): refs per location and state, gap with Shopify, adding refs.
function Root() {
  const [summary, setSummary] = useState('');
  const variantGid = shopify.data.selected[0]?.id ?? '';
  const api = useMemo(() => createApiClient(), []);
  const t = useMemo(() => fromShopifyI18n(shopify.i18n), []);
  return (
    <s-admin-block heading={shopify.i18n.translate('variantBlock.heading')} collapsedSummary={summary || undefined}>
      <VariantBlock api={api} t={t} variantGid={variantGid} onSummary={setSummary} />
    </s-admin-block>
  );
}

export default async () => {
  render(<Root />, document.body);
};
