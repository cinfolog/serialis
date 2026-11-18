/**
 * Thin typed wrappers over the Polaris web components. They hide the two differences between a
 * React component and a custom element: events are native DOM events read from the host element,
 * and boolean attributes must be omitted (not "false") when off.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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

type ModalElement = HTMLElement & { showOverlay?: () => void; hideOverlay?: () => void };

/** Element that has the keyboard focus, looking inside open shadow roots. */
function deepActiveElement(): HTMLElement | null {
  let a: Element | null = document.activeElement;
  while (a && (a as HTMLElement).shadowRoot?.activeElement) a = (a as HTMLElement).shadowRoot!.activeElement;
  return a instanceof HTMLElement ? a : null;
}

/** Cancels a pending fallback timer, if any. */
function clear(timer: { current: ReturnType<typeof setTimeout> | null }) {
  if (timer.current !== null) clearTimeout(timer.current);
  timer.current = null;
}

/** Time given to Polaris to send `afterhide` before the modal leaves the document anyway. */
const AFTERHIDE_FALLBACK_MS = 1000;

/**
 * Modal confirmation that names the exact effect (15.1, 15.7).
 *
 * In the admin, a shown `s-modal` greys the Shopify top bar and menu until it is hidden, so the
 * element must never leave the document while shown (decision 33). Rules:
 * - `open` true: the element is rendered and shown (`showOverlay`) in a layout effect;
 * - `open` false: `hideOverlay()` is called while the element is still in the document; the element
 *   and its content stay until `afterhide` (or a fallback delay), then leave; the focus goes back to
 *   the control that opened the dialog when it is lost;
 * - a close decided by Polaris (its close button, its own Escape) arrives as `hide` / `afterhide`
 *   and calls `onClose`, so the app state always follows;
 * - unmounting while shown (screen left, banner gone) hides the modal in the layout-effect cleanup,
 *   which React runs before it removes the element;
 * - Escape closes without acting, wherever the focus is while the dialog is open (decision 34).
 * Every close of the app goes through `onClose` → `open` false: one path for Cancel, Escape,
 * success and error.
 */
export function ConfirmDialog(props: {
  open: boolean;
  heading: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone?: 'critical';
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<ModalElement>(null);
  const [mounted, setMounted] = useState(props.open);
  if (props.open && !mounted) setMounted(true); // adjusted during render, no effect (decision 29)
  const openRef = useRef(props.open);
  openRef.current = props.open;
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  const shown = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finish = useCallback(() => {
    clear(fallback);
    shown.current = false;
    setMounted(false);
    const target = returnFocus.current;
    returnFocus.current = null;
    const el = ref.current;
    const active = deepActiveElement();
    const lost = active === null || active === document.body || (el !== null && (el === active || el.contains(active)));
    if (target?.isConnected && lost) target.focus();
  }, []);

  // Show and hide follow `open`; layout effect: same commit as the element, before paint.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (props.open) {
      clear(fallback);
      if (!shown.current) {
        const active = deepActiveElement();
        if (active && !el.contains(active)) returnFocus.current = active;
        shown.current = true;
        el.showOverlay?.();
      }
      return;
    }
    if (!shown.current || typeof el.hideOverlay !== 'function') {
      // Already hidden by Polaris, or element not upgraded (no Polaris): nothing to wait for.
      finish();
      return;
    }
    el.hideOverlay();
    clear(fallback);
    fallback.current = setTimeout(finish, AFTERHIDE_FALLBACK_MS);
  }, [props.open, mounted, finish]);

  // Unmounted while shown: hide first. React runs layout-effect cleanups of a removed subtree
  // before it detaches the host element, so the modal can still reach the admin.
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      clear(fallback);
      if (shown.current) {
        shown.current = false;
        el?.hideOverlay?.();
      }
    };
  }, [mounted]);

  // Close decided by Polaris (close button, its own Escape handling).
  useElementEvent(ref, 'hide', mounted ? () => { if (openRef.current) onClose.current(); } : undefined);
  useElementEvent(ref, 'afterhide', mounted ? () => {
    shown.current = false;
    if (openRef.current) onClose.current();
    else finish();
  } : undefined);

  // Escape closes without acting, wherever the focus is (inside the modal, in its shadow root,
  // or lost to the page behind). Capture phase: runs before Polaris and the page handlers.
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !openRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      onClose.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [props.open]);

  if (!mounted) return null;
  return (
    <s-modal ref={ref} heading={props.heading} role="dialog" aria-modal="true">
      {props.children}
      <Button slot="primary-action" variant="primary" tone={props.tone} loading={props.busy} testId="dialog-confirm" onPress={props.onConfirm}>
        {props.confirmLabel}
      </Button>
      <Button slot="secondary-actions" testId="dialog-cancel" onPress={props.onClose}>
        {props.cancelLabel}
      </Button>
    </s-modal>
  );
}
