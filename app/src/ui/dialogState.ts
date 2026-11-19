/**
 * Diagnostics of the confirmation dialogs (decision 42): which dialogs are open, how each one closed,
 * and the warnings of the safety net. Read-only for everyone else; exposed as `window.__serialisDialogs`
 * so the browser tests (and a merchant's recette, from the console of the app frame) can check that no
 * dialog is left open after a close.
 */

export type DialogCloseReason =
  /** The Cancel button of the dialog. */
  | 'cancel'
  /** Escape, or another close request of the browser (`cancel` event of the native dialog). */
  | 'escape'
  /** The close button (×) in the dialog header. */
  | 'close-button'
  /** The screen set `open` to false (after a confirmation succeeded or failed). */
  | 'program'
  /** The dialog left the page while open (screen left, banner gone). */
  | 'unmount'
  /** The native dialog was closed by something else than the app (kept in sync, never expected). */
  | 'native';

export interface DialogLogEntry {
  id: string;
  heading: string;
  type: 'open' | 'confirm' | 'close' | 'warning';
  reason?: DialogCloseReason;
  detail?: string;
  at: number;
}

export interface DialogDiagnostics {
  /** Dialogs currently open (normally zero or one). */
  readonly open: ReadonlyArray<{ id: string; heading: string }>;
  /** Last events, oldest first (at most `LOG_SIZE`). */
  readonly log: ReadonlyArray<DialogLogEntry>;
  /** Number of times the safety net had to close a dialog that should already have been closed. */
  readonly warnings: number;
}

const LOG_SIZE = 100;

const openDialogs = new Map<string, string>();
const log: DialogLogEntry[] = [];
let warnings = 0;

function push(entry: Omit<DialogLogEntry, 'at'>): void {
  log.push({ ...entry, at: Date.now() });
  if (log.length > LOG_SIZE) log.splice(0, log.length - LOG_SIZE);
}

export function dialogOpened(id: string, heading: string): void {
  openDialogs.set(id, heading);
  push({ id, heading, type: 'open' });
}

export function dialogConfirmed(id: string, heading: string): void {
  push({ id, heading, type: 'confirm' });
}

export function dialogClosed(id: string, heading: string, reason: DialogCloseReason): void {
  openDialogs.delete(id);
  push({ id, heading, type: 'close', reason });
}

export function dialogWarning(id: string, heading: string, detail: string): void {
  warnings += 1;
  push({ id, heading, type: 'warning', detail });
  console.warn(`[serialis] dialog "${heading}" (${id}): ${detail}`);
}

export function isDialogOpen(id: string): boolean {
  return openDialogs.has(id);
}

export function dialogDiagnostics(): DialogDiagnostics {
  return {
    open: [...openDialogs].map(([id, heading]) => ({ id, heading })),
    log: log.map((e) => ({ ...e })),
    warnings,
  };
}

/** Test helper: forgets everything (each test starts from an empty state). */
export function resetDialogDiagnostics(): void {
  openDialogs.clear();
  log.length = 0;
  warnings = 0;
}

declare global {
  interface Window {
    __serialisDialogs?: DialogDiagnostics;
  }
}

if (typeof window !== 'undefined' && !Object.getOwnPropertyDescriptor(window, '__serialisDialogs')) {
  Object.defineProperty(window, '__serialisDialogs', { configurable: true, get: dialogDiagnostics });
}
