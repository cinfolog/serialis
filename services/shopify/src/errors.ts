/**
 * Typed errors of the Shopify layer. Messages never contain tokens, secrets or request bodies:
 * they are safe to log as-is.
 */
export type ShopifyErrorKind =
  | 'network' // fetch threw (DNS, reset, timeout)
  | 'server' // HTTP 5xx
  | 'throttled' // THROTTLED (GraphQL) or HTTP 429, retries exhausted
  | 'auth' // HTTP 401/403: token invalid, revoked or IP allowlist refusal (13.9)
  | 'frozen' // HTTP 402 (shop frozen, unpaid) or 423 (shop locked), spec 12.2
  | 'not_found' // HTTP 404 (shop gone)
  | 'graphql' // top-level GraphQL errors (query invalid, access denied…)
  | 'http' // other non-2xx
  | 'invalid_response'; // body is not the expected JSON

export class ShopifyError extends Error {
  override readonly name: string = 'ShopifyError';
  readonly kind: ShopifyErrorKind;
  readonly status: number | null;
  /** GraphQL error codes (`extensions.code`) when available. */
  readonly codes: readonly string[];

  constructor(kind: ShopifyErrorKind, message: string, options: { status?: number | null; codes?: readonly string[]; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.status = options.status ?? null;
    this.codes = options.codes ?? [];
  }

  /** Transient errors: the same request may succeed later (spec 12.4, retry with backoff). */
  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'server' || this.kind === 'throttled';
  }
}

/** Failure of the OAuth endpoint (token exchange or refresh). */
export type OAuthErrorKind =
  | 'invalid_subject_token' // session token refused by Shopify
  | 'invalid_grant' // refresh token expired, revoked or already superseded
  | 'invalid_client' // app credentials refused
  | 'network'
  | 'server'
  | 'http'
  | 'invalid_response';

export class ShopifyOAuthError extends Error {
  override readonly name: string = 'ShopifyOAuthError';
  readonly kind: OAuthErrorKind;
  readonly status: number | null;

  constructor(kind: OAuthErrorKind, message: string, status: number | null = null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.kind = kind;
    this.status = status;
  }

  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'server';
  }
}

/** Session token (App Bridge JWT) refused. `reason` is safe to return to the client. */
export class SessionTokenError extends Error {
  override readonly name: string = 'SessionTokenError';
  readonly reason: SessionTokenErrorReason;

  constructor(reason: SessionTokenErrorReason) {
    super(`session token rejected: ${reason}`);
    this.reason = reason;
  }
}

export type SessionTokenErrorReason =
  | 'missing'
  | 'malformed'
  | 'unsupported_algorithm'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_audience'
  | 'invalid_shop'
  | 'shop_mismatch';
