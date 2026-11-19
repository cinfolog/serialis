import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import type { Services } from './api';
import { notifyingWrites, type Me } from './api/client';
import { createDataChanges, DataChangesProvider, LiveProvider, ServicesProvider, SessionContext, useClient, useDataChanges, type SessionValue } from './context';
import { I18nProvider, useI18n } from './i18n';
import { Shell } from './screens/Shell';
import { ROUTE_TABLE } from './routes';
import { Page } from './ui/Page';
import { ErrorState, Loading } from './ui/states';
import { Button } from './ui/components';
import { Link } from './ui/Link';

/** Loads `GET /me` once (locale, role, onboarding, emergency stop) before showing any screen. */
function SessionGate({ children }: { children: React.ReactNode }) {
  const client = useClient();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setMe(await client.me());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // `GET /me` carries the emergency stop, the onboarding step and the extensions already shown (home card):
  // read again after a write and when the app comes back to the foreground (decision 38).
  const changes = useDataChanges();
  useEffect(() => {
    let last = 0;
    const again = () => {
      if (Date.now() - last < 1000 || document.visibilityState === 'hidden') return;
      last = Date.now();
      client.me().then(setMe, () => undefined);
    };
    const unsubscribe = changes.subscribe(() => client.me().then(setMe, () => undefined));
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [changes, client]);

  const value = useMemo<SessionValue | null>(
    () =>
      me && {
        me,
        canAdmin: me.role !== 'operator',
        reload: load,
        setEmergencyStop: (emergencyStop) => setMe((m) => (m ? { ...m, emergencyStop } : m)),
      },
    [me, load],
  );

  if (!me || !value) {
    return error ? (
      <div style={{ padding: 16 }}>
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    ) : (
      <div style={{ padding: 16 }}>
        <Loading />
      </div>
    );
  }
  return (
    <I18nProvider locale={me.locale}>
      <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
    </I18nProvider>
  );
}

/** Unknown route (typed URL, old bookmark): says so and offers the usual destinations (15.7). */
function NotFound() {
  const { t } = useI18n();
  return (
    <Page heading={t('shell.not_found.heading')}>
      <s-section>
        <s-paragraph data-testid="not-found">{t('shell.not_found.body')}</s-paragraph>
        <s-stack direction="inline" gap="base">
          <Link to="/">
            <Button variant="primary">{t('nav.home')}</Button>
          </Link>
          <Link to="/settings/health">
            <Button>{t('shell.not_found.health')}</Button>
          </Link>
        </s-stack>
      </s-section>
    </Page>
  );
}

/** Short URLs kept as aliases of a screen (the query string, App Bridge's `host` included, is kept). */
function Alias({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        {ROUTE_TABLE.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
        <Route path="/health" element={<Alias to="/settings/health" />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="/index.html" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** The whole app below the router: services, live region, session, routes. */
export function App({ services }: { services: Services }) {
  // Every successful write notifies the live queries and the session (decision 38).
  const changes = useMemo(() => createDataChanges(), []);
  const live = useMemo<Services>(() => ({ ...services, client: notifyingWrites(services.client, changes.notify) }), [services, changes]);
  return (
    <DataChangesProvider value={changes}>
      <ServicesProvider services={live}>
        <LiveProvider>
          <SessionGate>
            <AppRoutes />
          </SessionGate>
        </LiveProvider>
      </ServicesProvider>
    </DataChangesProvider>
  );
}
