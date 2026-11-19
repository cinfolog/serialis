/**
 * Readable labels for the stable keys the Worker returns (15.9: a merchant never reads a technical
 * key). Every key listed by the contract (`SETTINGS_SIMULATION_SUMMARIES`, `UNIT_EVENT_TYPES`,
 * `UNIT_EVENT_REASONS`, `STOCK_QUANTITY_NAMES`) has a text in both languages (`i18n.test.ts`); a
 * value the app does not know yet (newer Worker) gets a generic label, never the raw key.
 */
import { PROBLEM_DETAIL_KEYS, UNIT_EVENT_NO_WRITE, type ProblemDetailKey, type SettingsSimulation, type UnitEvent } from '@serialis/contract';
import type { I18n } from './i18n';

type Labels = Pick<I18n, 't' | 'tMaybe' | 'number'>;

export function simulationEffectLabel(i18n: Labels, effect: SettingsSimulation['effects'][number]): string {
  return i18n.tMaybe(`settings.simulation.effect.${effect.summary}`, { count: effect.count }) ?? i18n.t('settings.simulation.effect.unknown');
}

export function unitEventTypeLabel(i18n: Labels, type: string): string {
  return i18n.tMaybe(`unit.event.${type}`) ?? i18n.t('unit.event.unknown');
}

export function unitEventReasonLabel(i18n: Labels, reason: string | null): string | null {
  if (reason === null || reason === '') return null;
  return i18n.tMaybe(`unit.reason.${reason}`) ?? i18n.t('unit.reason.unknown');
}

/** Actor of an event: a first name is shown as is; the generic actors of the Worker are translated. */
export function unitEventActorLabel(i18n: Labels, actor: string): string {
  return i18n.tMaybe(`unit.actor.${actor}`) ?? actor;
}

export function stockQuantityLabel(i18n: Labels, name: string): string {
  return i18n.tMaybe(`unit.quantity.${name}`) ?? i18n.t('unit.quantity.unknown');
}

export function unitEventStockLabel(i18n: Labels, event: Pick<UnitEvent, 'stockEffect' | 'stockDelta' | 'stockQuantity'>): string | null {
  if (typeof event.stockDelta === 'number') {
    const delta = `${event.stockDelta > 0 ? '+' : ''}${i18n.number(event.stockDelta)}`;
    return i18n.t('unit.stock.delta', { delta, quantity: stockQuantityLabel(i18n, event.stockQuantity ?? 'available') });
  }
  if (event.stockEffect === null || event.stockEffect === undefined) return null;
  if (event.stockEffect === UNIT_EVENT_NO_WRITE) return i18n.t('unit.stock.no_write');
  // Older Worker without the structured fields: "+1 available".
  const m = /^([+-]?\d+) (\w+)$/.exec(event.stockEffect);
  if (m) return i18n.t('unit.stock.delta', { delta: m[1]!.startsWith('-') ? m[1]! : `+${m[1]!.replace('+', '')}`, quantity: stockQuantityLabel(i18n, m[2]!) });
  return i18n.t('unit.stock.unknown');
}

const DETAIL_KEYS: ReadonlySet<string> = new Set<string>(PROBLEM_DETAIL_KEYS);

/** Stable detail key of the contract at the start of a server detail (`duplicate_in_file (row 3)` → `duplicate_in_file`). */
export function detailKey(detail: string | undefined | null): ProblemDetailKey | null {
  const m = detail ? /^([a-z_]+)\b/.exec(detail) : null;
  return m && DETAIL_KEYS.has(m[1]!) ? (m[1] as ProblemDetailKey) : null;
}

/**
 * Message of an error code and its detail (15.7: what happened, what to do). A known detail key has its
 * own message, which replaces the generic text of the code (`no_usable_deficit` → "No gap in Shopify at
 * this location…"); a readable server sentence is appended; any other key-like detail is dropped.
 */
export function problemMessage(i18n: Labels, code: string, detail?: string | null): string {
  const key = detailKey(detail);
  if (key) return i18n.t(`error.detail.${key}`);
  const base = i18n.tMaybe(`error.${code}`) ?? i18n.t('error.unknown');
  return detail && /\s/.test(detail.trim()) ? `${base} ${detail}` : base;
}
