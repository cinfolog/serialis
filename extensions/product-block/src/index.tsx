import { render } from 'preact';
import { createApiClient, fromShopifyI18n } from '@serialis/extensions-shared';
import { ProductBlock } from './ProductBlock';
import { createVariantLoader } from './logic';

// Product details block (spec 13.5, 15.6): summary of refs per variant and location.
export default async () => {
  const productGid = shopify.data.selected[0]?.id ?? '';
  render(
    <s-admin-block heading={shopify.i18n.translate('productBlock.heading')}>
      <ProductBlock
        api={createApiClient()}
        t={fromShopifyI18n(shopify.i18n)}
        productGid={productGid}
        loadVariants={createVariantLoader((query, options) => shopify.query(query, options))}
      />
    </s-admin-block>,
    document.body,
  );
};
