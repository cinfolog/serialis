import type { Unit } from '@serialis/contract';
import { useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { Banner, Button, Stack, TextField } from './components';

export const normalizeRef = (ref: string) => ref.replace(/\s+/g, '').toUpperCase();

export type Designation =
  | { kind: 'exact'; unit: Unit }
  | { kind: 'suffix'; unit: Unit }
  | { kind: 'ambiguous'; units: Unit[] }
  | { kind: 'none' };

/**
 * Designation rule of spec 15.5: the ref must be typed in full, or by its last 4 characters when
 * they are unique among the proposed units. Nothing here ever validates a suggestion.
 */
export function resolveDesignation(typed: string, candidates: Unit[]): Designation {
  const value = normalizeRef(typed);
  if (!value) return { kind: 'none' };
  const exact = candidates.filter((u) => normalizeRef(u.ref) === value);
  if (exact.length === 1 && exact[0]) return { kind: 'exact', unit: exact[0] };
  if (value.length === 4) {
    const suffix = candidates.filter((u) => normalizeRef(u.ref).endsWith(value));
    if (suffix.length === 1 && suffix[0]) return { kind: 'suffix', unit: suffix[0] };
    if (suffix.length > 1) return { kind: 'ambiguous', units: suffix };
  }
  return { kind: 'none' };
}

export function suggestionsFor(typed: string, candidates: Unit[], limit = 5): Unit[] {
  const value = normalizeRef(typed);
  if (value.length < 3) return [];
  return candidates.filter((u) => normalizeRef(u.ref).includes(value)).slice(0, limit);
}

export interface DesignationInputProps {
  label?: string;
  /** Units that make sense for the action (right variant, location, state). */
  candidates: Unit[];
  /** Full-ref lookup used when the candidate list is truncated or does not contain the typed ref. */
  lookup?: (ref: string) => Promise<Unit | null>;
  /** Called with the ref exactly as typed once the local rule is satisfied; the server decides. */
  onDesignate: (typedRef: string) => Promise<void> | void;
  busy?: boolean;
  disabled?: boolean;
  /** Server-side refusal shown in the live region (message already translated). */
  error?: string | null;
  testId?: string;
}

export function DesignationInput(props: DesignationInputProps) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const designation = useMemo(() => resolveDesignation(value, props.candidates), [value, props.candidates]);
  const suggestions = useMemo(() => suggestionsFor(value, props.candidates), [value, props.candidates]);

  async function submit() {
    if (props.busy || props.disabled || checking) return;
    setMessage(null);
    const typed = value.trim();
    if (!typed) return;
    if (designation.kind === 'ambiguous') return void setMessage(t('desig.ambiguous'));
    if (designation.kind === 'none') {
      // Not in the loaded candidates: a full ref may still exist server-side.
      if (props.lookup && normalizeRef(typed).length > 4) {
        setChecking(true);
        try {
          const found = await props.lookup(typed);
          if (found && normalizeRef(found.ref) === normalizeRef(typed)) {
            await props.onDesignate(typed);
            return;
          }
        } finally {
          setChecking(false);
        }
      }
      return void setMessage(t('desig.no_match'));
    }
    await props.onDesignate(typed);
  }

  const status =
    designation.kind === 'exact' || designation.kind === 'suffix'
      ? t('desig.matched', { ref: designation.unit.ref })
      : designation.kind === 'ambiguous'
        ? t('desig.ambiguous')
        : suggestions.length > 0
          ? t('desig.suggestions', { count: suggestions.length })
          : null;

  return (
    <Stack gap="small">
      <TextField
        label={props.label ?? t('desig.label')}
        value={value}
        onChange={(v) => {
          setValue(v);
          setMessage(null);
        }}
        // Enter submits the TYPED value only: it validates when that value designates a unit exactly (15.5).
        onEnter={() => void submit()}
        details={t('desig.hint')}
        disabled={props.disabled}
        testId={props.testId ?? 'designation-input'}
      />
      <div aria-live="polite" data-testid="designation-status">
        {status ? <s-text>{status}</s-text> : null}
        {designation.kind === 'none' && suggestions.length > 0 ? (
          <ul style={{ margin: 0, paddingInlineStart: 20 }} data-testid="designation-suggestions">
            {suggestions.map((u) => (
              <li key={u.id}>{u.ref}</li>
            ))}
          </ul>
        ) : null}
        {message ? <Banner tone="warning" testId="designation-message">{message}</Banner> : null}
        {props.error ? <Banner tone="critical" testId="designation-error">{props.error}</Banner> : null}
      </div>
      <div>
        <Button variant="primary" onPress={() => void submit()} loading={props.busy || checking} disabled={props.disabled} testId="designation-submit">
          {t('desig.submit')}
        </Button>
      </div>
    </Stack>
  );
}
