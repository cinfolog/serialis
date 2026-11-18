import { SessionTokenError } from './errors.js';
import { base64UrlDecode, isValidShopDomain, timingSafeEqual, utf8 } from './util.js';

/** Verified claims of an App Bridge session token (spec 16, 11.3). */
export interface SessionToken {
  /** Shop domain taken from `dest`, the only source used to pick the shop's object. */
  shop: string;
  /** Shopify user id (`sub`); absent for some extension tokens. */
  userId: string | null;
  sessionId: string | null;
  expiresAt: number; // ms
  issuedAt: number | null; // ms
  /** The raw token, needed for the token exchange. Never log it. */
  raw: string;
}

export interface VerifySessionTokenOptions {
  apiKey: string;
  apiSecret: string;
  /** Clock tolerance for `exp` / `nbf`, in seconds. Default 5 s (same as Shopify's libraries). */
  leewaySeconds?: number;
  /** When the caller already knows the shop (for example `?shop=`), the token must be for that shop. */
  expectedShop?: string | null;
  now?: () => number;
}

interface JwtHeader {
  alg?: unknown;
  typ?: unknown;
}

interface JwtClaims {
  iss?: unknown;
  dest?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  sid?: unknown;
}

/** Reads the token from an `Authorization: Bearer <jwt>` header. */
export function sessionTokenFromRequest(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * Verifies a Shopify session token: HS256 signed with the app secret, `aud` = app client id,
 * `dest` and `iss` on the same `*.myshopify.com` shop, `exp`/`nbf` within a small leeway.
 * Throws `SessionTokenError` otherwise.
 */
export async function verifySessionToken(token: string | null | undefined, options: VerifySessionTokenOptions): Promise<SessionToken> {
  if (!token) throw new SessionTokenError('missing');
  if (!options.apiSecret || !options.apiKey) throw new SessionTokenError('bad_signature');
  const parts = token.split('.');
  if (parts.length !== 3) throw new SessionTokenError('malformed');
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string];

  let header: JwtHeader;
  let claims: JwtClaims;
  let signature: Uint8Array;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerPart))) as JwtHeader;
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(claimsPart))) as JwtClaims;
    signature = base64UrlDecode(signaturePart);
  } catch {
    throw new SessionTokenError('malformed');
  }
  if (typeof header !== 'object' || header === null || typeof claims !== 'object' || claims === null) {
    throw new SessionTokenError('malformed');
  }
  // Only HS256: rejects `none` and algorithm confusion.
  if (header.alg !== 'HS256') throw new SessionTokenError('unsupported_algorithm');

  const key = await crypto.subtle.importKey('raw', utf8(options.apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(`${headerPart}.${claimsPart}`)));
  if (!timingSafeEqual(expected, signature)) throw new SessionTokenError('bad_signature');

  const nowSec = (options.now ?? Date.now)() / 1000;
  const leeway = options.leewaySeconds ?? 5;
  if (typeof claims.exp !== 'number') throw new SessionTokenError('malformed');
  if (claims.exp + leeway <= nowSec) throw new SessionTokenError('expired');
  if (typeof claims.nbf === 'number' && claims.nbf - leeway > nowSec) throw new SessionTokenError('not_yet_valid');

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.apiKey)) throw new SessionTokenError('wrong_audience');

  const shop = hostOf(claims.dest);
  if (!isValidShopDomain(shop)) throw new SessionTokenError('invalid_shop');
  // `iss` is https://<shop>/admin for admin tokens; it must name the same shop as `dest`.
  if (claims.iss !== undefined) {
    const issuerShop = hostOf(claims.iss);
    if (issuerShop !== shop) throw new SessionTokenError('shop_mismatch');
  }
  if (options.expectedShop != null && options.expectedShop !== shop) throw new SessionTokenError('shop_mismatch');

  return {
    shop,
    userId: typeof claims.sub === 'string' && claims.sub ? claims.sub : null,
    sessionId: typeof claims.sid === 'string' && claims.sid ? claims.sid : null,
    expiresAt: claims.exp * 1000,
    issuedAt: typeof claims.iat === 'number' ? claims.iat * 1000 : null,
    raw: token,
  };
}

function hostOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}
