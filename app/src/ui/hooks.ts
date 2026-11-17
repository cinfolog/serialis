import { useCallback, useEffect, useRef, useState, type DependencyList, type RefObject } from 'react';

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
  useEffect(() => {
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
}

/** Runs `fn` on mount and when `deps` change; keeps the previous data while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: undefined, loading: true });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fnRef.current().then(
      (data) => {
        if (!cancelled) setState({ data, error: undefined, loading: false });
      },
      (error: unknown) => {
        if (!cancelled) setState((s) => ({ data: s.data, error, loading: false }));
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
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
