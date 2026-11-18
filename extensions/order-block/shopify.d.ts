import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/index.tsx' {
  const shopify: import('@shopify/ui-extensions/admin.order-details.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/OrderBlock.tsx' {
  const shopify: import('@shopify/ui-extensions/admin.order-details.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/logic.ts' {
  const shopify: import('@shopify/ui-extensions/admin.order-details.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
