import { render } from 'preact';
import { createApiClient, fromShopifyI18n } from '@serialis/extensions-shared';
import { VariantAction } from './VariantAction';

// Variant details action "Ajouter des refs" (spec 13.5, 15.6): opened from the variant block or the "More actions" menu.
export default async () => {
  const variantGid = shopify.data.selected[0]?.id ?? '';
  render(
    <VariantAction api={createApiClient()} t={fromShopifyI18n(shopify.i18n)} variantGid={variantGid} close={() => shopify.close()} />,
    document.body,
  );
};
