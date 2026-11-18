/**
 * API key format, sealing and verification (spec 14.1, 11.3, 16):
 *
 *   srl_<seal version>_<location>_<shop>_<prefix>_<seal>.<secret>
 *
 * - `<seal version>`: number of the Worker sealing secret `API_KEY_SEAL_SECRET_V<n>`;
 * - `<location>`: `eu` (EU jurisdiction) or `global` — with `<shop>` it names the shop's object;
 * - `<shop>`: the shop's `*.myshopify.com` domain (no underscore, so `_` separates the fields);
 * - `<prefix>`: random identifier of the key inside the shop (`api_keys.prefix`);
 * - `<seal>`: HMAC-SHA256 of the public part (everything before `_<seal>`) with the sealing secret of
 *   that version, truncated to 128 bits, hex;
 * - `<secret>`: 256 random bits, base64url (no `.`), split off at the LAST dot.
 *
 * The Worker checks the seal (constant time) before anything else, so invented keys never wake or
 * create an object; the object compares the SHA-256 of the secret with `api_keys.hash`.
 */
import type { Env } from '../env.js';
import { isValidShopDomain, timingSafeEqual } from '../hmac.js';

export type KeyLocation = 'eu' | 'global';

export interface ParsedApiKey {
  version: number;
  location: KeyLocation;
  shop: string;
  prefix: string;
  seal: string;
  secret: string;
  /** `srl_<version>_<location>_<shop>_<prefix>`: the sealed text. */
  publicPart: string;
}

export const KEY_TAG = 'srl';
const SEAL_SECRET_NAME = /^API_KEY_SEAL_SECRET_V([1-9]\d{0,3})$/;
const PREFIX_RE = /^[a-z2-7]{16}$/;
const SEAL_RE = /^[0-9a-f]{32}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const enc = new TextEncoder();

/**
 * Sealing secrets by version, read from every Worker secret named `API_KEY_SEAL_SECRET_V<n>`: a
 * rotation adds `V<n+1>` (new keys) and keeps the older ones (existing keys stay valid).
 */
export function sealSecrets(env: Env): Map<number, string> {
  const out = new Map<number, string>();
  for (const [name, value] of Object.entries(env as unknown as Record<string, unknown>)) {
    const m = SEAL_SECRET_NAME.exec(name);
    if (m && typeof value === 'string' && value.length >= 16) out.set(Number(m[1]), value);
  }
  return out;
}

/** Version used to seal new keys: the highest configured one; null when none is configured. */
export function currentSealVersion(env: Env): number | null {
  const versions = [...sealSecrets(env).keys()];
  return versions.length > 0 ? Math.max(...versions) : null;
}

export function parseApiKey(token: string | null | undefined): ParsedApiKey | null {
  if (!token || token.length > 300) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const secret = token.slice(dot + 1);
  const parts = token.slice(0, dot).split('_');
  if (parts.length !== 6) return null;
  const [tag, version, location, shop, prefix, seal] = parts as [string, string, string, string, string, string];
  if (tag !== KEY_TAG || !/^[1-9]\d{0,3}$/.test(version)) return null;
  if (location !== 'eu' && location !== 'global') return null;
  if (!isValidShopDomain(shop) || !PREFIX_RE.test(prefix) || !SEAL_RE.test(seal) || !SECRET_RE.test(secret)) return null;
  return { version: Number(version), location, shop, prefix, seal, secret, publicPart: publicPartOf(Number(version), location, shop, prefix) };
}

export function publicPartOf(version: number, location: KeyLocation, shop: string, prefix: string): string {
  return `${KEY_TAG}_${version}_${location}_${shop}_${prefix}`;
}

/** Truncated (128-bit) HMAC-SHA256 of the public part, raw bytes. */
async function sealBytes(sealSecret: string, publicPart: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(sealSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(publicPart))).slice(0, 16);
}

export async function computeSeal(sealSecret: string, publicPart: string): Promise<string> {
  return toHex(await sealBytes(sealSecret, publicPart));
}

/** Constant-time seal check; false for an unknown version (no secret configured). */
export async function verifySeal(env: Env, key: ParsedApiKey): Promise<boolean> {
  const secret = sealSecrets(env).get(key.version);
  if (!secret) return false;
  const expected = await sealBytes(secret, key.publicPart);
  return timingSafeEqual(expected, fromHex(key.seal));
}

export async function secretHash(secret: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(secret)));
}

export interface IssuedKey {
  key: string;
  prefix: string;
  version: number;
  hash: Uint8Array;
}

/** New key for a shop: random prefix and secret, sealed with the current version. */
export async function issueApiKey(env: Env, shop: string, location: KeyLocation): Promise<IssuedKey> {
  const version = currentSealVersion(env);
  if (version === null) throw new Error('api_key_sealing_not_configured');
  const prefix = base32(crypto.getRandomValues(new Uint8Array(10)));
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const publicPart = publicPartOf(version, location, shop, prefix);
  const seal = await computeSeal(sealSecrets(env).get(version)!, publicPart);
  return { key: `${publicPart}_${seal}.${secret}`, prefix, version, hash: await secretHash(secret) };
}

/** Text shown in the list of keys (never the seal nor the secret). */
export function keyHint(version: number, location: KeyLocation, shop: string, prefix: string): string {
  return `${publicPartOf(version, location, shop, prefix)}_…`;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 4648 base32, lowercase, no padding (10 bytes → 16 characters). */
function base32(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
