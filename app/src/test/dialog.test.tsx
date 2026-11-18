/**
 * Confirmation dialogs and the admin chrome (browser recette, decisions 33 and 34).
 *
 * In the real admin, showing an `s-modal` greys the Shopify top bar and menu until the modal is
 * hidden. jsdom has no Polaris, so this file defines a stand-in `s-modal` that behaves like that
 * overlay: `showOverlay()` marks it shown, `hideOverlay()` hides it and fires `hide` then
 * `afterhide` asynchronously. The chrome is released only if every modal that was shown has been
 * hidden while still in the document; a modal removed while shown is exactly the greyed admin of
 * the recette.
 */
import { useState } from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { MockClient } from '../api/mock';
import { ConfirmDialog } from '../ui/components';
import { fireEvent, navLink, pageHeading, press, renderApp, screen, waitFor } from './utils';

interface OverlayCall {
  op: 'show' | 'hide';
  connected: boolean;
}

const modals = new Set<FakeModal>();

class FakeModal extends HTMLElement {
  calls: OverlayCall[] = [];
  shown = false;
  constructor() {
    super();
    modals.add(this);
  }
  showOverlay() {
    this.calls.push({ op: 'show', connected: this.isConnected });
    this.shown = true;
  }
  hideOverlay() {
    this.calls.push({ op: 'hide', connected: this.isConnected });
    if (!this.shown || !this.isConnected) return; // a detached modal cannot reach the host any more
    this.shown = false;
    setTimeout(() => {
      this.dispatchEvent(new Event('hide'));
      this.dispatchEvent(new Event('afterhide'));
    }, 0);
  }
  /** A close decided by Polaris itself (its close button, its own Escape handling). */
  dismissFromHost() {
    this.shown = false;
    this.dispatchEvent(new Event('hide'));
    setTimeout(() => this.dispatchEvent(new Event('afterhide')), 0);
  }
}

beforeAll(() => {
  if (!customElements.get('s-modal')) customElements.define('s-modal', FakeModal);
});
afterEach(() => modals.clear());

/** True when no modal is left shown: the admin top bar and menu are usable again. */
function chromeReleased(): boolean {
  return [...modals].every((m) => !m.shown);
}
function everyHideWhileConnected(): boolean {
  return [...modals].every((m) => m.calls.filter((c) => c.op === 'hide').every((c) => c.connected));
}
const currentModal = () => document.querySelector('s-modal') as FakeModal;

async function expectClosedAndReleased() {
  await waitFor(() => expect(screen.queryByTestId('dialog-confirm')).toBeNull());
  expect(chromeReleased()).toBe(true);
  expect(everyHideWhileConnected()).toBe(true);
  expect(document.querySelector('s-modal')).toBeNull();
}

async function openEmergencyDialog(options: Parameters<typeof renderApp>[1] = {}) {
  const rendered = renderApp('/settings', { extensionsShown: true, ...options });
  await pageHeading('Réglages');
  await waitFor(() => expect(screen.getByTestId('emergency-toggle')).toBeInTheDocument());
  press(screen.getByTestId('emergency-toggle'));
  await waitFor(() => expect(screen.getByTestId('dialog-confirm')).toBeInTheDocument());
  expect(currentModal().shown).toBe(true);
  return rendered;
}

describe('Confirmation dialogs release the admin chrome on every close path', () => {
  it('Cancel', async () => {
    const { mock } = await openEmergencyDialog();
    press(screen.getByTestId('dialog-cancel'));
    await expectClosedAndReleased();
    expect(mock.emergencyStop).toBe(false);
  });

  it('Confirm, success (emergency stop)', async () => {
    const { mock } = await openEmergencyDialog();
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.emergencyStop).toBe(true));
    await expectClosedAndReleased();
  });

  it('Confirm, error (refused by the server)', async () => {
    const { mock } = await openEmergencyDialog();
    mock.options.role = 'operator';
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('emergency-error')).toBeInTheDocument());
    await expectClosedAndReleased();
  });

  it('close decided by Polaris itself (close button): the app state follows', async () => {
    const { mock } = await openEmergencyDialog();
    currentModal().dismissFromHost();
    await expectClosedAndReleased();
    // The dialog opens again normally afterwards.
    press(screen.getByTestId('emergency-toggle'));
    await waitFor(() => expect(currentModal().shown).toBe(true));
    expect(mock.emergencyStop).toBe(false);
  });

  it('resume from the banner: the banner and its dialog leave the page on success', async () => {
    const stopped = new MockClient({ extensionsShown: true });
    stopped.emergencyStop = true;
    const { mock } = renderApp('/', { mock: stopped });
    await waitFor(() => expect(screen.getByTestId('resume-open')).toBeInTheDocument());
    press(screen.getByTestId('resume-open'));
    await waitFor(() => expect(currentModal()?.shown).toBe(true));
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.emergencyStop).toBe(false));
    await waitFor(() => expect(screen.queryByTestId('banner-emergency')).toBeNull());
    await expectClosedAndReleased();
  });

  it('API key revocation: confirm (success), then cancel, then a refused revocation', async () => {
    const existing = new MockClient({ extensionsShown: true });
    await existing.createApiKey({ name: 'Make', scopes: ['units:read'] });
    await existing.createApiKey({ name: 'Zapier', scopes: ['units:read'] });
    const { mock } = renderApp('/settings', { mock: existing });
    const [second, first] = [mock.apiKeys[0]!.prefix, mock.apiKeys[1]!.prefix];
    await waitFor(() => expect(screen.getByTestId(`api-key-revoke-${first}`)).toBeInTheDocument());

    press(screen.getByTestId(`api-key-revoke-${first}`));
    await waitFor(() => expect(currentModal()?.shown).toBe(true));
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(mock.apiKeys.find((k) => k.prefix === first)!.revokedAt).not.toBeNull());
    await expectClosedAndReleased();

    press(screen.getByTestId(`api-key-revoke-${second}`));
    await waitFor(() => expect(currentModal()?.shown).toBe(true));
    press(screen.getByTestId('dialog-cancel'));
    await expectClosedAndReleased();

    vi.spyOn(mock, 'revokeApiKey').mockRejectedValueOnce(new ApiError({ status: 500, code: 'unknown', detail: 'boom' }));
    press(screen.getByTestId(`api-key-revoke-${second}`));
    await waitFor(() => expect(currentModal()?.shown).toBe(true));
    press(screen.getByTestId('dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('api-keys-error')).toBeInTheDocument());
    await expectClosedAndReleased();
  });

  it('leaving the screen while a dialog is open hides it before it leaves the document', async () => {
    await openEmergencyDialog();
    const modal = currentModal();
    press(navLink('Anomalies'));
    await pageHeading('Anomalies');
    expect(modal.isConnected).toBe(false);
    expect(modal.calls.at(-1)).toEqual({ op: 'hide', connected: true });
    expect(chromeReleased()).toBe(true);
  });

  it('unmounting the dialog component while open (harness)', () => {
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
    const modal = currentModal();
    expect(modal.shown).toBe(true);
    fireEvent.click(screen.getByText('remove'));
    expect(modal.isConnected).toBe(false);
    expect(modal.calls).toEqual([
      { op: 'show', connected: true },
      { op: 'hide', connected: true },
    ]);
    expect(chromeReleased()).toBe(true);
  });

  it('gives the focus back to the button that opened the dialog', async () => {
    await openEmergencyDialog();
    const trigger = screen.getByTestId('emergency-toggle');
    // In the browser, the click focuses the trigger first; jsdom does not, so do it here.
    trigger.tabIndex = 0;
    press(screen.getByTestId('dialog-cancel'));
    await expectClosedAndReleased();
    trigger.focus();
    press(trigger);
    await waitFor(() => expect(currentModal()?.shown).toBe(true));
    (screen.getByTestId('dialog-cancel') as HTMLElement).tabIndex = 0;
    (screen.getByTestId('dialog-cancel') as HTMLElement).focus();
    press(screen.getByTestId('dialog-cancel'));
    await expectClosedAndReleased();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('Escape closes the dialog without acting (15.7)', () => {
  it('from a button of the dialog', async () => {
    const { mock } = await openEmergencyDialog();
    const pause = vi.spyOn(mock, 'pause');
    fireEvent.keyDown(screen.getByTestId('dialog-confirm'), { key: 'Escape' });
    await expectClosedAndReleased();
    expect(pause).not.toHaveBeenCalled();
    expect(mock.emergencyStop).toBe(false);
  });

  it('from inside the Polaris modal (its own close button, in its shadow root: the event reaches the host)', async () => {
    const { mock } = await openEmergencyDialog();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true });
    currentModal().dispatchEvent(event);
    await expectClosedAndReleased();
    expect(event.defaultPrevented).toBe(true);
    expect(mock.emergencyStop).toBe(false);
  });

  it('from the page behind while the dialog is open (focus lost to the document)', async () => {
    const { mock } = await openEmergencyDialog();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await expectClosedAndReleased();
    expect(mock.emergencyStop).toBe(false);
  });

  it('other keys do nothing, and Escape does nothing once the dialog is closed', async () => {
    const { mock } = await openEmergencyDialog();
    const onKey = vi.fn();
    fireEvent.keyDown(screen.getByTestId('dialog-confirm'), { key: 'a' });
    expect(currentModal().shown).toBe(true);
    press(screen.getByTestId('dialog-cancel'));
    await expectClosedAndReleased();
    document.addEventListener('keydown', onKey);
    const late = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(late);
    document.removeEventListener('keydown', onKey);
    expect(late.defaultPrevented).toBe(false);
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(mock.emergencyStop).toBe(false);
  });
});
