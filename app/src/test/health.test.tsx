import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { MockClient } from '../api/mock';
import { pageHeading, press, renderApp, screen, text, waitFor, within } from './utils';

describe('Réglages › Santé (17.1, 17.2)', () => {
  it('opens from the short URL /health typed by hand (recette 2: blank page)', async () => {
    renderApp('/health?host=abc&shop=s.myshopify.com');
    await pageHeading('Santé de Serialis');
    await waitFor(() => expect(screen.getByTestId('health-status')).toBeInTheDocument());
  });

  it('an unknown URL shows a not-found screen with links to the home and to the health screen', async () => {
    renderApp('/nothing-here');
    await pageHeading('Page introuvable');
    const links = [...document.querySelectorAll('s-link')].map((l) => l.getAttribute('href'));
    expect(links).toEqual(expect.arrayContaining(['/', '/settings/health']));
    expect(screen.getByTestId('not-found').textContent).toContain('Cette page n’existe pas');
  });

  it('is reached from the settings and shows a healthy shop with empty lists', async () => {
    renderApp('/settings');
    await pageHeading('Réglages');
    const link = await waitFor(() => screen.getByTestId('settings-health-link').querySelector<HTMLElement>('s-link')!);
    expect(link.getAttribute('href')).toBe('/settings/health');
    press(link);
    await pageHeading('Santé de Serialis');
    await waitFor(() => expect(screen.getByTestId('health-status')).toBeInTheDocument());
    expect(text(screen.getByTestId('health-status'))).toBe('Tout fonctionne');
    expect(screen.getByTestId('health-no-alert')).toBeInTheDocument();
    expect(text(screen.getByTestId('health-shop-state'))).toBe('Active');
    expect(text(screen.getByTestId('health-token'))).toBe('Valide');
    expect(text(screen.getByTestId('health-size'))).toMatch(/^3,5\s?Mo$/);
    expect(screen.queryByTestId('health-size-warning')).toBeNull();
    expect(text(screen.getByTestId('health-counter-oldest'))).toBe('aucune');
    expect(text(screen.getByTestId('health-passes'))).toContain('R4 · audit quotidien');
    expect(screen.getByTestId('health-dead-tasks-empty').textContent).toBe('Aucune tâche arrêtée.');
    expect(screen.getByTestId('health-dead-writes-empty').textContent).toBe('Aucune écriture abandonnée.');
  });

  it('lists every alert, the dead tasks and given-up writes, and the database size warning', async () => {
    renderApp('/settings/health', { health: 'degraded' });
    await pageHeading('Santé de Serialis');
    await waitFor(() => expect(screen.getByTestId('health-dead-tasks')).toBeInTheDocument());
    expect(text(screen.getByTestId('health-status'))).toBe('À surveiller');
    for (const alert of ['task_dead', 'task_overdue', 'outbox_dead', 'outbox_stuck', 'reconnect_required', 'webhook_silence']) {
      expect(screen.getByTestId(`health-alert-${alert}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('health-alert-task_dead').getAttribute('tone')).toBe('critical');
    expect(screen.getByTestId('health-alert-task_overdue').getAttribute('tone')).toBe('warning');
    expect(screen.getByText('6 alertes')).toBeInTheDocument();
    expect(text(screen.getByTestId('health-token'))).toBe('À rétablir');
    expect(screen.getByTestId('health-size-warning')).toBeInTheDocument();
    expect(text(screen.getByTestId('health-counter-tasks-dead'))).toBe('1');
    expect(text(screen.getByTestId('health-counter-oldest'))).toBe('90 minutes');
    expect(text(screen.getByTestId('health-dead-tasks'))).toContain('Shopify GraphQL THROTTLED');
    expect(text(screen.getByTestId('health-dead-writes'))).toContain('inventory_adjust #42');
    expect(text(screen.getByTestId('health-passes'))).toContain('pas encore');
  });

  it('shows the loading state, then an error with a retry that recovers', async () => {
    const mock = new MockClient();
    const original = mock.health.bind(mock);
    let fail = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mock.health = async () => {
      await gate;
      if (fail) throw new ApiError({ status: 0, code: 'network' });
      return original();
    };
    renderApp('/settings/health', { mock });
    await pageHeading('Santé de Serialis');
    await waitFor(() => expect(screen.getByTestId('loading')).toBeInTheDocument());
    release();
    await waitFor(() => expect(screen.getByTestId('error-state')).toBeInTheDocument());
    fail = false;
    press(screen.getByTestId('error-state').querySelector<HTMLElement>('s-button')!);
    await waitFor(() => expect(screen.getByTestId('health-status')).toBeInTheDocument());
    expect(screen.queryByTestId('error-state')).toBeNull();
  });

  it('refreshes on demand and announces it', async () => {
    const mock = new MockClient();
    let calls = 0;
    const original = mock.health.bind(mock);
    mock.health = async () => {
      calls += 1;
      return original();
    };
    renderApp('/settings/health', { mock });
    await waitFor(() => expect(screen.getByTestId('health-status')).toBeInTheDocument());
    press(screen.getByTestId('health-refresh'));
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByTestId('live-region').textContent).toContain('Santé actualisée.');
  });

  it('is reserved to administrators (15.8): an operator gets the explanation and no call is made', async () => {
    const mock = new MockClient({ role: 'operator' });
    let calls = 0;
    mock.health = async () => {
      calls += 1;
      throw new Error('must not be called');
    };
    renderApp('/settings/health', { mock });
    await pageHeading('Santé de Serialis');
    await waitFor(() => expect(screen.getByTestId('health-read-only')).toBeInTheDocument());
    expect(calls).toBe(0);
  });

  it('the operator does not get the link from the settings either', async () => {
    renderApp('/settings', { role: 'operator' });
    await waitFor(() => expect(screen.getByTestId('setting-S-05')).toBeInTheDocument());
    expect(document.querySelector('s-section[heading="Santé"]')).not.toBeNull();
    expect(screen.queryByTestId('settings-health-link')).toBeNull();
  });

  it('is translated in English', async () => {
    renderApp('/settings/health', { locale: 'en', health: 'degraded' });
    await pageHeading('Serialis health');
    await waitFor(() => expect(screen.getByTestId('health-status')).toBeInTheDocument());
    expect(text(screen.getByTestId('health-status'))).toBe('Needs attention');
    expect(screen.getByText('6 alerts')).toBeInTheDocument();
    expect(text(screen.getByTestId('health-size'))).toBe('5.6 GB');
    expect(text(screen.getByTestId('health-dead-writes'))).toContain('Given up on');
  });

  it('relaunches a dead task and a given-up write (12.7): busy state, success banner, refreshed lists', async () => {
    const mock = new MockClient({ health: 'stopped' });
    let release!: () => void;
    const original = mock.reviveTask.bind(mock);
    mock.reviveTask = async (key, opts) => {
      await new Promise<void>((r) => (release = r));
      return original(key, opts);
    };
    renderApp('/settings/health', { mock });
    await waitFor(() => expect(screen.getByTestId('health-dead-tasks')).toBeInTheDocument());
    const revive = screen.getByTestId('health-revive-task-sync_order:gid://shopify/Order/1001');
    expect(text(revive)).toBe('Relancer');
    expect(revive.getAttribute('accessibilityLabel')).toBe('Relancer la tâche sync_order');
    press(revive);
    // Busy: the pressed button loads, the other one waits.
    await waitFor(() => expect(revive.hasAttribute('loading')).toBe(true));
    expect(screen.getByTestId('health-retry-write-42').hasAttribute('disabled')).toBe(true);
    release();
    await waitFor(() => expect(screen.getByTestId('health-dead-tasks-empty')).toBeInTheDocument());
    expect(text(screen.getByTestId('health-retry-task-done'))).toContain('Tâche relancée');
    expect(screen.getByTestId('live-region').textContent).toContain('Tâche relancée');
    expect(screen.queryByTestId('health-alert-task_dead')).toBeNull();
    expect(mock.postLog.map((p) => p.name)).toEqual(['reviveTask']);

    press(screen.getByTestId('health-retry-write-42'));
    await waitFor(() => expect(screen.getByTestId('health-dead-writes-empty')).toBeInTheDocument());
    expect(text(screen.getByTestId('health-retry-write-done'))).toContain('Écriture relancée');
    expect(text(screen.getByTestId('health-status'))).toBe('Tout fonctionne');
  });

  it('explains a refused retry (409 reconnect_required) and keeps the row', async () => {
    renderApp('/settings/health', { health: 'degraded' });
    await waitFor(() => expect(screen.getByTestId('health-dead-writes')).toBeInTheDocument());
    press(screen.getByTestId('health-retry-write-42'));
    await waitFor(() => expect(screen.getByTestId('health-retry-write-error')).toBeInTheDocument());
    expect(text(screen.getByTestId('health-retry-write-error'))).toContain('l’accès à Shopify doit d’abord être rétabli');
    expect(screen.getByTestId('health-retry-write-error').getAttribute('tone')).toBe('critical');
    expect(screen.getByTestId('health-dead-writes')).toBeInTheDocument();
    expect(screen.queryByTestId('health-retry-task-error')).toBeNull();
  });

  it('refreshes the list when the item is no longer stopped (404) and shows other errors as they come', async () => {
    const mock = new MockClient({ health: 'stopped' });
    mock.retryWrite = async () => {
      throw new ApiError({ status: 0, code: 'network' });
    };
    let reads = 0;
    const health = mock.health.bind(mock);
    mock.health = async () => {
      reads += 1;
      return health();
    };
    mock.reviveTask = async (key) => {
      mock.revivedTasks.add(key);
      throw new ApiError({ status: 404, code: 'not_found', detail: 'task_not_dead' });
    };
    renderApp('/settings/health', { mock });
    await waitFor(() => expect(screen.getByTestId('health-dead-writes')).toBeInTheDocument());
    press(screen.getByTestId('health-retry-write-42'));
    await waitFor(() => expect(screen.getByTestId('health-retry-write-error')).toBeInTheDocument());
    expect(screen.getByTestId('health-dead-writes')).toBeInTheDocument();
    press(screen.getByTestId('health-revive-task-sync_order:gid://shopify/Order/1001'));
    await waitFor(() => expect(text(screen.getByTestId('health-retry-task-error'))).toContain('n’est plus arrêté'));
    await waitFor(() => expect(screen.getByTestId('health-dead-tasks-empty')).toBeInTheDocument());
    expect(reads).toBe(2);
  });

  it('the retry buttons are translated in English', async () => {
    renderApp('/settings/health', { locale: 'en', health: 'stopped' });
    await waitFor(() => expect(screen.getByTestId('health-dead-writes')).toBeInTheDocument());
    expect(text(screen.getByTestId('health-retry-write-42'))).toBe('Retry');
    press(screen.getByTestId('health-retry-write-42'));
    await waitFor(() => expect(text(screen.getByTestId('health-retry-write-done'))).toContain('Write retried'));
  });

  it('abandons a given-up write after a confirmation that names the effect (12.4)', async () => {
    const mock = new MockClient({ health: 'stopped' });
    renderApp('/settings/health', { mock });
    await waitFor(() => expect(screen.getByTestId('health-dead-writes')).toBeInTheDocument());
    const abandon = screen.getByTestId('health-abandon-write-42');
    expect(text(abandon)).toBe('Abandonner');
    expect(abandon.getAttribute('accessibilityLabel')).toBe('Abandonner l’écriture inventory_adjust #42');
    expect(abandon.getAttribute('tone')).toBe('critical');

    // Cancel: nothing is sent.
    press(abandon);
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    const dialog = document.querySelector('[data-testid="dialog-root"]')!;
    expect(document.querySelector('[data-testid="dialog-heading"]')!.textContent).toBe('Abandonner l’écriture inventory_adjust #42 ?');
    expect(within(dialog as HTMLElement).getByText(/Shopify ne recevra jamais cette écriture/)).toBeInTheDocument();
    expect(within(dialog as HTMLElement).getByText(/réconciliation suivra pour réaligner le stock/)).toBeInTheDocument();
    press(screen.getByTestId('dialog-cancel'));
    await waitFor(() => expect(document.querySelector('[data-testid="dialog-root"]')).toBeNull());
    expect(mock.postLog).toEqual([]);

    // Confirm: the write leaves the list, success announced, the task list is untouched.
    press(screen.getByTestId('health-abandon-write-42'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('health-dead-writes-empty')).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector('[data-testid="dialog-root"]')).toBeNull());
    expect(text(screen.getByTestId('health-retry-write-done'))).toContain('Écriture abandonnée');
    expect(screen.getByTestId('live-region').textContent).toContain('Écriture abandonnée');
    expect(mock.postLog.map((p) => p.name)).toEqual(['abandonWrite']);
    expect(mock.abandonedWrites.has(42)).toBe(true);
    expect(screen.getByTestId('health-dead-tasks')).toBeInTheDocument();
  });

  it('explains a refused abandon (409 reconnect_required) and keeps the row', async () => {
    renderApp('/settings/health', { health: 'degraded', locale: 'en' });
    await waitFor(() => expect(screen.getByTestId('health-dead-writes')).toBeInTheDocument());
    expect(text(screen.getByTestId('health-abandon-write-42'))).toBe('Abandon');
    press(screen.getByTestId('health-abandon-write-42'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    expect(document.querySelector('[data-testid="dialog-heading"]')!.textContent).toBe('Abandon the inventory_adjust #42 write?');
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('health-retry-write-error')).toBeInTheDocument());
    expect(text(screen.getByTestId('health-retry-write-error'))).toContain('access to Shopify must first be restored');
    expect(screen.getByTestId('health-dead-writes')).toBeInTheDocument();
  });
});
