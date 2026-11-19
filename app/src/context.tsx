import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Services } from './api';
import type { ApiClient, Me } from './api/client';
import { showToast } from './shopify';

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesProvider is missing');
  return s;
}

export function useClient(): ApiClient {
  return useServices().client;
}

// ---------------------------------------------------------------------------
// Data changes: every successful write of the app notifies the live queries (decision 38)
// ---------------------------------------------------------------------------

type Listener = () => void;

export interface DataChanges {
  subscribe: (listener: Listener) => () => void;
  notify: () => void;
}

export function createDataChanges(): DataChanges {
  const listeners = new Set<Listener>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => {
      for (const l of [...listeners]) l();
    },
  };
}

const DataChangesContext = createContext<DataChanges>(createDataChanges());

export function DataChangesProvider({ value, children }: { value: DataChanges; children: ReactNode }) {
  return <DataChangesContext.Provider value={value}>{children}</DataChangesContext.Provider>;
}

export function useDataChanges(): DataChanges {
  return useContext(DataChangesContext);
}

// ---------------------------------------------------------------------------
// Session (GET /me): locale, role, onboarding, emergency stop
// ---------------------------------------------------------------------------

export interface SessionValue {
  me: Me;
  /** Same rule as the API: only operators are restricted (15.8); a missing role means admin. */
  canAdmin: boolean;
  reload: () => Promise<void>;
  setEmergencyStop: (value: boolean) => void;
}

export const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const s = useContext(SessionContext);
  if (!s) throw new Error('SessionContext is missing');
  return s;
}

// ---------------------------------------------------------------------------
// Screen-reader announcements (aria-live, 15.9) and toasts
// ---------------------------------------------------------------------------

interface LiveValue {
  announce: (message: string, options?: { toast?: boolean; error?: boolean }) => void;
}

const LiveContext = createContext<LiveValue>({ announce: () => undefined });

export function LiveProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const counter = useRef(0);
  const announce = useCallback<LiveValue['announce']>((text, options) => {
    // Alternate a zero-width space so that announcing the same text twice still triggers a read.
    counter.current += 1;
    setMessage(counter.current % 2 === 0 ? `${text}​` : text);
    if (options?.toast) showToast(text, options.error ?? false);
  }, []);
  const value = useMemo(() => ({ announce }), [announce]);
  return (
    <LiveContext.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" aria-atomic="true" data-testid="live-region" style={visuallyHidden}>
        {message}
      </div>
    </LiveContext.Provider>
  );
}

export function useAnnounce(): LiveValue['announce'] {
  return useContext(LiveContext).announce;
}

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

export { visuallyHidden };

/** Moves focus to the page heading when the screen changes (logical focus order, 15.9). */
export function useFocusOnMount(): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}
