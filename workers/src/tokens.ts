/**
 * Holder of the shop's expiring offline token (spec 10.3 "Sessions et jetons", 13.9):
 * the shop object is the only reader and writer of `shopify_token`. Token exchanges and refreshes
 * are serialised (one at a time; concurrent callers wait for the result), the access token is
 * refreshed when it expires in less than 5 minutes, and the pair is stored encrypted in one
 * transaction. Tokens are never logged.
 */
import { exchangeForOfflineToken, refreshOfflineToken, ShopifyOAuthError, type OfflineTokenSet } from '@serialis/shopify';
import { TokenCipher } from './crypto.js';
import { errorMessage, logEvent } from './log.js';

export const REFRESH_MARGIN_MS = 5 * 60_000;

export type TokenStatus = 'missing' | 'valid' | 'refreshing' | 'reconnect_required';

type TokenRow = {
  access_token_enc: ArrayBuffer;
  access_expires_at: number;
  refresh_token_enc: ArrayBuffer;
  refresh_expires_at: number;
  previous_refresh_token_enc: ArrayBuffer | null;
  previous_refresh_expires_at: number | null;
  key_version: number;
  scopes: string;
  status: Exclude<TokenStatus, 'missing'>;
};

/** No usable token: the merchant must open the app (token exchange) — spec 13.9 "Perte du jeton". */
export class ReconnectRequiredError extends Error {
  override readonly name = 'ReconnectRequiredError';
}

export interface TokenManagerConfig {
  shop: () => string;
  apiKey: string;
  apiSecret: string;
  encryptionKey: string | undefined;
}

export class TokenManager {
  private queue: Promise<unknown> = Promise.resolve();
  private cipherPromise: Promise<TokenCipher> | null = null;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly config: TokenManagerConfig,
  ) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  status(): { status: TokenStatus; accessExpiresAt: number | null; refreshExpiresAt: number | null; scopes: string | null } {
    const row = this.row();
    if (!row) return { status: 'missing', accessExpiresAt: null, refreshExpiresAt: null, scopes: null };
    return { status: row.status, accessExpiresAt: row.access_expires_at, refreshExpiresAt: row.refresh_expires_at, scopes: row.scopes };
  }

  /** True when a refresh can still produce an access token without the merchant. */
  hasUsableToken(now = Date.now()): boolean {
    const row = this.row();
    return !!row && row.status !== 'reconnect_required' && row.refresh_expires_at > now;
  }

  /** Token exchange with a session token, unless a usable token already exists (or `force`). */
  ensureExchanged(sessionToken: string, force = false): Promise<TokenStatus> {
    return this.serialize(async () => {
      if (!force && this.hasUsableToken()) return this.status().status;
      const set = await exchangeForOfflineToken(sessionToken, this.oauthOptions());
      await this.store(set, null);
      logEvent('info', 'token.exchanged', { shop: this.config.shop() });
      return 'valid' as const;
    });
  }

  /** A valid access token, refreshed first if it expires within 5 minutes. */
  getAccessToken(): Promise<string> {
    return this.serialize(async () => {
      const row = this.row();
      if (!row || row.status === 'reconnect_required') throw new ReconnectRequiredError('no usable Shopify token for this shop');
      const now = Date.now();
      if (row.access_expires_at - now > REFRESH_MARGIN_MS) return this.decrypt(row.access_token_enc, row.key_version, 'access');
      return this.refresh(row, now);
    });
  }

  /** Uninstall: tokens are no longer valid (spec 9.14). Synchronous, may run inside a transaction. */
  clear(): void {
    this.sql.exec('DELETE FROM shopify_token');
  }

  private async refresh(row: TokenRow, now: number): Promise<string> {
    this.sql.exec("UPDATE shopify_token SET status = 'refreshing', updated_at = ? WHERE id = 1", now);
    const candidates: Array<{ blob: ArrayBuffer; expiresAt: number }> = [{ blob: row.refresh_token_enc, expiresAt: row.refresh_expires_at }];
    if (row.previous_refresh_token_enc && (row.previous_refresh_expires_at ?? 0) > now) {
      candidates.push({ blob: row.previous_refresh_token_enc, expiresAt: row.previous_refresh_expires_at! });
    }
    let lastError: unknown = null;
    for (const candidate of candidates) {
      const refreshToken = await this.decrypt(candidate.blob, row.key_version, 'refresh');
      try {
        const set = await refreshOfflineToken(refreshToken, this.oauthOptions());
        // The refresh token just used stays valid until the new one is used (spec 13.9).
        await this.store(set, { token: refreshToken, expiresAt: candidate.expiresAt });
        logEvent('info', 'token.refreshed', { shop: this.config.shop() });
        return set.accessToken;
      } catch (error) {
        lastError = error;
        if (error instanceof ShopifyOAuthError && error.retryable) {
          // Shopify unreachable: keep the pair; the current access token may still be usable.
          this.sql.exec("UPDATE shopify_token SET status = 'valid', updated_at = ? WHERE id = 1", Date.now());
          if (row.access_expires_at > Date.now()) return this.decrypt(row.access_token_enc, row.key_version, 'access');
          throw error;
        }
        // Refused: try the previous refresh token, if any.
      }
    }
    this.sql.exec("UPDATE shopify_token SET status = 'reconnect_required', updated_at = ? WHERE id = 1", Date.now());
    // TODO(lot 0, observability): critical anomaly and merchant e-mail (spec 13.9).
    logEvent('error', 'token.reconnect_required', { shop: this.config.shop(), error: errorMessage(lastError) });
    throw new ReconnectRequiredError('Shopify refused the refresh tokens');
  }

  private async store(set: OfflineTokenSet, previous: { token: string; expiresAt: number } | null): Promise<void> {
    const cipher = await this.cipher();
    const shop = this.config.shop();
    const access = await cipher.encrypt(set.accessToken, aad(shop, 'access'));
    const refresh = await cipher.encrypt(set.refreshToken, aad(shop, 'refresh'));
    const prev = previous ? await cipher.encrypt(previous.token, aad(shop, 'refresh')) : null;
    const now = Date.now();
    this.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO shopify_token (id, access_token_enc, access_expires_at, refresh_token_enc, refresh_expires_at,
           previous_refresh_token_enc, previous_refresh_expires_at, key_version, scopes, status, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?)
         ON CONFLICT (id) DO UPDATE SET
           access_token_enc = excluded.access_token_enc, access_expires_at = excluded.access_expires_at,
           refresh_token_enc = excluded.refresh_token_enc, refresh_expires_at = excluded.refresh_expires_at,
           previous_refresh_token_enc = excluded.previous_refresh_token_enc,
           previous_refresh_expires_at = excluded.previous_refresh_expires_at,
           key_version = excluded.key_version, scopes = excluded.scopes, status = 'valid', updated_at = excluded.updated_at`,
        access,
        set.accessExpiresAt,
        refresh,
        set.refreshExpiresAt,
        prev,
        previous?.expiresAt ?? null,
        cipher.currentVersion,
        set.scopes,
        now,
      );
    });
  }

  private row(): TokenRow | undefined {
    return this.sql.exec<TokenRow>('SELECT * FROM shopify_token WHERE id = 1').toArray()[0];
  }

  private async decrypt(blob: ArrayBuffer, version: number, field: 'access' | 'refresh'): Promise<string> {
    const cipher = await this.cipher();
    return cipher.decrypt(blob, version, aad(this.config.shop(), field));
  }

  private cipher(): Promise<TokenCipher> {
    this.cipherPromise ??= TokenCipher.fromSecret(this.config.encryptionKey).catch((error: unknown) => {
      this.cipherPromise = null;
      throw error;
    });
    return this.cipherPromise;
  }

  private oauthOptions() {
    return { shop: this.config.shop(), apiKey: this.config.apiKey, apiSecret: this.config.apiSecret };
  }

  /** One token operation at a time; a failed operation does not block the next ones. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function aad(shop: string, field: 'access' | 'refresh'): string {
  return `serialis:shopify_token:${shop}:${field}`;
}
