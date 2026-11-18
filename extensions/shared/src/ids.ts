import type { Gid } from '@serialis/contract';

/** `gid://shopify/Order/123` → `123`. Returns the input unchanged when it is not a GID. */
export function gidToId(gid: Gid): string {
  const i = gid.lastIndexOf('/');
  return i >= 0 ? gid.slice(i + 1) : gid;
}

/** Admin path of a variant page, usable as `href` of `<s-link>` (`shopify:admin/...`). */
export function variantAdminHref(productGid: Gid, variantGid: Gid): string {
  return `shopify:admin/products/${gidToId(productGid)}/variants/${gidToId(variantGid)}`;
}
