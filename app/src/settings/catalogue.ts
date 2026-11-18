/**
 * MVP settings (spec 19.4: S-05, S-08, S-09, S-11, S-17, S-22, S-25, S-35 to S-38, S-40), as UI
 * data: key, theme, kind, choices, default and the values that weaken a guarantee (6.6.1).
 * S-01 and S-24 are fixed in the MVP and listed apart (FIXED_SETTINGS). Texts live in the message
 * dictionaries under `settings.<key>.*` (question, choice.<id>, effect.<id>, warn.<id>).
 *
 * Value encoding sent to `PATCH /settings` (see app/DECISIONS.md): string identifiers for
 * choices, booleans for yes/no, a number of minutes for S-22. S-36 is two keys (`S-36.strip_spaces`,
 * `S-36.normalize_upper`) and S-37 has an extra `S-37.pattern` key used when the choice is "regex".
 */
export type SettingValueType = string | number | boolean;

export interface Choice {
  id: string;
  value: SettingValueType;
  /** This value weakens a guarantee: the screen announces its exact effect before saving. */
  weakens?: boolean;
}

export type SettingDef =
  | { key: string; theme: Theme; kind: 'choice'; choices: Choice[]; default: SettingValueType }
  | { key: string; theme: Theme; kind: 'minutes'; min: number; max: number; default: number; weakensAbove: number }
  | { key: string; theme: Theme; kind: 'pattern'; default: string; visibleWhen: { key: string; equals: string } };

export type Theme = 'orders' | 'returns' | 'sync' | 'identifiers' | 'notifications';
export const THEMES: Theme[] = ['orders', 'returns', 'sync', 'identifiers', 'notifications'];

const yesNo = (weakNo = false): Choice[] => [
  { id: 'yes', value: true },
  { id: 'no', value: false, ...(weakNo ? { weakens: true } : {}) },
];

export const SETTINGS: SettingDef[] = [
  { key: 'S-05', theme: 'orders', kind: 'choice', default: 'fifo', choices: [{ id: 'fifo', value: 'fifo' }, { id: 'earliest_expiry', value: 'earliest_expiry' }, { id: 'manual', value: 'manual' }] },
  { key: 'S-08', theme: 'orders', kind: 'choice', default: 'last', choices: [{ id: 'last', value: 'last' }, { id: 'first', value: 'first' }] },
  { key: 'S-09', theme: 'orders', kind: 'choice', default: 'to_verify', choices: [{ id: 'to_verify', value: 'to_verify' }, { id: 'auto_resolve', value: 'auto_resolve', weakens: true }] },
  { key: 'S-11', theme: 'orders', kind: 'choice', default: 'ignore', choices: [{ id: 'ignore', value: 'ignore' }, { id: 'process', value: 'process' }] },
  { key: 'S-17', theme: 'returns', kind: 'choice', default: true, choices: yesNo(true) },
  { key: 'S-22', theme: 'sync', kind: 'minutes', min: 5, max: 1440, default: 10, weakensAbove: 10 },
  { key: 'S-25', theme: 'sync', kind: 'choice', default: 'automatic', choices: [{ id: 'automatic', value: 'automatic' }, { id: 'on_decision', value: 'on_decision', weakens: true }] },
  { key: 'S-38', theme: 'sync', kind: 'choice', default: true, choices: yesNo() },
  { key: 'S-35', theme: 'identifiers', kind: 'choice', default: 'shop', choices: [{ id: 'shop', value: 'shop' }, { id: 'product', value: 'product' }] },
  { key: 'S-36.strip_spaces', theme: 'identifiers', kind: 'choice', default: true, choices: yesNo() },
  { key: 'S-36.normalize_upper', theme: 'identifiers', kind: 'choice', default: true, choices: yesNo() },
  { key: 'S-37', theme: 'identifiers', kind: 'choice', default: 'none', choices: [{ id: 'none', value: 'none' }, { id: 'luhn', value: 'luhn' }, { id: 'regex', value: 'regex' }] },
  { key: 'S-37.pattern', theme: 'identifiers', kind: 'pattern', default: '', visibleWhen: { key: 'S-37', equals: 'regex' } },
  { key: 'S-40', theme: 'notifications', kind: 'choice', default: 'owner_digest', choices: [{ id: 'owner_digest', value: 'owner_digest' }, { id: 'owner_no_digest', value: 'owner_no_digest' }] },
];

/** Fixed in the MVP (19.4); shown read-only with their reason. */
export const FIXED_SETTINGS = ['S-01', 'S-24'] as const;

export function choiceFor(def: Extract<SettingDef, { kind: 'choice' }>, value: SettingValueType | undefined): Choice | undefined {
  return def.choices.find((c) => c.value === value);
}

/** The message key of a setting's weakening warning for the given value, or null when it weakens nothing. */
export function weakeningOf(def: SettingDef, value: SettingValueType | undefined): string | null {
  if (def.kind === 'choice') {
    const c = choiceFor(def, value);
    return c?.weakens ? `settings.${def.key}.warn.${c.id}` : null;
  }
  if (def.kind === 'minutes') return typeof value === 'number' && value > def.weakensAbove ? `settings.${def.key}.warn.long` : null;
  return null;
}
