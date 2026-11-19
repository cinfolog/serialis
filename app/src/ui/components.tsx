/**
 * Thin typed wrappers over the Polaris web components. They hide the two differences between a
 * React component and a custom element: events are native DOM events read from the host element,
 * and boolean attributes must be omitted (not "false") when off.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { dialogClosed, dialogConfirmed, dialogOpened, dialogWarning, isDialogOpen, type DialogCloseReason } from './dialogState';
import { useElementEvent } from './hooks';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'critical';

const on = (v: boolean | undefined): true | undefined => (v ? true : undefined);

export function Button(props: {
  children: ReactNode;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'tertiary';
  tone?: 'critical' | 'auto';
  loading?: boolean;
  disabled?: boolean;
  slot?: string;
  href?: string;
  target?: string;
  accessibilityLabel?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const blocked = props.disabled || props.loading;
  useElementEvent(ref, 'click', props.onPress && !props.href ? () => { if (!blocked) props.onPress?.(); } : undefined);
  return (
    <s-button
      ref={ref}
      variant={props.variant}
      tone={props.tone}
      loading={on(props.loading)}
      disabled={on(props.disabled)}
      slot={props.slot}
      href={props.href}
      target={props.target}
      accessibilityLabel={props.accessibilityLabel}
      data-testid={props.testId}
    >
      {props.children}
    </s-button>
  );
}

export function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  placeholder?: string;
  details?: string;
  error?: string | undefined;
  hideLabel?: boolean;
  disabled?: boolean;
  inputMode?: 'numeric' | 'text' | 'search';
  testId?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useElementEvent(ref, 'input', (e) => props.onChange((e.currentTarget as HTMLInputElement).value ?? ''));
  useElementEvent(ref, 'keydown', props.onEnter ? (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); props.onEnter?.(); } } : undefined);
  return (
    <s-text-field
      ref={ref}
      label={props.label}
      labelAccessibilityVisibility={props.hideLabel ? 'exclusive' : undefined}
      value={props.value}
      placeholder={props.placeholder}
      details={props.details}
      error={props.error}
      disabled={on(props.disabled)}
      inputMode={props.inputMode}
      autocomplete="off"
      data-testid={props.testId}
    />
  );
}

export function TextArea(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  details?: string;
  error?: string | undefined;
  disabled?: boolean;
  testId?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useElementEvent(ref, 'input', (e) => props.onChange((e.currentTarget as HTMLTextAreaElement).value ?? ''));
  return (
    <s-text-area
      ref={ref}
      label={props.label}
      value={props.value}
      rows={props.rows ?? 6}
      placeholder={props.placeholder}
      details={props.details}
      error={props.error}
      disabled={on(props.disabled)}
      data-testid={props.testId}
    />
  );
}

export function Select(props: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  details?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useElementEvent(ref, 'change', (e) => props.onChange((e.currentTarget as HTMLSelectElement).value));
  return (
    <s-select ref={ref} label={props.label} value={props.value} disabled={on(props.disabled)} details={props.details} data-testid={props.testId}>
      {props.options.map((o) => (
        <s-option key={o.value} value={o.value} selected={on(o.value === props.value)}>
          {o.label}
        </s-option>
      ))}
    </s-select>
  );
}

export function Checkbox(props: { label: string; checked: boolean; onChange: (checked: boolean) => void; details?: string; disabled?: boolean; testId?: string }) {
  const ref = useRef<HTMLElement>(null);
  useElementEvent(ref, 'change', (e) => props.onChange(Boolean((e.currentTarget as HTMLInputElement).checked)));
  return <s-checkbox ref={ref} label={props.label} checked={on(props.checked)} details={props.details} disabled={on(props.disabled)} data-testid={props.testId} />;
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <s-badge tone={tone}>{children}</s-badge>;
}

export function Banner(props: { tone?: Tone; heading?: string; children?: ReactNode; testId?: string }) {
  return (
    <s-banner tone={props.tone ?? 'info'} heading={props.heading} data-testid={props.testId}>
      {props.children}
    </s-banner>
  );
}

export function Stack(props: { children: ReactNode; direction?: 'inline' | 'block'; gap?: string; alignItems?: string; justifyContent?: string }) {
  return (
    <s-stack direction={props.direction ?? 'block'} gap={props.gap ?? 'base'} alignItems={props.alignItems} justifyContent={props.justifyContent}>
      {props.children}
    </s-stack>
  );
}

export function Section(props: { heading?: string; children: ReactNode; padding?: string; id?: string }) {
  return (
    <s-section heading={props.heading} padding={props.padding} id={props.id}>
      {props.children}
    </s-section>
  );
}

/** Element that has the keyboard focus, looking inside open shadow roots. */
function deepActiveElement(): HTMLElement | null {
  let a: Element | null = document.activeElement;
  while (a && (a as HTMLElement).shadowRoot?.activeElement) a = (a as HTMLElement).shadowRoot!.activeElement;
  return a instanceof HTMLElement ? a : null;
}

/** True when `node` is `root` or inside it, through open shadow roots. */
function containsDeep(root: Element, node: Node | null): boolean {
  for (let n: Node | null = node; n; n = n.parentNode ?? ((n as ShadowRoot).host ?? null)) if (n === root) return true;
  return false;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
/** Keyboard stops of the dialog, in order: native controls and Polaris controls (their own focus is inside). */
const STOPS = `${FOCUSABLE}, s-button, s-link, s-text-field, s-text-area, s-select, s-checkbox`;

function tabStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(STOPS)].filter((el) => !el.hasAttribute('disabled') && !(el.parentElement?.closest('s-button, s-link, s-text-field, s-text-area, s-select, s-checkbox')));
}

/** Focuses a stop: the native control inside a Polaris host when there is one, else the host. */
function focusStop(el: HTMLElement): void {
  const inner = el.shadowRoot?.querySelector<HTMLElement>(FOCUSABLE);
  (inner ?? el).focus();
}

let dialogSeq = 0;

/** Time after a close at which the safety net checks that the dialog really is closed (decision 42). */
export const DIALOG_CHECK_MS = 300;

const DIALOG_STYLE_ID = 'serialis-dialog-style';
/** Polaris-like look of the in-frame dialog (values of the admin modal: surface, radius, shadow, spacing). */
const DIALOG_CSS = `
.serialis-dialog { padding: 0; border: 0; border-radius: 12px; width: min(620px, calc(100% - 32px)); max-width: none; max-height: calc(100% - 32px); background: #fff; color: #303030; box-shadow: 0 20px 20px -8px rgba(26, 26, 26, .28), 0 0 0 1px rgba(0, 0, 0, .08); font: 13px/20px Inter, -apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif; overflow: hidden; }
.serialis-dialog[open] { display: flex; flex-direction: column; }
.serialis-dialog::backdrop { background: rgba(0, 0, 0, .5); }
.serialis-dialog:focus-visible { outline: 2px solid #005bd3; outline-offset: 2px; }
.serialis-dialog__header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 12px 12px 16px; background: #f3f3f3; border-bottom: 1px solid #e3e3e3; }
.serialis-dialog__heading { margin: 0; font-size: 14px; line-height: 20px; font-weight: 650; overflow-wrap: anywhere; }
.serialis-dialog__close { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: #4a4a4a; cursor: pointer; }
.serialis-dialog__close:hover { background: rgba(0, 0, 0, .06); }
.serialis-dialog__close:focus-visible { outline: 2px solid #005bd3; outline-offset: 1px; }
.serialis-dialog__body { padding: 16px; overflow: auto; overflow-wrap: anywhere; }
.serialis-dialog__footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 12px 16px; border-top: 1px solid #e3e3e3; }
`;

function ensureDialogStyle(): void {
  if (document.getElementById(DIALOG_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = DIALOG_STYLE_ID;
  style.textContent = DIALOG_CSS;
  document.head.appendChild(style);
}

interface ConfirmDialogProps {
  open: boolean;
  heading: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone?: 'critical';
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Modal confirmation that names the exact effect (15.1, 15.7), drawn INSIDE the app frame (decision 42).
 *
 * It is a native `<dialog>` opened with `showModal()`, never a Polaris `s-modal`: an `s-modal` makes the
 * Shopify admin grey its own top bar and menu through App Bridge, a state the app can neither read nor
 * repair, and that state stayed stuck after every close in the real admin (decisions 33, 42). Here the
 * backdrop and the inert page belong to the app document only, and the browser releases both as soon
 * as the dialog is closed or removed.
 * - the dialog is in the page while `open` is true, and only then; its content is rendered in a portal
 *   on `document.body`, so no Polaris container can clip or hide it;
 * - Cancel, Escape (wherever the focus is, decision 34) and the close button call `onClose`; the screen
 *   sets `open` to false, which closes and removes the dialog: one path for every close;
 * - Tab and Shift+Tab stay inside the dialog; on close the focus goes back to the control that opened it
 *   (or to the main region if that control left the page);
 * - after every close, a safety net checks that the dialog really is closed, closes it otherwise and
 *   logs a warning; `window.__serialisDialogs` exposes the state.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  // Read by the open dialog's cleanup: still true there when the dialog leaves the page with its screen.
  const openRef = useRef(props.open);
  openRef.current = props.open;
  return props.open ? <OpenDialog {...props} openRef={openRef} /> : null;
}

function OpenDialog(props: ConfirmDialogProps & { openRef: { current: boolean } }) {
  const t = useT();
  // One id per opening (the safety net tells a closed dialog from the next one).
  const [id] = useState(() => `serialis-dialog-${++dialogSeq}`);
  const ref = useRef<HTMLDialogElement>(null);
  const reason = useRef<DialogCloseReason | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const requestClose = useCallback((why: DialogCloseReason) => {
    if (!latest.current.openRef.current) return;
    reason.current ??= why;
    latest.current.onClose();
  }, []);

  // Open in the commit that inserts the dialog; close (and check) in the cleanup, whatever the cause.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    ensureDialogStyle();
    const active = deepActiveElement();
    const returnFocus = active && active !== document.body && !containsDeep(el, active) ? active : null;
    if (typeof el.showModal === 'function') el.showModal();
    else el.setAttribute('open', '');
    const heading = latest.current.heading;
    dialogOpened(id, heading);
    return () => {
      const why: DialogCloseReason = reason.current ?? (latest.current.openRef.current ? 'unmount' : 'program');
      reason.current = null;
      closeNow(el);
      dialogClosed(id, heading, why);
      // After the commit: the control that opened the dialog may be re-rendered or removed in the same one.
      queueMicrotask(() => {
        const now = deepActiveElement();
        const lost = now === null || now === document.body || containsDeep(el, now) || !now.isConnected;
        if (!lost) return;
        if (returnFocus?.isConnected) returnFocus.focus();
        else document.getElementById('main')?.focus();
      });
      // Safety net: shortly after, no dialog of the app may still be open unless it is listed as open
      // (this one is not any more), and this one must be out of the list.
      setTimeout(() => {
        for (const stuck of document.querySelectorAll<HTMLDialogElement>('dialog.serialis-dialog[open]')) {
          if (isDialogOpen(stuck.id)) continue;
          closeNow(stuck);
          dialogWarning(stuck.id || id, stuck.id === id ? heading : stuck.id, `still open ${DIALOG_CHECK_MS} ms after a close (${why}), closed again`);
        }
        if (isDialogOpen(id)) {
          dialogClosed(id, heading, why);
          dialogWarning(id, heading, `still listed as open ${DIALOG_CHECK_MS} ms after its close (${why})`);
        }
      }, DIALOG_CHECK_MS);
    };
  }, [id]);

  // Escape closes without acting, wherever the focus is (inside the dialog, in a Polaris shadow root,
  // or lost to the page). Capture phase: runs before Polaris and the page handlers (decision 34).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      requestClose('escape');
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [requestClose]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const stops = tabStops(ref.current);
    const active = deepActiveElement();
    const at = stops.findIndex((s) => containsDeep(s, active));
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) {
      e.preventDefault();
      ref.current.focus();
    } else if (e.shiftKey && at <= 0) {
      e.preventDefault();
      focusStop(last);
    } else if (!e.shiftKey && (at === -1 || at === stops.length - 1)) {
      e.preventDefault();
      focusStop(first);
    }
  };

  const confirm = () => {
    dialogConfirmed(id, latest.current.heading);
    latest.current.onConfirm();
  };

  return createPortal(
    <dialog
      ref={ref}
      id={id}
      className="serialis-dialog"
      aria-labelledby={`${id}-heading`}
      tabIndex={-1}
      data-testid="dialog-root"
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        // Close request of the browser (Escape not seen by the document listener, Android back): the
        // screen decides, through `onClose`, like for every other close.
        e.preventDefault();
        requestClose('escape');
      }}
      onClose={(e) => {
        // A `close` event is queued: it is stale when the dialog is open again (development double mount).
        if (!e.currentTarget.hasAttribute('open')) requestClose('native');
      }}
    >
      <header className="serialis-dialog__header">
        <h2 id={`${id}-heading`} className="serialis-dialog__heading" data-testid="dialog-heading">
          {props.heading}
        </h2>
        <button type="button" className="serialis-dialog__close" aria-label={t('common.close')} data-testid="dialog-close" onClick={() => requestClose('close-button')}>
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M13.97 15.03a.75.75 0 1 0 1.06-1.06l-3.97-3.97 3.97-3.97a.75.75 0 0 0-1.06-1.06l-3.97 3.97-3.97-3.97a.75.75 0 0 0-1.06 1.06l3.97 3.97-3.97 3.97a.75.75 0 1 0 1.06 1.06l3.97-3.97 3.97 3.97Z" />
          </svg>
        </button>
      </header>
      <div className="serialis-dialog__body">{props.children}</div>
      <footer className="serialis-dialog__footer">
        <Button variant="secondary" testId="dialog-cancel" onPress={() => requestClose('cancel')}>
          {props.cancelLabel}
        </Button>
        <Button variant="primary" tone={props.tone} loading={props.busy} testId="dialog-confirm" onPress={confirm}>
          {props.confirmLabel}
        </Button>
      </footer>
    </dialog>,
    document.body,
  );
}

/** Closes a native dialog now (or drops the `open` attribute where `close()` does not exist). */
function closeNow(el: HTMLDialogElement): void {
  if (!el.hasAttribute('open')) return;
  if (typeof el.close === 'function') el.close();
  else el.removeAttribute('open');
}
