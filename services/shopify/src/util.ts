const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error('invalid base64url');
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time comparison (length is not secret). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** `*.myshopify.com` only: the shop domain designates a Durable Object, so it must be strict (spec 11.3). */
export function isValidShopDomain(shop: unknown): shop is string {
  return typeof shop === 'string' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

export type Sleep = (ms: number) => Promise<void>;
export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with jitter: base × 2^(attempt-1), capped, then a random factor in [0.5, 1]
 * so that retries of many objects do not align (spec 12.2, 12.4).
 */
export function backoffDelay(attempt: number, options: { baseMs: number; maxMs: number; random?: () => number }): number {
  const exp = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt - 1));
  const r = (options.random ?? Math.random)();
  return Math.round(exp * (0.5 + 0.5 * r));
}
