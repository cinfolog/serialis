import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { useAnnounce, useClient, useSession, visuallyHidden } from '../context';
import { useI18n, type MessageKey } from '../i18n';
import { hasAppBridge } from '../shopify';
import { newIdempotencyKey } from '../api/client';
import { Banner, Button, ConfirmDialog, Stack, TextField } from '../ui/components';
import { useOnline } from '../ui/hooks';
import { Link } from '../ui/Link';
import { useErrorMessage } from '../ui/states';

const NAV: Array<{ to: string; label: MessageKey }> = [
  { to: '/', label: 'nav.home' },
  { to: '/units', label: 'nav.units' },
  { to: '/tracked-items', label: 'nav.tracked' },
  { to: '/anomalies', label: 'nav.anomalies' },
  { to: '/imports', label: 'nav.imports' },
  { to: '/settings', label: 'nav.settings' },
];

/** Resume action of the emergency-stop banner (15.4, 15.7): confirmation naming the effect. */
function EmergencyBanner() {
  const { t } = useI18n();
  const client = useClient();
  const { canAdmin, setEmergencyStop } = useSession();
  const announce = useAnnounce();
  const errorMessage = useErrorMessage();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());

  async function resume() {
    setBusy(true);
    setError(null);
    try {
      await client.resume({ idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setEmergencyStop(false);
      setOpen(false);
      announce(t('resume.done'), { toast: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Banner tone="critical" heading={t('banner.emergency.heading')} testId="banner-emergency">
        <Stack gap="small">
          <s-paragraph>{t('banner.emergency.body')}</s-paragraph>
          {canAdmin ? (
            <Button onPress={() => setOpen(true)} testId="resume-open">
              {t('banner.emergency.resume')}
            </Button>
          ) : (
            <s-paragraph>{t('common.read_only_admin')}</s-paragraph>
          )}
        </Stack>
      </Banner>
      <ConfirmDialog
        open={open}
        heading={t('resume.dialog.heading')}
        confirmLabel={t('resume.dialog.confirm')}
        cancelLabel={t('common.cancel')}
        busy={busy}
        onConfirm={() => void resume()}
        onClose={() => setOpen(false)}
      >
        <s-paragraph>{t('resume.dialog.body')}</s-paragraph>
        {error ? <Banner tone="critical">{error}</Banner> : null}
      </ConfirmDialog>
    </>
  );
}

function GlobalSearch() {
  const { t } = useI18n();
  const client = useClient();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [missing, setMissing] = useState<string | null>(null);
  const errorMessage = useErrorMessage();
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const value = q.trim();
    if (!value) return;
    setMissing(null);
    setError(null);
    try {
      const { unit } = await client.lookup(value);
      if (unit) {
        setQ('');
        navigate(`/units/${encodeURIComponent(unit.id)}`);
      } else {
        setMissing(value);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div role="search" aria-label={t('shell.search.label')}>
      <Stack direction="inline" gap="small" alignItems="end">
        <TextField label={t('shell.search.label')} hideLabel value={q} onChange={setQ} onEnter={() => void submit()} placeholder={t('shell.search.placeholder')} testId="global-search" />
        <Button onPress={() => void submit()} testId="global-search-submit">
          {t('shell.search.action')}
        </Button>
      </Stack>
      {missing ? <Banner tone="warning" testId="search-not-found">{t('shell.search.not_found', { q: missing })}</Banner> : null}
      {error ? <Banner tone="critical">{error}</Banner> : null}
    </div>
  );
}

export function Shell() {
  const { t } = useI18n();
  const { me } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const online = useOnline();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Logical focus order: after a screen change, focus goes to the main region.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus();
  }, [location.pathname]);

  // App Bridge navigation (app-nav links) is reported as `shopify:navigate`.
  useEffect(() => {
    const handler = (event: Event) => {
      const href = (event.target as HTMLElement | null)?.getAttribute?.('href');
      if (href?.startsWith('/')) navigate(href);
    };
    document.addEventListener('shopify:navigate', handler);
    return () => document.removeEventListener('shopify:navigate', handler);
  }, [navigate]);

  const banners = me.banners ?? [];
  return (
    <>
      <a href="#main" style={skipLink} onFocus={(e) => Object.assign(e.currentTarget.style, skipLinkFocus)} onBlur={(e) => Object.assign(e.currentTarget.style, skipLink)}>
        {t('shell.skip')}
      </a>
      <s-app-nav>
        {NAV.map((n) => (
          <s-link key={n.to} href={n.to}>
            {t(n.label)}
          </s-link>
        ))}
      </s-app-nav>
      {hasAppBridge() ? null : (
        <nav aria-label="Serialis" style={{ padding: '8px 16px' }}>
          <Stack direction="inline" gap="base">
            {NAV.map((n) => (
              <Link key={n.to} to={n.to}>
                {t(n.label)}
              </Link>
            ))}
          </Stack>
        </nav>
      )}
      <div style={{ padding: '0 16px' }}>
        {!online ? <Banner tone="warning" testId="banner-offline">{t('common.offline')}</Banner> : null}
        {me.emergencyStop ? <EmergencyBanner /> : null}
        {banners.map((b) => (
          <Banner key={b} tone={b === 'reconnect_required' ? 'critical' : 'warning'} heading={t(`banner.${b}.heading`)} testId={`banner-${b}`}>
            {t(`banner.${b}.body`)}
          </Banner>
        ))}
        <GlobalSearch />
      </div>
      <main id="main" ref={main} tabIndex={-1} style={{ outline: 'none' }}>
        <Outlet />
      </main>
    </>
  );
}

const skipLink = { ...visuallyHidden } as React.CSSProperties;
const skipLinkFocus: React.CSSProperties = { position: 'static', width: 'auto', height: 'auto', margin: 8, clip: 'auto', overflow: 'visible' };
