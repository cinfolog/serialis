import { ShopifyOAuthError, type OAuthErrorKind } from './errors.js';
import { isValidShopDomain } from './util.js';

/** Expiring offline token pair (spec 13.9: access token 1 h, refresh token 90 days). */
export interface OfflineTokenSet {
  accessToken: string;
  /** ms since epoch */
  accessExpiresAt: number;
  refreshToken: string;
  /** ms since epoch */
  refreshExpiresAt: number;
  scopes: string;
}

/** Online (user-bound) access token. Only the token and its expiry are kept: user details are dropped (P8). */
export interface OnlineToken {
  accessToken: string;
  accessExpiresAt: number;
  scopes: string;
}

export interface OAuthOptions {
  shop: string;
  apiKey: string;
  apiSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
export const OFFLINE_TOKEN_TYPE = 'urn:shopify:params:oauth:token-type:offline-access-token';
export const ONLINE_TOKEN_TYPE = 'urn:shopify:params:oauth:token-type:online-access-token';

/**
 * Exchanges a session token for an expiring offline token (`expiring=1`). Shopify revokes the app's
 * other offline tokens for the shop: the caller must serialise this with refreshes (spec 13.9).
 */
export async function exchangeForOfflineToken(sessionToken: string, options: OAuthOptions): Promise<OfflineTokenSet> {
  const body = await post(options, {
    client_id: options.apiKey,
    client_secret: options.apiSecret,
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: sessionToken,
    subject_token_type: ID_TOKEN_TYPE,
    requested_token_type: OFFLINE_TOKEN_TYPE,
    expiring: '1',
  });
  return toOfflineSet(body, options);
}

/** Exchanges a session token for an online token (installation, spec 9.14 step 1). */
export async function exchangeForOnlineToken(sessionToken: string, options: OAuthOptions): Promise<OnlineToken> {
  const body = await post(options, {
    client_id: options.apiKey,
    client_secret: options.apiSecret,
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: sessionToken,
    subject_token_type: ID_TOKEN_TYPE,
    requested_token_type: ONLINE_TOKEN_TYPE,
  });
  const now = (options.now ?? Date.now)();
  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || !accessToken) throw new ShopifyOAuthError('invalid_response', 'token response without access_token');
  return {
    accessToken,
    accessExpiresAt: now + seconds(body.expires_in, 0) * 1000,
    scopes: typeof body.scope === 'string' ? body.scope : '',
  };
}

/** Refresh-token grant: returns a new pair; the previous refresh token stays valid until the new one is used. */
export async function refreshOfflineToken(refreshToken: string, options: OAuthOptions): Promise<OfflineTokenSet> {
  const body = await post(options, {
    client_id: options.apiKey,
    client_secret: options.apiSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return toOfflineSet(body, options);
}

function toOfflineSet(body: Record<string, unknown>, options: OAuthOptions): OfflineTokenSet {
  const now = (options.now ?? Date.now)();
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token;
  if (typeof accessToken !== 'string' || !accessToken) throw new ShopifyOAuthError('invalid_response', 'token response without access_token');
  // A non-expiring token would mean `expiring=1` was ignored: refuse it rather than store a token we cannot refresh.
  if (typeof refreshToken !== 'string' || !refreshToken) throw new ShopifyOAuthError('invalid_response', 'token response without refresh_token');
  return {
    accessToken,
    accessExpiresAt: now + seconds(body.expires_in, 3600) * 1000,
    refreshToken,
    refreshExpiresAt: now + seconds(body.refresh_token_expires_in, 90 * 24 * 3600) * 1000,
    scopes: typeof body.scope === 'string' ? body.scope : '',
  };
}

function seconds(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
}

async function post(options: OAuthOptions, payload: Record<string, string>): Promise<Record<string, unknown>> {
  if (!isValidShopDomain(options.shop)) throw new ShopifyOAuthError('http', 'invalid shop domain');
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`https://${options.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    throw new ShopifyOAuthError('network', 'token endpoint unreachable', null, cause);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : '';
    // Only the OAuth error code is kept: descriptions may echo request content.
    throw new ShopifyOAuthError(classify(response.status, code), `token endpoint answered ${response.status}${code ? ` (${code})` : ''}`, response.status);
  }
  if (!body || typeof body !== 'object') throw new ShopifyOAuthError('invalid_response', 'token endpoint answered without JSON', response.status);
  return body as Record<string, unknown>;
}

function classify(status: number, code: string): OAuthErrorKind {
  if (code === 'invalid_subject_token') return 'invalid_subject_token';
  if (code === 'invalid_grant' || code === 'invalid_token') return 'invalid_grant';
  if (code === 'invalid_client' || status === 401) return 'invalid_client';
  if (status >= 500) return 'server';
  // 400 without a known code on a refresh is treated as a lost grant by the caller.
  return 'http';
}
