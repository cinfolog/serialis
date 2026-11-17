import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { hasMessage, translate, type BaseKey, type Locale, type Params } from './core';
import { anomalies } from './messages/anomalies';
import { common } from './messages/common';
import { home } from './messages/home';
import { refs } from './messages/refs';
import { shell } from './messages/shell';
import { tracked } from './messages/tracked';
import { units } from './messages/units';
import { wizard } from './messages/wizard';

const modules = [common, shell, home, refs, wizard, units, tracked, anomalies];

const fr = Object.assign({}, ...modules.map((m) => m.fr)) as typeof common.fr & typeof shell.fr & typeof home.fr & typeof refs.fr & typeof wizard.fr & typeof units.fr & typeof tracked.fr & typeof anomalies.fr;
const en = Object.assign({}, ...modules.map((m) => m.en)) as typeof common.en & typeof shell.en & typeof home.en & typeof refs.en & typeof wizard.en & typeof units.en & typeof tracked.en & typeof anomalies.en;

export const dictionaries: Record<Locale, Record<string, string>> = { fr, en };

export type MessageKey = BaseKey<typeof fr>;

export interface I18n {
  locale: Locale;
  t: (key: MessageKey, params?: Params) => string;
  /** Looks a key up that may not exist (e.g. server-provided codes); returns undefined when absent. */
  tMaybe: (key: string, params?: Params) => string | undefined;
  date: (iso: string) => string;
  dateTime: (iso: string) => string;
  number: (n: number) => string;
  percent: (ratio: number) => string;
}

export function createI18n(locale: Locale): I18n {
  const dict = dictionaries[locale];
  return {
    locale,
    t: (key, params) => translate(dict, locale, key, params),
    tMaybe: (key, params) => (hasMessage(dict, key) ? translate(dict, locale, key, params) : undefined),
    date: (iso) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso)),
    dateTime: (iso) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)),
    number: (n) => new Intl.NumberFormat(locale).format(n),
    percent: (ratio) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(ratio),
  };
}

const I18nContext = createContext<I18n>(createI18n('fr'));

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => createI18n(locale), [locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}

export function useT(): I18n['t'] {
  const { t } = useI18n();
  return useCallback<I18n['t']>((key, params) => t(key, params), [t]);
}

export type { Locale, Params };
