/**
 * Structured logs (Workers Logs, spec 17.1). Only scalar fields: never pass a token, a session
 * token, a webhook body or customer data here.
 *
 * Every line carries the context of the shop object and of the task being run (`shop`, `task`,
 * `task_kind`), kept in an AsyncLocalStorage around each entry point of the object (17.1). An order
 * id, which links a unit to a customer, never appears in clear: any `gid://shopify/Order/<n>` in a
 * field is replaced by a keyed digest computed with a secret of the shop (`meta.log_secret`), useless
 * without that shop's base (17.1; workers/DECISIONS.md 63).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { sha256Hex } from './domain/util.js';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface LogContext {
  shop?: string | undefined;
  task?: string;
  task_kind?: string;
  /** Per-shop secret of the order digests; never logged. */
  orderKey?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with these fields added to every log line (nested contexts are merged). */
export function withLogContext<T>(fields: LogContext, fn: () => T): T {
  return storage.run({ ...(storage.getStore() ?? {}), ...fields }, fn);
}

const ORDER_GID = /gid:\/\/shopify\/Order\/(\d+)/g;

/** Replaces Shopify order ids by `order:<digest>` (12 hex characters of a keyed SHA-256). */
export function redactOrders(text: string, key: string | undefined): string {
  return text.replace(ORDER_GID, (_m, id: string) => `order:${sha256Hex(`${key ?? 'serialis'}|order|${id}`).slice(0, 12)}`);
}

export function logEvent(level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}): void {
  const { orderKey, ...context } = storage.getStore() ?? {};
  const merged: LogFields = { level, event, ...context, ...fields };
  for (const [k, v] of Object.entries(merged)) {
    if (typeof v === 'string' && v.includes('gid://shopify/Order/')) merged[k] = redactOrders(v, orderKey);
  }
  const line = JSON.stringify(merged);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Error message safe for logs and `last_error` columns (bounded length). */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 500);
}
