import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/index.tsx' {
  const shopify: import('@shopify/ui-extensions/admin.product-variant-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/VariantAction.tsx' {
  const shopify: import('@shopify/ui-extensions/admin.product-variant-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}

