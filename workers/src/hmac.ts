/**
 * Shopify webhook signature check: base64(HMAC-SHA256(raw body, app secret)) in `X-Shopify-Hmac-Sha256`.
 * Constant-time comparison; the raw body must be read before any JSON parsing.
 */
export async function verifyShopifyWebhook(rawBody: ArrayBuffer, hmacHeader: string | null, secret: string): Promise<boolean> {
  if (!hmacHeader || !secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody));
  let expected: Uint8Array;
  try {
    expected = Uint8Array.from(atob(hmacHeader), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return timingSafeEqual(digest, expected);
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** `*.myshopify.com` only — the shop header designates the object, so it must be strict. */
export function isValidShopDomain(shop: string | null): shop is string {
  return !!shop && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}
