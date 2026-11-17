/**
 * Structured logs (Workers Logs, spec 17.1). Only scalar fields: never pass a token, a session
 * token, a webhook body or customer data here.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function logEvent(level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Error message safe for logs and `last_error` columns (bounded length). */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 500);
}
