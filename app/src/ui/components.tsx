/**
 * Thin typed wrappers over the Polaris web components. They hide the two differences between a
 * React component and a custom element: events are native DOM events read from the host element,
 * and boolean attributes must be omitted (not "false") when off.
 */
import { useEffect, useRef, type ReactNode } from 'react';
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

/**
 * Modal confirmation that names the exact effect (15.1, 15.7). Rendered only while open; the
 * Polaris modal is shown on mount and `onClose` is called when it is dismissed.
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
  const ref = useRef<HTMLElement & { showOverlay?: () => void; hideOverlay?: () => void }>(null);
  useEffect(() => {
    if (!props.open) return;
    const el = ref.current;
    el?.showOverlay?.();
    return () => el?.hideOverlay?.();
  }, [props.open]);
  useElementEvent(ref, 'afterhide', props.open ? () => props.onClose() : undefined);
  if (!props.open) return null;
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
