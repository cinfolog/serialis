/**
 * Model of the admin-level overlay of a Polaris `s-modal` in an embedded app (decision 42), for jsdom.
 *
 * What Shopify documents or confirmed, and what this model keeps of it:
 *  - showing an `s-modal` makes the admin grey its top bar and menu: a host-level layer drawn by the
 *    admin, outside the app frame, requested through App Bridge (« Using modals in your app »; the
 *    in-frame part is a shadow `<dialog>`, the admin layer is separate);
 *  - App Bridge addresses a modal by its `id` (`shopify.modal.show(id)` / `hide(id)`, every documented
 *    example has one, and React open state driven by an effect is discouraged): a modal shown without
 *    a stable id is a layer nothing can address again — the model counts it as orphaned;
 *  - hiding is asynchronous (Polaris defers it to an animation frame, then fires `hide` and `afterhide`):
 *    the layer is released only when the hide completes while the element is still in the document;
 *    an element removed while shown or while hiding leaves the layer up (confirmed by Shopify staff for
 *    a page left while the modal was open: « leaves the Shopify admin header and sidebar dimmed »).
 * The model is deliberately conservative: the admin side cannot be observed from the app, so anything
 * that departs from the documented pattern counts as a greyed admin.
 */

export interface AdminOverlayModel {
  /** True while the admin top bar and menu would be greyed (a layer is shown or was orphaned). */
  readonly greyed: boolean;
  /** Number of layers that can no longer be released (only a reload clears them in the real admin). */
  readonly orphaned: number;
  /** Number of times any `s-modal` asked the admin for its layer. */
  readonly showRequests: number;
  /** Stand-in for `shopify.modal` (App Bridge), addressing modals by id. */
  readonly modal: { show(id: string): Promise<void>; hide(id: string): Promise<void> };
  reset(): void;
}

/** One animation frame: the delay Polaris takes before a hide completes. */
const HIDE_FRAME_MS = 16;

const state = { layers: new Set<string>(), orphaned: 0, showRequests: 0 };

class ModelModal extends HTMLElement {
  private shown = false;
  private hiding: ReturnType<typeof setTimeout> | null = null;
  private anonymous = false;

  showOverlay(): void {
    if (!this.isConnected || this.shown) return;
    state.showRequests += 1;
    this.shown = true;
    if (this.id) state.layers.add(this.id);
    else {
      // No id: the admin layer exists but nothing can address it again.
      this.anonymous = true;
      state.orphaned += 1;
    }
    setTimeout(() => {
      this.dispatchEvent(new Event('show'));
      this.dispatchEvent(new Event('aftershow'));
    }, 0);
  }

  hideOverlay(): void {
    if (!this.shown || this.hiding !== null) return;
    this.hiding = setTimeout(() => {
      this.hiding = null;
      this.shown = false;
      if (this.id && !this.anonymous) state.layers.delete(this.id);
      this.dispatchEvent(new Event('hide'));
      this.dispatchEvent(new Event('afterhide'));
    }, HIDE_FRAME_MS);
  }

  toggleOverlay(): void {
    if (this.shown) this.hideOverlay();
    else this.showOverlay();
  }

  disconnectedCallback(): void {
    if (!this.shown) return;
    // Removed while shown or while hiding: the pending hide never completes, the layer stays.
    if (this.hiding !== null) clearTimeout(this.hiding);
    this.hiding = null;
    this.shown = false;
    if (this.id && !this.anonymous) {
      state.layers.delete(this.id);
      state.orphaned += 1;
    }
  }
}

const find = (id: string) => document.getElementById(id) as ModelModal | null;

export const adminOverlay: AdminOverlayModel = {
  get greyed() {
    return state.layers.size > 0 || state.orphaned > 0;
  },
  get orphaned() {
    return state.orphaned;
  },
  get showRequests() {
    return state.showRequests;
  },
  modal: {
    async show(id) {
      find(id)?.showOverlay();
    },
    async hide(id) {
      find(id)?.hideOverlay();
    },
  },
  reset() {
    state.layers.clear();
    state.orphaned = 0;
    state.showRequests = 0;
  },
};

/** Registers the model as `s-modal` (once per test file: each file has its own jsdom). */
export function installAdminOverlayModel(): AdminOverlayModel {
  if (!customElements.get('s-modal')) customElements.define('s-modal', ModelModal);
  adminOverlay.reset();
  return adminOverlay;
}

export const ADMIN_HIDE_FRAME_MS = HIDE_FRAME_MS;
