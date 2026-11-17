import { render } from 'preact';
import { createApiClient, fromShopifyI18n } from '@serialis/extensions-shared';
import { OrderAction } from './OrderAction';

// Order details action "Modifier les unités" (spec 13.5, 15.6): allocate, replace, remove an allocation.
export default async () => {
  const orderGid = shopify.data.selected[0]?.id ?? '';
  render(
    <OrderAction api={createApiClient()} t={fromShopifyI18n(shopify.i18n)} orderGid={orderGid} close={() => shopify.close()} />,
    document.body,
  );
};
