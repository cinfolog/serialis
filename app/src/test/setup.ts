import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import { resetDialogDiagnostics } from '../ui/dialogState';

// jsdom renders custom elements slowly under parallel load: generous async timeouts avoid flakiness.
configure({ asyncUtilTimeout: 5000 });

/**
 * jsdom has no `HTMLDialogElement.showModal` / `close`. Minimal model of the browser: `showModal()` sets
 * `open` (and refuses a dialog that is not in the document, like the browser), `close()` drops it and
 * queues a `close` event. A modal dialog removed from the document simply stops being shown: nothing
 * outside the app frame is involved (decision 42).
 */
const dialogProto = HTMLDialogElement.prototype as HTMLDialogElement & { __serialisModel?: boolean };
if (typeof dialogProto.showModal !== 'function') {
  Object.defineProperty(dialogProto, '__serialisModel', { value: true });
  if (!('open' in dialogProto)) {
    Object.defineProperty(dialogProto, 'open', {
      configurable: true,
      get(this: HTMLDialogElement) {
        return this.hasAttribute('open');
      },
      set(this: HTMLDialogElement, v: boolean) {
        this.toggleAttribute('open', Boolean(v));
      },
    });
  }
  dialogProto.showModal = function showModal(this: HTMLDialogElement) {
    if (!this.isConnected) throw new DOMException('The dialog is not connected.', 'InvalidStateError');
    if (this.hasAttribute('open')) return;
    this.setAttribute('open', '');
  };
  dialogProto.show = function show(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  dialogProto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  };
}

afterEach(() => {
  cleanup();
  resetDialogDiagnostics();
  window.history.replaceState(null, '', '/');
});
