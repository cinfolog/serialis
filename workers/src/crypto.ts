/**
 * Encryption of Shopify tokens at rest (spec 16): AES-256-GCM through WebCrypto, 96-bit random IV,
 * additional data binding each ciphertext to its shop and field (a blob copied to another shop or
 * column does not decrypt). Stored blob = IV (12 bytes) || ciphertext+tag. The key version is stored
 * next to the blob (`shopify_token.key_version`).
 */
export class TokenCipher {
  private constructor(
    private readonly keys: ReadonlyMap<number, CryptoKey>,
    readonly currentVersion: number,
  ) {}

  /** Parses `TOKEN_ENCRYPTION_KEY`: one base64 key (version 1) or `2:<base64>,1:<base64>` (first = current). */
  static async fromSecret(secret: string | undefined): Promise<TokenCipher> {
    if (!secret || !secret.trim()) throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
    const keys = new Map<number, CryptoKey>();
    let current: number | null = null;
    for (const part of secret.split(',').map((p) => p.trim()).filter(Boolean)) {
      const match = /^(?:(\d+):)?([A-Za-z0-9+/=_-]+)$/.exec(part);
      if (!match) throw new Error('TOKEN_ENCRYPTION_KEY is malformed');
      const version = match[1] ? Number(match[1]) : 1;
      const raw = decodeBase64(match[2]!);
      if (raw.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must hold 32-byte keys');
      if (keys.has(version)) throw new Error('TOKEN_ENCRYPTION_KEY has a duplicate version');
      keys.set(version, await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
      current ??= version;
    }
    if (current === null) throw new Error('TOKEN_ENCRYPTION_KEY is empty');
    return new TokenCipher(keys, current);
  }

  async encrypt(plaintext: string, aad: string): Promise<Uint8Array<ArrayBuffer>> {
    const key = this.keys.get(this.currentVersion)!;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, utf8(plaintext)),
    );
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv, 0);
    out.set(ct, iv.length);
    return out;
  }

  async decrypt(blob: ArrayBuffer | Uint8Array, version: number, aad: string): Promise<string> {
    const key = this.keys.get(version);
    if (!key) throw new Error(`token encryption key version ${version} is not available`);
    const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, ct);
    return new TextDecoder().decode(pt);
  }
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
