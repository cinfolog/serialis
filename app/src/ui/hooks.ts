import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DependencyList, type RefObject } from 'react';
import { useDataChanges } from '../context';

/**
 * Subscribes to a DOM event of a custom element. Polaris web components emit their own events
 * (`input`, `change`, ...) on the host element, so listeners are attached natively: the handler
 * is always the latest one, without re-subscribing on every render.
 */
export function useElementEvent<E extends Event = Event>(
  ref: RefObject<HTMLElement | null>,
  type: string,
  handler: ((event: E) => void) | undefined,
): void {
  const latest = useRef(handler);
  latest.current = handler;
  const active = handler !== undefined;
  // Layout effect: the listener must be attached in the same commit as the element, never after paint.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const listener = (event: Event) => latest.current?.(event as E);
    el.addEventListener(type, listener);
    return () => el.removeEventListener(type, listener);
  }, [ref, type, active]);
}

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  /** Replaces the data with a value the caller already has (e.g. the response of a write), without a new request. */
  replace: (data: T) => void;
}

export interface AsyncOptions {
  /**
   * Live data (decision 38): refetched in the background after every successful write of the app, when the
   * window gets the focus back or the page becomes visible again, and every `pollMs` while visible.
   */
  live?: boolean;
  /** Light polling while the page is visible (anomalies and home screens: 30 s). */
  pollMs?: number;
}

/** Polling period of the anomalies and home screens while visible (decision 38). */
export const LIVE_POLL_MS = 30_000;

/** Background refetches closer than this are merged (focus and visibility often fire together). */
const REFRESH_DEBOUNCE_MS = 1000;

/**
 * Runs `fn` on mount and when `deps` change; keeps the previous data while reloading. A background refresh
 * (live data) replaces the data only: it never shows a loading state, never replaces data with an error,
 * and never touches what the user typed (decision 29: typed state lives in the screens, not here).
 */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList, options: AsyncOptions = {}): AsyncState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: undefined, loading: true });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // Only the answer of the latest request is applied (a slow refresh never overwrites a newer load).
  const seq = useRef(0);
  const lastRefresh = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fnRef.current().then(
      (data) => {
        if (seq.current === mine) setState({ data, error: undefined, loading: false });
      },
      (error: unknown) => {
        if (seq.current === mine) setState((s) => ({ data: s.data, error, loading: false }));
      },
    );
    return () => {
      // Deps changed or unmounted: an answer still in flight is dropped.
      if (seq.current === mine) seq.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const replace = useCallback((data: T) => {
    seq.current++;
    setState({ data, error: undefined, loading: false });
  }, []);

  const refresh = useCallback((force: boolean) => {
    const now = Date.now();
    if (!force && now - lastRefresh.current < REFRESH_DEBOUNCE_MS) return;
    lastRefresh.current = now;
    const mine = ++seq.current;
    fnRef.current().then(
      (data) => {
        if (seq.current === mine) setState({ data, error: undefined, loading: false });
      },
      () => undefined, // keep what is shown; the next refresh or a reload will tell
    );
  }, []);

  const changes = useDataChanges();
  const { live = false, pollMs } = options;
  useEffect(() => {
    if (!live) return;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const onWrite = () => refresh(true);
    const onFocus = () => visible() && refresh(false);
    const unsubscribe = changes.subscribe(onWrite);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const timer = pollMs ? setInterval(() => visible() && refresh(true), pollMs) : undefined;
    return () => {
      unsubscribe();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      if (timer) clearInterval(timer);
    };
  }, [live, pollMs, changes, refresh]);

  return { ...state, reload, replace };
}

/** True once `active` has been true for `ms` milliseconds ("Encore un instant", 15.7). */
export function useSlow(active: boolean, ms = 3000): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return slow;
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
