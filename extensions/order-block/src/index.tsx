import { render } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { createApiClient, fromShopifyI18n } from '@serialis/extensions-shared';
import { OrderBlock } from './OrderBlock';

/** Handle of the "Modifier les unités" action extension (extensions/order-action/shopify.extension.toml). */
const ACTION_HANDLE = 'serialis-order-units-action';

// Order details block (spec 13.5, 15.6): refs per unit under each tracked line.
function Root() {
  const [summary, setSummary] = useState('');
  const orderGid = shopify.data.selected[0]?.id ?? '';
  const api = useMemo(() => createApiClient(), []);
  const t = useMemo(() => fromShopifyI18n(shopify.i18n), []);
  return (
    <s-admin-block heading={shopify.i18n.translate('orderBlock.heading')} collapsedSummary={summary || undefined}>
      <OrderBlock
        api={api}
        t={t}
        orderGid={orderGid}
        onEdit={() => shopify.navigation.navigate(`extension://${ACTION_HANDLE}`)}
        formatDateTime={(iso) => shopify.i18n.formatDate(new Date(iso), { dateStyle: 'short', timeStyle: 'short' })}
        onSummary={setSummary}
      />
    </s-admin-block>
  );
}

export default async () => {
  render(<Root />, document.body);
};
