import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockClient } from '../api/mock';
import { useAsync } from '../ui/hooks';
import { pageHeading, press, renderApp, screen, text, waitFor } from './utils';

/** Recette 2: lists and counters stayed stale until F5 (decision 38). */
describe('Données à jour sans F5', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const focus = () => act(() => void window.dispatchEvent(new Event('focus')));

  it('anomalies: a resolution that also closes another anomaly on the server updates the whole list', async () => {
    const mock = new MockClient();
    // The server closes ano-4 together with ano-2 (e.g. the same order now has its unit).
    const original = mock.acknowledgeAnomaly.bind(mock);
    vi.spyOn(mock, 'acknowledgeAnomaly').mockImplementation(async (id, opts) => {
      const updated = await original(id, opts);
      const other = mock.anomalies.find((a) => a.id === 'ano-4')!;
      Object.assign(other, { status: 'resolved', resolvedAt: new Date().toISOString() });
      return updated;
    });
    renderApp('/anomalies', { mock });
    await pageHeading('Anomalies');
    await waitFor(() => expect(screen.getByTestId('anomaly-ano-4')).toBeInTheDocument());
    press(screen.getByTestId('ack-ano-2'));
    await waitFor(() => expect(screen.queryByTestId('anomaly-ano-4')).toBeNull());
    // The answer of the write is still shown for the anomaly that was handled.
    expect(screen.getByTestId('anomaly-ano-2').textContent).toContain('Prise en compte');
  });

  it('home: counters follow a change made elsewhere when the window gets the focus back', async () => {
    const mock = new MockClient({ extensionsShown: true });
    renderApp('/', { mock });
    await waitFor(() => expect(screen.getByTestId('todo-critical')).toBeInTheDocument());
    expect(text(screen.getByTestId('todo-critical'))).toBe('1 anomalie critique');
    for (const a of mock.anomalies) if (a.severity === 'critical') a.status = 'resolved';
    focus();
    await waitFor(() => expect(screen.queryByTestId('todo-critical')).toBeNull());
  });

  it('home: the start card says an extension was shown once it reported itself, without F5 (item 6)', async () => {
    const mock = new MockClient();
    renderApp('/', { mock });
    await waitFor(() => expect(screen.getByTestId('start-extensions')).toBeInTheDocument());
    expect(screen.getByTestId('start-extensions').textContent).toContain('Action « Modifier les unités » (commande) : pas encore affiché');
    mock.markExtensionShown('order_action');
    focus();
    await waitFor(() => expect(screen.getByTestId('start-extensions').textContent).toContain('Action « Modifier les unités » (commande) : affiché'));
  });

  it('API keys: "never used" becomes the last use date when the page comes back to the foreground', async () => {
    const mock = new MockClient();
    mock.apiKeys.push({ prefix: 'srl_test', name: 'ERP', hint: 'srl_test…', scopes: ['units:read'], createdAt: new Date().toISOString(), createdBy: '1', lastUsedAt: null, revokedAt: null } as never);
    renderApp('/settings', { mock });
    await waitFor(() => expect(screen.getByTestId('api-key-srl_test')).toBeInTheDocument());
    expect(text(screen.getByTestId('api-key-srl_test'))).toContain('Jamais utilisée');
    mock.apiKeys[0]!.lastUsedAt = new Date().toISOString();
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(text(screen.getByTestId('api-key-srl_test'))).not.toContain('Jamais utilisée'));
  });

  it('polls while visible, not while hidden, and a refresh never shows a loading state', async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetcher = vi.fn(async () => ++n);
    const { result } = renderHook(() => useAsync(fetcher, [], { live: true, pollMs: 30_000 }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(result.current.data).toBe(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(result.current.data).toBe(2);
    expect(result.current.loading).toBe(false);
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(fetcher).toHaveBeenCalledTimes(2);
    hidden.mockRestore();
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(result.current.data).toBe(3);
  });

  it('a failed background refresh keeps what is shown', async () => {
    let fail = false;
    const { result } = renderHook(() => useAsync(async () => (fail ? Promise.reject(new Error('down')) : 'ok'), [], { live: true }));
    await waitFor(() => expect(result.current.data).toBe('ok'));
    fail = true;
    focus();
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(result.current.data).toBe('ok');
    expect(result.current.error).toBeUndefined();
  });
});
