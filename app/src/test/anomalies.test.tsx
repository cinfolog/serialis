import { describe, expect, it } from 'vitest';
import { choose, field, flush, pageHeading, press, pressKey, renderApp, screen, typeIn, waitFor, within } from './utils';

async function openAnomalies(route = '/anomalies', options: Parameters<typeof renderApp>[1] = {}) {
  const rendered = renderApp(route, options);
  await pageHeading('Anomalies');
  await waitFor(() => expect(screen.getByTestId('anomaly-ano-1')).toBeInTheDocument());
  return rendered;
}

describe('Anomalies : file de traitement', () => {
  it('sorts by severity then age and hides resolved anomalies by default', async () => {
    await openAnomalies();
    const ids = [...document.querySelectorAll('article')].map((a) => a.getAttribute('data-testid'));
    // critical first, then warnings from the oldest, then info (acknowledged).
    expect(ids).toEqual(['anomaly-ano-1', 'anomaly-ano-4', 'anomaly-ano-3', 'anomaly-ano-2', 'anomaly-ano-5', 'anomaly-ano-6']);
    expect(screen.getByTestId('anomaly-ano-1').textContent).toContain('Critique');
    expect(screen.getByTestId('anomaly-ano-1').textContent).toContain('Unités insuffisantes');
  });

  it('filters by severity from the URL (links of the home screen)', async () => {
    renderApp('/anomalies?severity=critical');
    await pageHeading('Anomalies');
    await waitFor(() => expect(screen.getByTestId('anomaly-ano-1')).toBeInTheDocument());
    expect(document.querySelectorAll('article')).toHaveLength(1);
  });

  it('acknowledges an anomaly ("je m’en occupe")', async () => {
    await openAnomalies();
    press(screen.getByTestId('ack-ano-2'));
    await waitFor(() => expect(screen.getByTestId('anomaly-ano-2').textContent).toContain('Prise en compte'));
    expect(screen.queryByTestId('ack-ano-2')).toBeNull();
  });

  it('resolves with a typed ref: the full ref validates on Enter and the anomaly leaves the queue', async () => {
    const { mock } = await openAnomalies();
    press(screen.getByTestId('action-ano-2-designate_shipped'));
    const card = screen.getByTestId('anomaly-ano-2');
    const input = await within(card).findByTestId('designation-input');
    typeIn(input, 'sn-ur500-l-61204');
    await waitFor(() => expect(card.textContent).toContain('Unité reconnue : SN-UR500-L-61204'));
    pressKey(input, 'Enter');
    await waitFor(() => expect(screen.queryByTestId('anomaly-ano-2')).toBeNull());
    expect(mock.anomalies.find((a) => a.id === 'ano-2')?.status).toBe('resolved');
    expect(screen.getByTestId('live-region').textContent).toContain('Anomalie résolue.');
  });

  it('recette 3 — one unit of a 2-unit anomaly: « 1 unit confirmed, 1 remaining », the anomaly stays until the last one', async () => {
    const { mock } = await openAnomalies();
    mock.anomalies.find((a) => a.id === 'ano-2')!.remaining = 2;
    press(screen.getByTestId('action-ano-2-designate_shipped'));
    const card = screen.getByTestId('anomaly-ano-2');
    const input = await within(card).findByTestId('designation-input');
    typeIn(input, 'sn-ur500-l-61204');
    await waitFor(() => expect(card.textContent).toContain('Unité reconnue : SN-UR500-L-61204'));
    pressKey(input, 'Enter');
    await waitFor(() => expect(screen.getByTestId('live-region').textContent).toContain('1 unité confirmée, 1 restante.'));
    expect(screen.getByTestId('live-region').textContent).not.toContain('Anomalie résolue.');
    expect(screen.getByTestId('anomaly-ano-2')).toBeInTheDocument();
    expect(mock.anomalies.find((a) => a.id === 'ano-2')?.status).toBe('open');
  });

  it('resolves with the last 4 characters when they are unique', async () => {
    const { mock } = await openAnomalies();
    press(screen.getByTestId('action-ano-3-identify_return'));
    const card = screen.getByTestId('anomaly-ano-3');
    // Return received at Boutique Lyon: candidates are the 3 M units there (51300..51302).
    const input = await within(card).findByTestId('designation-input');
    typeIn(input, '1301');
    await waitFor(() => expect(card.textContent).toContain('Unité reconnue : SN-UR500-M-51301'));
    press(within(card).getByTestId('designation-submit'));
    await waitFor(() => expect(mock.anomalies.find((a) => a.id === 'ano-3')?.status).toBe('resolved'));
  });

  it('never validates a suggestion with Enter', async () => {
    const { mock } = await openAnomalies();
    press(screen.getByTestId('action-ano-2-designate_shipped'));
    const card = screen.getByTestId('anomaly-ano-2');
    const input = await within(card).findByTestId('designation-input');
    typeIn(input, 'SN-UR500');
    await waitFor(() => expect(within(card).getByTestId('designation-suggestions')).toBeInTheDocument());
    pressKey(input, 'Enter');
    await flush();
    expect(mock.anomalies.find((a) => a.id === 'ano-2')?.status).toBe('open');
    expect(within(card).getByTestId('designation-message')).toBeInTheDocument();
  });

  it('shows the server refusal in plain words for a ref of the wrong variant and keeps the input', async () => {
    const { mock } = await openAnomalies();
    press(screen.getByTestId('action-ano-2-designate_shipped'));
    const card = screen.getByTestId('anomaly-ano-2');
    const input = await within(card).findByTestId('designation-input');
    // A real ref, but of another variant (M instead of L): not in the proposed units, found by lookup, refused by the server.
    typeIn(input, 'SN-UR500-M-51203');
    pressKey(input, 'Enter');
    await waitFor(() => expect(within(card).getByTestId('designation-error')).toBeInTheDocument());
    expect(within(card).getByTestId('designation-error').textContent).toContain('Mauvaise variante');
    expect(mock.anomalies.find((a) => a.id === 'ano-2')?.status).toBe('open');
  });

  it('asks for a confirmation that names the stock effect before a resolution that writes stock', async () => {
    const { mock } = await openAnomalies();
    press(screen.getByTestId('action-ano-4-correct_shopify'));
    await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
    const dialog = document.querySelector('s-modal') as HTMLElement;
    expect(dialog.getAttribute('heading')).toBe('Confirmer « Corriger le stock dans Shopify » ?');
    expect(dialog.textContent).toContain('Shopify : 6 · Serialis : 4');
    expect(dialog.textContent).toContain('écrit dans le stock Shopify');
    expect(mock.anomalies.find((a) => a.id === 'ano-4')?.status).toBe('open');
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.anomalies.find((a) => a.id === 'ano-4')?.status).toBe('resolved'));
  });

  it('operators do not get the resolutions that write stock (15.8)', async () => {
    await openAnomalies('/anomalies', { role: 'operator' });
    expect(screen.queryByTestId('action-ano-4-correct_shopify')).toBeNull();
    expect(screen.getByTestId('anomaly-ano-4').textContent).toContain('Réservée aux administrateurs');
    expect(screen.getByTestId('action-ano-4-register_units')).toBeInTheDocument();
  });

  it('closed anomalies can be listed', async () => {
    const { mock } = await openAnomalies();
    mock.anomalies[5]!.status = 'resolved';
    mock.anomalies[5]!.resolvedAt = '2026-11-16T10:00:00Z';
    choose(field('Afficher'), 'resolved');
    await waitFor(() => expect(screen.getByTestId('anomaly-ano-6')).toBeInTheDocument());
    expect(document.querySelectorAll('article')).toHaveLength(1);
  });
});
