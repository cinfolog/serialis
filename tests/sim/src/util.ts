/** Small shared helpers: deterministic clock and RNG, gid helpers, HMAC. Only standard APIs (WebCrypto, btoa). */

export const DEFAULT_START = Date.parse('2026-11-17T10:00:00.000Z');

/** Virtual clock. Nothing in the simulator reads the real time; tests advance it explicitly. */
export class Clock {
  private ms: number;
  constructor(start: number = DEFAULT_START) {
    this.ms = start;
  }
  now(): number {
    return this.ms;
  }
  iso(): string {
    return new Date(this.ms).toISOString();
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  /** Advance by 1 ms so that successive writes get distinct `updatedAt` values. */
  tick(): void {
    this.ms += 1;
  }
}

/** mulberry32: tiny seeded PRNG, returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gid(type: string, id: number | string): string {
  return `gid://shopify/${type}/${id}`;
}

export interface ParsedGid {
  type: string;
  id: string;
  query: string | undefined;
}

export function parseGid(value: string): ParsedGid | null {
  const m = /^gid:\/\/shopify\/([A-Za-z]+)\/([^?]+)(?:\?(.*))?$/.exec(value);
  if (!m) return null;
  return { type: m[1] as string, id: m[2] as string, query: m[3] };
}

/** Numeric tail of a gid, as used in REST-style webhook payloads. */
export function numericId(value: string): number {
  const p = parseGid(value);
  return p ? Number(p.id) : Number.NaN;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export async function hmacSha256Base64(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body))));
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable JSON (sorted keys) used to fingerprint idempotent requests. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function randomToken(rng: () => number, prefix: string, length = 24): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < length; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
  return `${prefix}_${s}`;
}
