import { randomToken } from './util.js';

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const OFFLINE_TOKEN_TYPE = 'urn:shopify:params:oauth:token-type:offline-access-token';

export interface OAuthOptions {
  /** Access token lifetime in seconds (default 3600, expiring offline tokens). */
  accessTokenTtl?: number;
  /** Refresh token lifetime in seconds (default 90 days). */
  refreshTokenTtl?: number;
}

interface Grant {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  /** True once the access token issued with this refresh token has been presented to the GraphQL endpoint. */
  used: boolean;
  scope: string;
  parent: Grant | undefined;
}

/**
 * Fake token endpoint for expiring offline tokens (token exchange and refresh grants). Refresh rotates both tokens;
 * the previous refresh token stays valid until the new access token is first used, which is what makes a lost
 * response survivable (T-CH-07).
 */
export class OAuthServer {
  private grants: Grant[] = [];
  /** Session tokens (`id_token`) accepted by the exchange; empty means any non-empty value. */
  validSessionTokens = new Set<string>();
  readonly accessTtl: number;
  readonly refreshTtl: number;

  constructor(
    private readonly now: () => number,
    private readonly rng: () => number,
    private readonly scopes: () => string[],
    opts: OAuthOptions = {},
  ) {
    this.accessTtl = opts.accessTokenTtl ?? 3600;
    this.refreshTtl = opts.refreshTokenTtl ?? 90 * 24 * 3600;
  }

  private issue(parent?: Grant): Grant {
    const g: Grant = {
      accessToken: randomToken(this.rng, 'shpat'),
      refreshToken: randomToken(this.rng, 'shprt'),
      accessExpiresAt: this.now() + this.accessTtl * 1000,
      refreshExpiresAt: this.now() + this.refreshTtl * 1000,
      used: false,
      scope: this.scopes().join(','),
      parent,
    };
    this.grants.push(g);
    return g;
  }

  private response(g: Grant): Record<string, unknown> {
    return {
      access_token: g.accessToken,
      scope: g.scope,
      expires_in: this.accessTtl,
      refresh_token: g.refreshToken,
      refresh_token_expires_in: this.refreshTtl,
    };
  }

  /** Handles a parsed token request; returns an HTTP status and JSON body. */
  token(params: Record<string, string>): { status: number; body: Record<string, unknown> } {
    const grantType = params['grant_type'];
    if (grantType === TOKEN_EXCHANGE_GRANT) {
      const subject = params['subject_token'];
      if (!subject || (this.validSessionTokens.size > 0 && !this.validSessionTokens.has(subject))) return { status: 400, body: { error: 'invalid_subject_token' } };
      if (params['requested_token_type'] !== OFFLINE_TOKEN_TYPE) return { status: 400, body: { error: 'invalid_request', error_description: 'requested_token_type must be the offline access token type' } };
      if (!params['client_id'] || !params['client_secret']) return { status: 400, body: { error: 'invalid_client' } };
      return { status: 200, body: this.response(this.issue()) };
    }
    if (grantType === 'refresh_token') {
      const rt = params['refresh_token'];
      const idx = this.grants.findIndex((g) => g.refreshToken === rt);
      const g = this.grants[idx];
      if (!g || g.refreshExpiresAt <= this.now()) return { status: 400, body: { error: 'invalid_grant' } };
      // Rotated and the new access token was already used: the old refresh token is spent.
      if (this.grants.some((x) => x.parent === g && x.used)) return { status: 400, body: { error: 'invalid_grant' } };
      return { status: 200, body: this.response(this.issue(g)) };
    }
    return { status: 400, body: { error: 'unsupported_grant_type' } };
  }

  /** Checks an access token presented to the Admin API. */
  check(token: string | null): 'ok' | 'invalid' | 'expired' {
    if (!token) return 'invalid';
    const g = this.grants.find((x) => x.accessToken === token);
    if (!g) return 'invalid';
    if (g.accessExpiresAt <= this.now()) return 'expired';
    g.used = true;
    return 'ok';
  }

  /** Test helper: forces every access token to expire now. */
  expireAccessTokens(): void {
    for (const g of this.grants) g.accessExpiresAt = this.now();
  }

  get issued(): number {
    return this.grants.length;
  }
}
