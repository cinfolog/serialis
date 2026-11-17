/**
 * Thin access layer over the App Bridge global (`window.shopify`, loaded from the CDN script).
 * Everything that touches the host page goes through here so that the rest of the app (and the
 * tests, and the mock mode where App Bridge is absent) never reads `window.shopify` directly.
 */

export interface PickedVariant {
  variantGid: string;
  productGid: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
}

interface ResourcePickerSelection {
  id: string;
  title?: string;
  sku?: string | null;
  product?: { id: string; title?: string };
  variants?: Array<{ id: string; title?: string; sku?: string | null }>;
}

interface ShopifyGlobal {
  idToken(): Promise<string>;
  toast?: { show(message: string, options?: { isError?: boolean; duration?: number }): void };
  resourcePicker?(options: {
    type: 'product' | 'variant';
    multiple?: boolean | number;
    action?: 'select' | 'add';
  }): Promise<ResourcePickerSelection[] | undefined>;
}

declare global {
  interface Window {
    shopify?: ShopifyGlobal;
  }
}

export function hasAppBridge(): boolean {
  return typeof window !== 'undefined' && window.shopify !== undefined;
}

/** Fresh session token for `Authorization: Bearer` (spec 16: verified on every request). */
export async function getSessionToken(): Promise<string> {
  const shopify = window.shopify;
  if (!shopify) throw new Error('App Bridge is not available (not embedded in the Shopify admin).');
  return shopify.idToken();
}

export function showToast(message: string, isError = false): void {
  window.shopify?.toast?.show(message, { isError });
}

/** Shopify variant picker (App Bridge resource picker); resolves to [] when cancelled. */
export async function pickVariants(): Promise<PickedVariant[]> {
  const picker = window.shopify?.resourcePicker;
  if (!picker) return [];
  const selection = await picker.call(window.shopify, { type: 'variant', multiple: true });
  if (!selection) return [];
  return selection.map((v) => ({
    variantGid: v.id,
    productGid: v.product?.id ?? '',
    title: v.product?.title ?? v.title ?? '',
    variantTitle: v.product ? (v.title ?? null) : null,
    sku: v.sku ?? null,
  }));
}

/** Number at the end of a Shopify gid, e.g. gid://shopify/Order/123 -> "123". */
export function gidNumber(gid: string): string {
  return gid.split('/').pop() ?? gid;
}

/** Deep link into the Shopify admin (App Bridge resolves `shopify:admin/...`). */
export function adminUrl(path: string): string {
  return `shopify:admin/${path.replace(/^\//, '')}`;
}
