import { render } from 'preact';
import { createApiClient, fromShopifyI18n } from '@serialis/extensions-shared';
import { VariantBlock } from './VariantBlock';

// Variant details block (spec 13.5, 15.6): refs per location and state, gap with Shopify, adding refs.
export default async () => {
  const variantGid = shopify.data.selected[0]?.id ?? '';
  render(
    <s-admin-block heading={shopify.i18n.translate('variantBlock.heading')}>
      <VariantBlock api={createApiClient()} t={fromShopifyI18n(shopify.i18n)} variantGid={variantGid} />
    </s-admin-block>,
    document.body,
  );
};
