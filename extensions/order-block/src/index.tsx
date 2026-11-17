import { render } from 'preact';
import { createApiClient, fromShopifyI18n } from '@serialis/extensions-shared';
import { OrderBlock } from './OrderBlock';

/** Handle of the "Modifier les unités" action extension (extensions/order-action/shopify.extension.toml). */
const ACTION_HANDLE = 'serialis-order-units-action';

// Order details block (spec 13.5, 15.6): refs per unit under each tracked line.
export default async () => {
  const orderGid = shopify.data.selected[0]?.id ?? '';
  render(
    <s-admin-block heading={shopify.i18n.translate('orderBlock.heading')}>
      <OrderBlock
        api={createApiClient()}
        t={fromShopifyI18n(shopify.i18n)}
        orderGid={orderGid}
        onEdit={() => shopify.navigation.navigate(`extension://${ACTION_HANDLE}`)}
        formatDateTime={(iso) =>
          shopify.i18n.formatDate(new Date(iso), { dateStyle: 'short', timeStyle: 'short' })
        }
      />
    </s-admin-block>,
    document.body,
  );
};
