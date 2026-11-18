import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import type { Services } from './api';
import type { Me } from './api/client';
import { LiveProvider, ServicesProvider, SessionContext, useClient, type SessionValue } from './context';
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

function NotFound() {
  const { t } = useI18n();
  return (
    <Page heading={t('shell.not_found.heading')}>
      <s-section>
        <s-paragraph>{t('shell.not_found.body')}</s-paragraph>
        <Link to="/">
          <Button>{t('nav.home')}</Button>
        </Link>
      </s-section>
    </Page>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        {ROUTE_TABLE.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="/index.html" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** The whole app below the router: services, live region, session, routes. */
export function App({ services }: { services: Services }) {
  return (
    <ServicesProvider services={services}>
      <LiveProvider>
        <SessionGate>
          <AppRoutes />
        </SessionGate>
      </LiveProvider>
    </ServicesProvider>
  );
}
