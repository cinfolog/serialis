/**
 * Random v4 UUID for Idempotency-Key values.
 *
 * `crypto.randomUUID` is only exposed in secure contexts, and the admin extension sandbox (a Web Worker in a sandboxed
 * iframe) does not guarantee one: calling it unguarded threw before the request was sent, so every POST from an
 * extension failed with « unexpected error » while GETs worked (recette du 18/11, « Turn on tracking »).
 * `crypto.getRandomValues` is available in every context, so it is the fallback.
 */
export function newUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // fall through to getRandomValues
    }
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
