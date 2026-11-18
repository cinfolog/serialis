import { useMemo } from 'preact/hooks';
import {
  MAX_SUGGESTIONS,
  resolveDesignation,
  suggestRefs,
  unitForEnter,
  type Designable,
  type Resolution,
} from '../designation';
import type { Translate } from '../i18n';
import { aria } from './common';

export interface DesignationInputProps<U extends Designable> {
  t: Translate;
  /** Field label (also its accessible name). */
  label: string;
  /** Units that make sense for the action (right variant, location, state). */
  candidates: readonly U[];
  value: string;
  /** Called on every edit with the new text and what it designates. */
  onChange: (value: string, resolution: Resolution<U>) => void;
  /** Called when Enter is pressed on a typed ref that designates exactly one unit. */
  onEnter?: (unit: U) => void;
  /** Extra text shown next to a suggestion (location, reception date...). */
  describe?: (unit: U) => string;
  disabled?: boolean;
}

/** Message key describing a resolution (announced in an aria-live region, 15.9). */
export function resolutionMessageKey(r: Resolution<Designable>): string | null {
  switch (r.kind) {
    case 'empty': return null;
    case 'exact': return 'designation.exact';
    case 'suffix': return 'designation.suffix';
    case 'ambiguous': return 'designation.ambiguous';
    case 'too_short': return 'designation.tooShort';
    case 'unknown': return 'designation.unknown';
  }
}

/**
 * Ref input with autocomplete (15.5): suggestions from 3 characters, a click on a suggestion only fills the
 * field, and Enter submits only a typed ref that designates one unit (full ref, or its unique last 4 characters).
 */
export function DesignationInput<U extends Designable>(props: DesignationInputProps<U>) {
  const { t, candidates, value, disabled } = props;
  const resolution = useMemo(() => resolveDesignation(value, candidates), [value, candidates]);
  const suggestions = useMemo(
    () => (resolution.kind === 'exact' ? [] : suggestRefs(value, candidates, {}, MAX_SUGGESTIONS)),
    [value, candidates, resolution.kind],
  );
  const key = resolutionMessageKey(resolution);
  const message =
    key === null
      ? ''
      : resolution.kind === 'exact' || resolution.kind === 'suffix'
        ? t(key, { ref: resolution.unit.ref })
        : t(key, { count: resolution.kind === 'ambiguous' ? resolution.units.length : 0 });

  const edit = (next: string) => props.onChange(next, resolveDesignation(next, candidates));
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || disabled) return;
    const unit = unitForEnter(value, candidates);
    if (unit) {
      event.preventDefault();
      props.onEnter?.(unit);
    }
  };

  return (
    <s-stack gap="small-200">
      <s-box {...({ onKeyDown: keydown } as Record<string, unknown>)}>
        <s-text-field
          label={props.label}
          value={value}
          disabled={disabled}
          autocomplete="off"
          onInput={(e: Event) => edit((e.currentTarget as HTMLInputElement).value)}
        />
      </s-box>
      <s-text
        color={resolution.kind === 'exact' || resolution.kind === 'suffix' ? 'base' : 'subdued'}
        {...aria({ 'aria-live': 'polite', 'data-testid': 'designation-status' })}
      >
        {message}
      </s-text>
      {suggestions.length > 0 ? (
        <s-stack gap="small-300" {...aria({ role: 'list', 'aria-label': t('designation.suggestions') })}>
          {suggestions.map((unit) => (
            <s-button
              key={unit.id}
              variant="tertiary"
              disabled={disabled}
              data-suggestion={unit.ref}
              onClick={() => edit(unit.ref)}
            >
              {props.describe ? `${unit.ref} · ${props.describe(unit)}` : unit.ref}
            </s-button>
          ))}
        </s-stack>
      ) : null}
    </s-stack>
  );
}
