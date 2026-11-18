import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export type ResourceState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: unknown };

/** Loads an async resource on mount and whenever `deps` change; `reload()` refetches (keeping shown data). */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): ResourceState<T> & { reload: () => void } {
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const ctrl = new AbortController();
    loadRef.current(ctrl.signal).then(
      (data) => {
        if (!ctrl.signal.aborted) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (!ctrl.signal.aborted) setState({ status: 'error', error });
      },
    );
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

/** True when the browser reports being online (banner and blocked submissions otherwise, 15.7). */
export function useOnline(): boolean {
  const read = () => (typeof navigator === 'undefined' || navigator.onLine === undefined ? true : navigator.onLine);
  const [online, setOnline] = useState(read);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    globalThis.addEventListener?.('online', up);
    globalThis.addEventListener?.('offline', down);
    return () => {
      globalThis.removeEventListener?.('online', up);
      globalThis.removeEventListener?.('offline', down);
    };
  }, []);
  return online;
}

/** Becomes true once `active` has stayed true for `ms` ("Encore un instant" after 3 s, 15.7). */
export function useSlow(active: boolean, ms = 3000): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const id = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(id);
  }, [active, ms]);
  return slow;
}
