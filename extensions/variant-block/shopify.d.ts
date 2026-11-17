import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/index.tsx' {
  const shopify: import('@shopify/ui-extensions/admin.product-variant-details.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/VariantBlock.tsx' {
  const shopify: import('@shopify/ui-extensions/admin.product-variant-details.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/logic.ts' {
  const shopify: import('@shopify/ui-extensions/admin.product-variant-details.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
