/*
 * Offline stand-in for https://cdn.shopify.com/shopifycloud/polaris.js (Polaris web components).
 *
 * Used when the CDN is unreachable (sandboxes, restricted CI): the tests intercept the script request and
 * serve this file instead. It registers the `s-*` custom elements the admin app uses as SIMPLE elements:
 * open shadow roots with native controls (label + input, button, link, dialog) and the same property /
 * event contract the app relies on (`value`, `checked`, `input`, `change`, `showOverlay()`, `afterhide`).
 *
 * What it does and does not prove:
 *  - it exercises the app's own markup, roles, labels, focus handling and CSS, and gives axe a flattened
 *    tree comparable to the real one (open shadow roots);
 *  - it says NOTHING about Polaris' own internals (their contrast, focus rings, labels, keyboard handling).
 *    Those assertions are tagged `@real-cdn` in the tests and only run with UI_TESTS_REAL_CDN=1.
 */
(() => {
  const SHIM_MARK = 'serialis-polaris-shim';
  if (window[SHIM_MARK]) return;
  window[SHIM_MARK] = true;

  const css = (strings) => strings.join('');
  const FOCUS = 'outline:2px solid #005bd3;outline-offset:2px';

  // Light-DOM elements: styled from the document, no shadow root needed.
  const style = document.createElement('style');
  style.textContent = css`
    s-app-nav { display: none; }
    s-paragraph, s-box, s-table { display: block; }
    s-text { display: inline; }
    s-text[type="strong"] { font-weight: 600; }
    s-badge { display: inline-block; padding: 1px 8px; border: 1px solid #5c5f62; border-radius: 12px; font-size: 13px; color: #1f2124; background: #f1f1f1; }
    s-badge[tone="critical"] { background: #fee9e8; border-color: #8e1f0b; color: #5c1105; }
    s-badge[tone="warning"] { background: #fff1d6; border-color: #8a6a00; color: #4a3800; }
    s-badge[tone="success"] { background: #cdfee1; border-color: #0c5132; color: #0c3b2c; }
    s-badge[tone="info"] { background: #eaf4ff; border-color: #0b3d91; color: #0a2a63; }
    s-stack { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    s-stack[direction="inline"] { flex-direction: row; flex-wrap: wrap; }
    s-stack[gap="small"] { gap: 8px; }
    s-stack[gap="large"] { gap: 24px; }
    s-stack[alignitems="center"] { align-items: center; }
    s-stack[alignitems="end"] { align-items: flex-end; }
    s-stack[justifycontent="space-between"] { justify-content: space-between; }
    s-box[padding="large"] { padding: 24px; }
    s-table-header-row, s-table-row { display: flex; border-bottom: 1px solid #c9cccf; }
    s-table-body { display: block; }
    s-table-header, s-table-cell { flex: 1 1 0; min-width: 0; padding: 8px; overflow-wrap: anywhere; }
    s-table-header { font-weight: 600; text-align: start; }
    s-table-header[format="numeric"] { text-align: end; }
    @media (max-width: 600px) {
      s-table-header-row { display: none; }
      s-table-row { display: block; margin-bottom: 8px; border: 1px solid #c9cccf; }
      s-table-cell { display: block; }
    }
  `;
  document.head.appendChild(style);

  const TABLE_ROLES = {
    's-table': 'table',
    's-table-header-row': 'row',
    's-table-header': 'columnheader',
    's-table-body': 'rowgroup',
    's-table-row': 'row',
    's-table-cell': 'cell',
  };

  const BASE = css`
    :host { display: block; font: 14px/1.4 system-ui, sans-serif; color: #303030; }
    *:focus-visible { ${FOCUS}; }
    .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `;

  const bool = (el, name) => el.hasAttribute(name) && el.getAttribute(name) !== 'false';

  class ShimElement extends HTMLElement {
    static get observedAttributes() {
      return ['heading', 'label', 'details', 'error', 'disabled', 'loading', 'href', 'target', 'tone', 'variant', 'accessibilitylabel', 'labelaccessibilityvisibility', 'placeholder', 'rows', 'inputmode', 'type'];
    }
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
    }
    connectedCallback() {
      if (!this.shadowRoot.firstChild) this.build();
      this.sync();
    }
    attributeChangedCallback() {
      if (this.shadowRoot.firstChild) this.sync();
    }
    build() {}
    sync() {}
    $(selector) {
      return this.shadowRoot.querySelector(selector);
    }
    html(markup) {
      this.shadowRoot.innerHTML = `<style>${BASE}${this.constructor.styles ?? ''}</style>${markup}`;
    }
  }

  class SPage extends ShimElement {
    static styles = css`:host { padding: 16px; max-width: 1024px; margin: 0 auto; } h1 { font-size: 20px; margin: 0 0 12px; } header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }`;
    build() {
      this.html('<header><h1></h1><div><slot name="primary-action"></slot><slot name="secondary-actions"></slot></div></header><slot></slot>');
    }
    sync() {
      this.$('h1').textContent = this.getAttribute('heading') ?? '';
    }
  }

  class SSection extends ShimElement {
    static styles = css`:host { margin: 0 0 16px; padding: 16px; border: 1px solid #c9cccf; border-radius: 8px; background: #fff; } h2 { font-size: 16px; margin: 0 0 8px; }`;
    build() {
      this.html('<h2></h2><slot></slot>');
    }
    sync() {
      const h = this.$('h2');
      h.textContent = this.getAttribute('heading') ?? '';
      h.hidden = !this.getAttribute('heading');
    }
  }

  class SHeading extends ShimElement {
    static styles = css`div { font-weight: 600; font-size: 16px; }`;
    build() {
      this.html('<div role="heading" aria-level="3"><slot></slot></div>');
    }
  }

  class SBanner extends ShimElement {
    static styles = css`:host { margin: 8px 0; padding: 12px; border: 1px solid #5c5f62; border-inline-start-width: 6px; border-radius: 8px; background: #f6f6f7; color: #1f2124; }
      :host([tone="critical"]) { background: #fee9e8; border-color: #8e1f0b; }
      :host([tone="warning"]) { background: #fff5ea; border-color: #8a6a00; }
      :host([tone="success"]) { background: #cdfee1; border-color: #0c5132; }
      :host([tone="info"]) { background: #eaf4ff; border-color: #0b3d91; }
      strong { display: block; }`;
    build() {
      this.html('<div><strong></strong><slot></slot></div>');
    }
    sync() {
      const heading = this.getAttribute('heading');
      const strong = this.$('strong');
      strong.textContent = heading ?? '';
      strong.hidden = !heading;
      this.$('div').setAttribute('role', this.getAttribute('tone') === 'critical' ? 'alert' : 'status');
    }
  }

  class SSpinner extends ShimElement {
    static styles = css`:host { display: inline-block; } div { width: 16px; height: 16px; border: 2px solid #8a8a8a; border-top-color: #005bd3; border-radius: 50%; }`;
    build() {
      this.html('<div role="progressbar"></div>');
    }
    sync() {
      this.$('div').setAttribute('aria-label', this.getAttribute('accessibilitylabel') ?? 'Loading');
    }
  }

  class SLink extends ShimElement {
    static styles = css`a { color: #005bd3; text-decoration: underline; }`;
    build() {
      this.html('<a><slot></slot></a>');
    }
    sync() {
      const a = this.$('a');
      const href = this.getAttribute('href');
      if (href) a.setAttribute('href', href);
      else a.removeAttribute('href');
      const target = this.getAttribute('target');
      if (target) a.setAttribute('target', target);
      const label = this.getAttribute('accessibilitylabel');
      if (label) a.setAttribute('aria-label', label);
      else a.removeAttribute('aria-label');
    }
  }

  class SButton extends ShimElement {
    static styles = css`:host { display: inline-block; }
      :host([slot]) { margin-inline-end: 8px; }
      button, a { font: inherit; padding: 6px 12px; border: 1px solid #5c5f62; border-radius: 8px; background: #fff; color: #1f2124; cursor: pointer; text-decoration: none; display: inline-block; }
      :host([variant="primary"]) button, :host([variant="primary"]) a { background: #303030; color: #fff; border-color: #303030; }
      :host([tone="critical"]) button { background: #8e1f0b; color: #fff; border-color: #8e1f0b; }
      :host([variant="tertiary"]) button { border-color: transparent; background: transparent; color: #005bd3; text-decoration: underline; }
      button:disabled { opacity: 1; background: #e3e3e3; color: #4a4a4a; cursor: not-allowed; }`;
    build() {
      this.html('<button type="button"><slot></slot></button>');
    }
    sync() {
      const href = this.getAttribute('href');
      let control = this.$('button, a');
      if (href && control.tagName !== 'A') {
        const a = document.createElement('a');
        a.appendChild(document.createElement('slot'));
        control.replaceWith(a);
        control = a;
      }
      if (href) control.setAttribute('href', href);
      const label = this.getAttribute('accessibilitylabel');
      if (label) control.setAttribute('aria-label', label);
      else control.removeAttribute('aria-label');
      if (control.tagName === 'BUTTON') {
        control.disabled = bool(this, 'disabled') || bool(this, 'loading');
        control.setAttribute('aria-busy', bool(this, 'loading') ? 'true' : 'false');
      }
    }
  }

  class SField extends ShimElement {
    static styles = css`label { display: block; font-weight: 500; margin-bottom: 4px; } input, textarea, select { font: inherit; width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #5c5f62; border-radius: 8px; background: #fff; color: #1f2124; }
      .details { color: #4a4a4a; font-size: 13px; margin-top: 4px; } .error { color: #8e1f0b; font-size: 13px; margin-top: 4px; }`;
    control = 'input';
    build() {
      this.html(`<label for="c"></label><${this.control} id="c" aria-describedby="d e"></${this.control}><div class="details" id="d"></div><div class="error" id="e"></div>`);
      const control = this.$('#c');
      // `input` is composed and reaches the host by itself; `change` is not, so it is re-dispatched.
      control.addEventListener('change', () => this.dispatchEvent(new Event('change', { bubbles: true })));
    }
    sync() {
      const control = this.$('#c');
      const label = this.$('label');
      label.textContent = this.getAttribute('label') ?? '';
      label.className = this.getAttribute('labelaccessibilityvisibility') === 'exclusive' ? 'sr-only' : '';
      this.$('.details').textContent = this.getAttribute('details') ?? '';
      const error = this.getAttribute('error');
      this.$('.error').textContent = error ?? '';
      control.setAttribute('aria-invalid', error ? 'true' : 'false');
      control.disabled = bool(this, 'disabled');
      const placeholder = this.getAttribute('placeholder');
      if (placeholder) control.setAttribute('placeholder', placeholder);
      const rows = this.getAttribute('rows');
      if (rows && control.tagName === 'TEXTAREA') control.rows = Number(rows);
      const inputMode = this.getAttribute('inputmode');
      if (inputMode) control.setAttribute('inputmode', inputMode);
      if (this._value !== undefined && control.value !== this._value) control.value = this._value;
    }
    get value() {
      const control = this.$('#c');
      return control ? control.value : (this._value ?? '');
    }
    set value(v) {
      this._value = v == null ? '' : String(v);
      const control = this.$('#c');
      if (control && control.value !== this._value) control.value = this._value;
    }
  }
  class STextField extends SField {}
  class STextArea extends SField {
    control = 'textarea';
  }

  class SSelect extends SField {
    control = 'select';
    connectedCallback() {
      super.connectedCallback();
      this._observer = new MutationObserver(() => this.options());
      this._observer.observe(this, { childList: true, subtree: true, attributes: true, characterData: true });
      this.options();
    }
    disconnectedCallback() {
      this._observer?.disconnect();
    }
    options() {
      const select = this.$('#c');
      if (!select) return;
      const wanted = [...this.querySelectorAll('s-option')].map((o) => ({ value: o.getAttribute('value') ?? o.textContent ?? '', label: o.textContent ?? '', selected: bool(o, 'selected') }));
      select.replaceChildren(
        ...wanted.map((o) => {
          const option = document.createElement('option');
          option.value = o.value;
          option.textContent = o.label;
          return option;
        }),
      );
      const selected = this._value ?? wanted.find((o) => o.selected)?.value;
      if (selected !== undefined) select.value = selected;
    }
    set value(v) {
      this._value = v == null ? '' : String(v);
      const select = this.$('#c');
      if (select && select.value !== this._value) select.value = this._value;
    }
    get value() {
      const select = this.$('#c');
      return select ? select.value : (this._value ?? '');
    }
  }

  class SCheckbox extends ShimElement {
    static styles = css`.row { display: flex; gap: 8px; align-items: flex-start; } .details { color: #4a4a4a; font-size: 13px; } input { width: 18px; height: 18px; margin: 2px 0 0; }`;
    build() {
      this.html('<div class="row"><input id="c" type="checkbox" aria-describedby="d"><div><label for="c"></label><div class="details" id="d"></div></div></div>');
      this.$('#c').addEventListener('change', () => this.dispatchEvent(new Event('change', { bubbles: true })));
    }
    sync() {
      this.$('label').textContent = this.getAttribute('label') ?? '';
      this.$('.details').textContent = this.getAttribute('details') ?? '';
      this.$('#c').disabled = bool(this, 'disabled');
      if (this._checked !== undefined) this.$('#c').checked = this._checked;
      else if (this.hasAttribute('checked')) this.$('#c').checked = true;
    }
    get checked() {
      const c = this.$('#c');
      return c ? c.checked : Boolean(this._checked);
    }
    set checked(v) {
      this._checked = Boolean(v);
      const c = this.$('#c');
      if (c) c.checked = this._checked;
    }
  }

  class SModal extends ShimElement {
    static styles = css`dialog { border: 1px solid #5c5f62; border-radius: 12px; padding: 16px; max-width: 480px; width: calc(100% - 32px); } dialog::backdrop { background: rgba(0,0,0,.5); } h2 { font-size: 16px; margin: 0 0 12px; } footer { margin-top: 16px; display: flex; justify-content: flex-end; flex-direction: row-reverse; gap: 8px; }`;
    build() {
      this.html('<dialog aria-labelledby="t"><h2 id="t"></h2><slot></slot><footer><slot name="primary-action"></slot><slot name="secondary-actions"></slot></footer></dialog>');
      this.$('dialog').addEventListener('close', () => this.dispatchEvent(new Event('afterhide')));
    }
    sync() {
      this.$('#t').textContent = this.getAttribute('heading') ?? '';
    }
    showOverlay() {
      const d = this.$('dialog');
      if (d && !d.open) d.showModal();
    }
    hideOverlay() {
      const d = this.$('dialog');
      if (d?.open) d.close();
    }
  }

  const define = (tag, ctor) => {
    if (!customElements.get(tag)) customElements.define(tag, ctor);
  };
  define('s-page', SPage);
  define('s-section', SSection);
  define('s-heading', SHeading);
  define('s-banner', SBanner);
  define('s-spinner', SSpinner);
  define('s-link', SLink);
  define('s-button', SButton);
  define('s-text-field', STextField);
  define('s-text-area', STextArea);
  define('s-select', SSelect);
  define('s-checkbox', SCheckbox);
  define('s-modal', SModal);

  // Table parts: semantics from ARIA roles on the hosts (the real components do the same).
  for (const tag of Object.keys(TABLE_ROLES)) {
    define(tag, class extends HTMLElement {
      connectedCallback() {
        if (!this.hasAttribute('role')) this.setAttribute('role', TABLE_ROLES[tag]);
      }
    });
  }
  // Leaf elements with no behaviour (styled above).
  for (const tag of ['s-text', 's-paragraph', 's-badge', 's-stack', 's-box', 's-app-nav', 's-option']) define(tag, class extends HTMLElement {});
})();
