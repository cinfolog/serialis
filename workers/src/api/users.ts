/**
 * App users and access rights (spec 15.8): the user is known by the `sub` of the session token or of
 * the admin extensions' ID token; the first user seen by the shop's base is its owner and administrator
 * (workers/DECISIONS.md 46); administrators designate others among the users who already opened the app.
 * The public API (14.1) maps the `admin` scope to the administration level.
 */
import type { AppUser, AppUserRole, ListAppUsersResponse, PatchAppUserRequest } from '@serialis/contract';
import type { DomainContext } from '../domain/context.js';
import { ApiError, json, parseBody, type ApiResult, type Principal } from './http.js';
import type { ApiContext } from './present.js';

type AppUserRow = {
  shopify_user_id: string;
  first_name: string | null;
  is_owner: number;
  is_admin: number;
  designated_by: string | null;
  first_seen_at: number;
  last_seen_at: number;
};

const FIRST_NAME_MAX = 50;
/** `last_seen_at` is refreshed at most every 10 minutes (one write per call otherwise). */
const LAST_SEEN_PRECISION_MS = 10 * 60_000;

function userRow(d: DomainContext, userId: string): AppUserRow | undefined {
  return d.sql.exec<AppUserRow>('SELECT * FROM app_users WHERE shopify_user_id = ?', userId).toArray()[0];
}

/**
 * Registers the user of an internal call (first visit) and refreshes its last visit. The first user of
 * the base becomes owner and administrator. Synchronous; no-op for the public API and for a token
 * without user.
 */
export function registerAppUser(d: DomainContext, principal: Principal, now: number): void {
  if (principal.surface !== 'internal' || principal.actor.type !== 'user' || !principal.actor.id) return;
  const id = principal.actor.id;
  const existing = userRow(d, id);
  if (existing) {
    if (now - existing.last_seen_at >= LAST_SEEN_PRECISION_MS) d.sql.exec('UPDATE app_users SET last_seen_at = ? WHERE shopify_user_id = ?', now, id);
    return;
  }
  d.storage.transactionSync(() => {
    const first = d.sql.exec('SELECT 1 FROM app_users LIMIT 1').toArray().length === 0;
    d.sql.exec(
      'INSERT INTO app_users (shopify_user_id, is_owner, is_admin, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (shopify_user_id) DO NOTHING',
      id,
      first ? 1 : 0,
      first ? 1 : 0,
      now,
      now,
    );
    if (first) d.repo.audit(principal.actor, 'app_user.owner', null, { userId: id }, now);
  });
}

/** Role of the caller (15.8). Public API: `admin` scope; internal: `app_users.is_admin`. */
export function roleOf(d: DomainContext, principal: Principal): AppUserRole {
  if (principal.surface === 'public') return principal.scopes === 'all' || principal.scopes.includes('admin') ? 'admin' : 'operator';
  if (principal.actor.type !== 'user' || !principal.actor.id) return 'operator';
  return userRow(d, principal.actor.id)?.is_admin === 1 ? 'admin' : 'operator';
}

/** 403 problem+json for an operator on an administration action (15.8). */
export function requireAdmin(ctx: Pick<ApiContext, 'd' | 'call'>): void {
  if (roleOf(ctx.d, ctx.call.principal) !== 'admin') throw new ApiError(403, 'forbidden', 'admin_required');
}

/** First name of a user for the history (15.8), null when unknown. */
export function firstNameOf(d: DomainContext, userId: string | null): string | null {
  if (!userId) return null;
  return userRow(d, userId)?.first_name ?? null;
}

function present(r: AppUserRow): AppUser {
  return {
    userId: r.shopify_user_id,
    firstName: r.first_name,
    role: r.is_admin === 1 ? 'admin' : 'operator',
    owner: r.is_owner === 1,
    designatedBy: r.designated_by,
    firstSeenAt: new Date(r.first_seen_at).toISOString(),
    lastSeenAt: new Date(r.last_seen_at).toISOString(),
  };
}

export function listAppUsers(ctx: ApiContext): ApiResult {
  const rows = ctx.d.sql.exec<AppUserRow>('SELECT * FROM app_users ORDER BY first_seen_at, shopify_user_id').toArray();
  const body: ListAppUsersResponse = { items: rows.map(present), nextCursor: null };
  return json(body);
}

export function patchAppUser(ctx: ApiContext): ApiResult {
  const body = parseBody<PatchAppUserRequest>(ctx.call);
  if (typeof body.userId !== 'string' || body.userId === '') throw new ApiError(400, 'validation_failed', 'userId required');
  if (body.role !== undefined && body.role !== 'admin' && body.role !== 'operator') throw new ApiError(422, 'validation_failed', 'role must be admin or operator');
  let firstName: string | null | undefined;
  if (body.firstName !== undefined) {
    if (body.firstName !== null && typeof body.firstName !== 'string') throw new ApiError(422, 'validation_failed', 'firstName must be a string or null');
    firstName = body.firstName === null ? null : body.firstName.trim().slice(0, FIRST_NAME_MAX) || null;
  }
  const { d } = ctx;
  const actor = ctx.call.principal.actor;
  const updated = d.storage.transactionSync(() => {
    const before = userRow(d, body.userId);
    // 15.8: only users who already opened the app can be designated.
    if (!before) throw new ApiError(404, 'not_found', 'user_never_opened_the_app');
    let isAdmin = before.is_admin;
    let designatedBy = before.designated_by;
    if (body.role !== undefined) {
      const wantAdmin = body.role === 'admin' ? 1 : 0;
      if (wantAdmin === 0 && before.is_owner === 1) throw new ApiError(422, 'validation_failed', 'owner_is_admin');
      if (wantAdmin === 0 && before.is_admin === 1) {
        const admins = Number(d.sql.exec('SELECT count(*) AS n FROM app_users WHERE is_admin = 1').one().n);
        if (admins <= 1) throw new ApiError(422, 'validation_failed', 'last_admin');
      }
      if (wantAdmin !== before.is_admin) designatedBy = wantAdmin === 1 ? actor.id : null;
      isAdmin = wantAdmin;
    }
    const name = firstName === undefined ? before.first_name : firstName;
    d.sql.exec('UPDATE app_users SET is_admin = ?, designated_by = ?, first_name = ? WHERE shopify_user_id = ?', isAdmin, designatedBy, name, before.shopify_user_id);
    const after = userRow(d, before.shopify_user_id)!;
    d.repo.audit(actor, 'app_user.update', present(before), present(after), ctx.now);
    return after;
  });
  return json(present(updated));
}
