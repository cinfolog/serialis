import { render } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { createApiClient, fromShopifyI18n } from '@serialis/extensions-shared';
import { VariantBlock } from './VariantBlock';

/** Handle of the "Ajouter des refs" action extension (extensions/variant-action/shopify.extension.toml). */
const ACTION_HANDLE = 'serialis-variant-refs-action';

// Variant details block (spec 13.5, 15.6): refs per location and state, gap with Shopify; adding refs opens the action.
function Root() {
  const [summary, setSummary] = useState('');
  const variantGid = shopify.data.selected[0]?.id ?? '';
  const api = useMemo(() => createApiClient(), []);
  const t = useMemo(() => fromShopifyI18n(shopify.i18n), []);
  // Without block-to-action navigation, the button falls back to the add form of the app (Units screen, add=1).
  const navigate = shopify.navigation?.navigate;
  const onAddRefs = useMemo(
    () => (typeof navigate === 'function' ? () => shopify.navigation.navigate(`extension://${ACTION_HANDLE}`) : undefined),
    [navigate],
  );
  return (
    <s-admin-block heading={shopify.i18n.translate('variantBlock.heading')} collapsedSummary={summary || undefined}>
      <VariantBlock api={api} t={t} variantGid={variantGid} onSummary={setSummary} {...(onAddRefs ? { onAddRefs } : {})} />
    </s-admin-block>
  );
}

export default async () => {
  render(<Root />, document.body);
};
