/**
 * Confirmation dialogs and the admin chrome (browser recettes, decisions 33, 34 and 42).
 *
 * In the real admin, every close of an `s-modal` left the Shopify top bar and menu greyed until a reload.
 * `adminOverlay.ts` models that admin layer from what Shopify documents (layer requested by the modal,
 * addressed by id, released only by a hide that completes while the element is in the document); the
 * first block checks the model itself against the documented pattern. Then every close path of the app
 * must leave the admin chrome untouched: the dialogs are drawn inside the app frame (native `<dialog>`),
 * so no admin layer is ever requested, and the in-frame dialog is closed and gone after each path.
 */
import { useState } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { MockClient } from '../api/mock';
import { ConfirmDialog, DIALOG_CHECK_MS } from '../ui/components';
import { dialogDiagnostics } from '../ui/dialogState';
import { ADMIN_HIDE_FRAME_MS, adminOverlay, installAdminOverlayModel } from './adminOverlay';
import { button, field, fireEvent, navLink, pageHeading, press, renderApp, screen, typeIn, waitFor } from './utils';

beforeAll(() => {
  installAdminOverlayModel();
});
afterEach(() => {
  adminOverlay.reset();
  document.body.querySelectorAll('s-modal').forEach((m) => m.remove());
});

const sleep = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const dialogRoot = () => document.querySelector<HTMLDialogElement>('[data-testid="dialog-root"]');
const openDialogs = () => document.querySelectorAll('dialog[open]').length;

/** The admin top bar and menu are usable: no admin layer is shown or orphaned. */
function expectAdminChromeFree() {
  expect(adminOverlay.greyed, 'the admin top bar and menu stay greyed').toBe(false);
}

/**
 * After a close: the admin chrome is free (checked first: this is the defect of the recettes), no dialog
 * is left open in the frame, the diagnostics agree, and the safety net had nothing to repair.
 */
async function expectClosed() {
  await waitFor(() => expect(screen.queryByTestId('dialog-confirm')).toBeNull());
  expectAdminChromeFree();
  expect(adminOverlay.showRequests, 'an s-modal asked the admin for its layer').toBe(0);
  expect(document.querySelector('s-modal')).toBeNull();
  expect(openDialogs()).toBe(0);
  expect(dialogDiagnostics().open).toEqual([]);
  await sleep(DIALOG_CHECK_MS + 20);
  expect(dialogDiagnostics().warnings).toBe(0);
  expectAdminChromeFree();
}

async function expectOpen() {
  await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
  expect(dialogRoot()?.open).toBe(true);
  expect(dialogDiagnostics().open).toHaveLength(1);
}

const lastClose = () => dialogDiagnostics().log.filter((e) => e.type === 'close').at(-1);

async function openEmergencyDialog(options: Parameters<typeof renderApp>[1] = {}) {
  const rendered = renderApp('/settings', { extensionsShown: true, ...options });
  await pageHeading('Réglages');
  await waitFor(() => expect(screen.getByTestId('emergency-toggle')).toBeInTheDocument());
  press(screen.getByTestId('emergency-toggle'));
  await expectOpen();
  return rendered;
}

describe('model of the admin overlay (self-check against the documented pattern)', () => {
  it('documented pattern: one persistent s-modal with an id, shown and hidden by id, frees the admin', async () => {
    const el = document.createElement('s-modal');
    el.id = 'documented';
    document.body.append(el);
    await adminOverlay.modal.show('documented');
    expect(adminOverlay.greyed).toBe(true);
    await adminOverlay.modal.hide('documented');
    await sleep(ADMIN_HIDE_FRAME_MS + 10);
    expect(adminOverlay.greyed).toBe(false);
  });

  it('a modal removed while shown, or while its hide is pending, leaves the admin greyed', async () => {
    const shown = document.createElement('s-modal') as HTMLElement & { showOverlay(): void; hideOverlay(): void };
    shown.id = 'removed';
    document.body.append(shown);
    shown.showOverlay();
    shown.remove();
    expect(adminOverlay.greyed).toBe(true);
    adminOverlay.reset();

    const hiding = document.createElement('s-modal') as HTMLElement & { showOverlay(): void; hideOverlay(): void };
    hiding.id = 'hiding';
    document.body.append(hiding);
    hiding.showOverlay();
    hiding.hideOverlay(); // called while attached, as the previous fix did
    hiding.remove(); // ... but removed before the hide completed
    await sleep(ADMIN_HIDE_FRAME_MS + 10);
    expect(adminOverlay.greyed).toBe(true);
  });

  it('a modal shown without an id cannot be released, even by a complete hide', async () => {
    const el = document.createElement('s-modal') as HTMLElement & { showOverlay(): void; hideOverlay(): void };
    document.body.append(el);
    el.showOverlay();
    el.hideOverlay();
    await sleep(ADMIN_HIDE_FRAME_MS + 10);
    expect(adminOverlay.greyed).toBe(true);
  });
});

describe('Confirmation dialogs leave the admin chrome free on every close path', () => {
  it('Cancel', async () => {
    const { mock } = await openEmergencyDialog();
    press(screen.getByTestId('dialog-cancel'));
    await expectClosed();
    expect(lastClose()?.reason).toBe('cancel');
    expect(mock.emergencyStop).toBe(false);
  });

  it('close button (×) of the dialog header, named for assistive technologies', async () => {
    const { mock } = await openEmergencyDialog();
    const close = screen.getByTestId('dialog-close');
    expect(close).toHaveAccessibleName('Fermer');
    expect(dialogRoot()).toHaveAccessibleName('Activer l’arrêt d’urgence ?');
    fireEvent.click(close);
    await expectClosed();
    expect(lastClose()?.reason).toBe('close-button');
    expect(mock.emergencyStop).toBe(false);
  });

  it('close request of the browser (native `cancel` event): the app decides, nothing is done', async () => {
    const { mock } = await openEmergencyDialog();
    const cancel = new Event('cancel', { cancelable: true });
    dialogRoot()!.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    await expectClosed();
    expect(lastClose()?.reason).toBe('escape');
    expect(mock.emergencyStop).toBe(false);
  });

  it('emergency stop on (confirm, success), then off from the settings (confirm)', async () => {
    const { mock } = await openEmergencyDialog();
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.emergencyStop).toBe(true));
    await expectClosed();
    expect(lastClose()?.reason).toBe('program');
    press(screen.getByTestId('emergency-toggle'));
    await expectOpen();
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.emergencyStop).toBe(false));
    await expectClosed();
  });

  it('confirm refused by the server', async () => {
    const { mock } = await openEmergencyDialog();
    mock.options.role = 'operator';
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('emergency-error')).toBeInTheDocument());
    await expectClosed();
  });

  it('emergency stop off from the banner: the banner and its dialog leave the page, the focus goes to the main region', async () => {
    const stopped = new MockClient({ extensionsShown: true });
    stopped.emergencyStop = true;
    const { mock } = renderApp('/', { mock: stopped });
    await waitFor(() => expect(screen.getByTestId('resume-open')).toBeInTheDocument());
    press(screen.getByTestId('resume-open'));
    await expectOpen();
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.emergencyStop).toBe(false));
    await waitFor(() => expect(screen.queryByTestId('banner-emergency')).toBeNull());
    await expectClosed();
    expect(document.activeElement).toBe(document.getElementById('main'));
  });

  it('API key revocation: confirm (success), then cancel, then a refused revocation', async () => {
    const existing = new MockClient({ extensionsShown: true });
    await existing.createApiKey({ name: 'Make', scopes: ['units:read'] });
    await existing.createApiKey({ name: 'Zapier', scopes: ['units:read'] });
    const { mock } = renderApp('/settings', { mock: existing });
    const [second, first] = [mock.apiKeys[0]!.prefix, mock.apiKeys[1]!.prefix];
    await waitFor(() => expect(screen.getByTestId(`api-key-revoke-${first}`)).toBeInTheDocument());

    press(screen.getByTestId(`api-key-revoke-${first}`));
    await expectOpen();
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.apiKeys.find((k) => k.prefix === first)!.revokedAt).not.toBeNull());
    await expectClosed();

    press(screen.getByTestId(`api-key-revoke-${second}`));
    await expectOpen();
    press(screen.getByTestId('dialog-cancel'));
    await expectClosed();

    vi.spyOn(mock, 'revokeApiKey').mockRejectedValueOnce(new ApiError({ status: 500, code: 'unknown', detail: 'boom' }));
    press(screen.getByTestId(`api-key-revoke-${second}`));
    await expectOpen();
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('api-keys-error')).toBeInTheDocument());
    await expectClosed();
  });

  it('import: confirmation after the simulation, then cancel on a second simulation', async () => {
    const { mock } = renderApp('/imports');
    await pageHeading('Imports');
    await waitFor(() => expect(screen.getByTestId('import-text')).toBeInTheDocument());
    typeIn(field('Contenu du fichier'), 'ref,sku,location,already_counted\nSN-UR500-M-52001,UR500-M,Entrepôt Bordeaux,non');
    press(button('Simuler l’import'));
    await waitFor(() => expect(screen.getByTestId('import-confirm')).toBeInTheDocument());
    const before = mock.units.length;
    press(screen.getByTestId('import-confirm'));
    await expectOpen();
    press(screen.getByTestId('dialog-cancel'));
    await expectClosed();
    expect(mock.units.length).toBe(before);
    press(screen.getByTestId('import-confirm'));
    await expectOpen();
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('import-done')).toBeInTheDocument());
    await expectClosed();
    expect(mock.units.length).toBe(before + 1);
  });

  it('health: abandon a given-up write (cancel, then confirm); a retry opens no dialog', async () => {
    const mock = new MockClient({ health: 'stopped' });
    renderApp('/settings/health', { mock });
    await waitFor(() => expect(screen.getByTestId('health-dead-writes')).toBeInTheDocument());
    press(screen.getByTestId('health-abandon-write-42'));
    await expectOpen();
    press(screen.getByTestId('dialog-cancel'));
    await expectClosed();
    press(screen.getByTestId('health-abandon-write-42'));
    await expectOpen();
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('health-dead-writes-empty')).toBeInTheDocument());
    await expectClosed();
    expect(mock.postLog.map((p) => p.name)).toEqual(['abandonWrite']);

    await waitFor(() => expect(screen.getByTestId('health-dead-tasks')).toBeInTheDocument());
    const revive = document.querySelector<HTMLElement>('[data-testid^="health-revive-task-"]');
    expect(revive).not.toBeNull();
    press(revive!);
    await waitFor(() => expect(mock.postLog.length).toBe(2));
    expect(dialogRoot()).toBeNull();
    expect(dialogDiagnostics().log.filter((e) => e.type === 'open')).toHaveLength(2);
    expectAdminChromeFree();
  });

  it('users: the owner designates an administrator, then withdraws the right (two confirmations)', async () => {
    const { mock } = renderApp('/settings');
    const grant = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-testid^="user-grant-"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const userId = grant.dataset['testid']!.replace('user-grant-', '');
    press(grant);
    await expectOpen();
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId(`user-revoke-${userId}`)).toBeInTheDocument());
    await expectClosed();
    press(screen.getByTestId(`user-revoke-${userId}`));
    await expectOpen();
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId(`user-grant-${userId}`)).toBeInTheDocument());
    await expectClosed();
    expect(mock.appUsers.find((u) => u.userId === userId)?.role).toBe('operator');
  });

  it('leaving the screen while a dialog is open (admin navigation): the dialog leaves with it', async () => {
    await openEmergencyDialog();
    press(navLink('Anomalies'));
    await pageHeading('Anomalies');
    await expectClosed();
    expect(lastClose()?.reason).toBe('unmount');
  });

  it('unmounting the dialog component while open (harness)', async () => {
    function Harness() {
      const [on, setOn] = useState(true);
      return (
        <>
          <button onClick={() => setOn(false)}>remove</button>
          {on ? (
            <ConfirmDialog open heading="H" confirmLabel="OK" cancelLabel="Annuler" onConfirm={() => {}} onClose={() => {}}>
              <p>body</p>
            </ConfirmDialog>
          ) : null}
        </>
      );
    }
    render(<Harness />);
    await expectOpen();
    fireEvent.click(screen.getByText('remove'));
    expect(dialogRoot()).toBeNull();
    await expectClosed();
    expect(lastClose()?.reason).toBe('unmount');
  });

  it('gives the focus back to the button that opened the dialog', async () => {
    await openEmergencyDialog();
    press(screen.getByTestId('dialog-cancel'));
    await expectClosed();
    const trigger = screen.getByTestId('emergency-toggle');
    // In the browser, the click focuses the trigger first; jsdom does not, so do it here.
    trigger.tabIndex = 0;
    trigger.focus();
    press(trigger);
    await expectOpen();
    screen.getByTestId('dialog-close').focus();
    press(screen.getByTestId('dialog-cancel'));
    await expectClosed();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    await openEmergencyDialog();
    // Polaris is absent from jsdom: make its buttons focusable as the real ones are.
    for (const id of ['dialog-cancel', 'dialog-confirm']) screen.getByTestId(id).tabIndex = 0;
    const close = screen.getByTestId('dialog-close');
    const confirm = screen.getByTestId('dialog-confirm');
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    press(screen.getByTestId('dialog-cancel'));
    await expectClosed();
  });
});

describe('Escape closes the dialog without acting (15.7)', () => {
  it('from a button of the dialog', async () => {
    const { mock } = await openEmergencyDialog();
    const pause = vi.spyOn(mock, 'pause');
    fireEvent.keyDown(screen.getByTestId('dialog-confirm'), { key: 'Escape' });
    await expectClosed();
    expect(lastClose()?.reason).toBe('escape');
    expect(pause).not.toHaveBeenCalled();
    expect(mock.emergencyStop).toBe(false);
  });

  it('from inside a Polaris shadow root (composed event, received by the dialog)', async () => {
    const { mock } = await openEmergencyDialog();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true });
    screen.getByTestId('dialog-confirm').dispatchEvent(event);
    await expectClosed();
    expect(event.defaultPrevented).toBe(true);
    expect(mock.emergencyStop).toBe(false);
  });

  it('from the page behind while the dialog is open (focus lost to the document)', async () => {
    const { mock } = await openEmergencyDialog();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await expectClosed();
    expect(mock.emergencyStop).toBe(false);
  });

  it('other keys do nothing, and Escape does nothing once the dialog is closed', async () => {
    const { mock } = await openEmergencyDialog();
    const onKey = vi.fn();
    fireEvent.keyDown(screen.getByTestId('dialog-confirm'), { key: 'a' });
    expect(dialogRoot()?.open).toBe(true);
    press(screen.getByTestId('dialog-cancel'));
    await expectClosed();
    document.addEventListener('keydown', onKey);
    const late = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(late);
    document.removeEventListener('keydown', onKey);
    expect(late.defaultPrevented).toBe(false);
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(mock.emergencyStop).toBe(false);
  });
});

describe('safety net and diagnostics (decision 42)', () => {
  it('exposes the dialog state on window.__serialisDialogs', async () => {
    await openEmergencyDialog();
    expect(window.__serialisDialogs?.open).toEqual([{ id: dialogRoot()!.id, heading: 'Activer l’arrêt d’urgence ?' }]);
    press(screen.getByTestId('dialog-cancel'));
    await expectClosed();
    const log = window.__serialisDialogs!.log.map((e) => [e.type, e.reason]);
    expect(log).toEqual([['open', undefined], ['close', 'cancel']]);
  });

  it('closes a dialog left open after a close and logs a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await openEmergencyDialog();
    // A dialog of the app that something failed to close (never expected).
    const stuck = document.createElement('dialog');
    stuck.className = 'serialis-dialog';
    stuck.id = 'serialis-dialog-stuck';
    document.body.append(stuck);
    stuck.showModal();
    press(screen.getByTestId('dialog-cancel'));
    await waitFor(() => expect(screen.queryByTestId('dialog-confirm')).toBeNull());
    await sleep(DIALOG_CHECK_MS + 20);
    expect(stuck.open).toBe(false);
    expect(dialogDiagnostics().warnings).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still open'));
    stuck.remove();
    warn.mockRestore();
  });
});
