import { el, qsa } from '../utils/dom.js';

/**
 * Modal is a generic, reusable dialog component. It builds its own DOM,
 * mounts to <body> on open(), and cleans up on close(). Any feature can
 * do `new Modal({...}).open()` without touching index.html.
 *
 * Usage:
 *   const modal = new Modal({
 *     title: 'Add item',
 *     body: someNode | 'HTML string',
 *     footer: [
 *       { label: 'Cancel', variant: 'btn-outline', onClick: (m) => m.close() },
 *       { label: 'Save', variant: 'btn-accent', onClick: (m) => { ... } }
 *     ],
 *     onClose: () => {}
 *   });
 *   modal.open();
 *
 * `footerExtra` (optional) is a DOM node rendered as its own row inside the
 * sticky footer, above the button row — for controls a feature wants
 * reachable without scrolling the (potentially long) modal body, e.g.
 * ManifestModal's "+ Add row" / warehouse picker. The buttons themselves
 * live in `this.buttonsEl` now (a child of `this.footEl`), but `footEl`
 * still contains both, so existing callers doing
 * `modal.footEl.querySelector('.btn-accent')` keep working unchanged.
 */
export class Modal {
  // Every currently-open Modal, regardless of which feature created it.
  // Nothing else in the app previously tracked "is a modal open" at all —
  // switching tabs or Settings sections left whatever modal was open
  // floating on top of the newly-selected screen instead of closing.
  // See closeAll(), called from TabManager.activate() and
  // SettingsController's section-nav click handler.
  static _open = new Set();

  /** Closes every currently-open modal — call whenever the visible section changes. */
  static closeAll() {
    [...Modal._open].forEach((modal) => modal.close());
  }

  constructor({ title = '', body = '', footer = [], footerExtra = null, onClose = null, closeOnOverlayClick = true, size = '' } = {}) {
    this.onClose = onClose;
    this.closeOnOverlayClick = closeOnOverlayClick;
    this._previousFocus = null;
    this._handleKeydown = this._handleKeydown.bind(this);
    this._build(title, body, footer, size, footerExtra);
  }

  _build(title, body, footer, size, footerExtra) {
    this.overlay = el(`<div class="overlay" role="dialog" aria-modal="true"></div>`);
    this.modalEl = el(`<div class="modal${size ? ` modal--${size}` : ''}"></div>`);

    this.headEl = el(`
      <div class="modal-head">
        <h2></h2>
        <button tabindex="-1" type="button" class="modal-close" aria-label="Close">✕</button>
      </div>
    `);
    this.headEl.querySelector('h2').textContent = title;
    this.headEl.querySelector('.modal-close').addEventListener('click', () => this.close());

    this.bodyEl = el(`<div class="modal-body"></div>`);
    this.setBody(body);

    this.footEl = el(`<div class="modal-foot"></div>`);
    // Optional caller-supplied row (e.g. ManifestModal's "+ Add row" /
    // warehouse picker) goes above the button row, both inside the same
    // sticky footer so it stays reachable without scrolling the body.
    if (footerExtra) this.footEl.appendChild(footerExtra);
    this.buttonsEl = el(`<div class="modal-foot-buttons"></div>`);
    this.footEl.appendChild(this.buttonsEl);
    this.setFooter(footer);

    this.modalEl.append(this.headEl, this.bodyEl, this.footEl);
    this.overlay.appendChild(this.modalEl);

    this.overlay.addEventListener('click', (e) => {
      if (this.closeOnOverlayClick && e.target === this.overlay) this.close();
    });
  }

  /** Replace the modal body with a string of HTML or a DOM node. */
  setBody(content) {
    this.bodyEl.innerHTML = '';
    if (content instanceof Node) {
      this.bodyEl.appendChild(content);
    } else if (typeof content === 'string') {
      this.bodyEl.innerHTML = content;
    }
  }

  /** Replace the footer buttons. Each entry: { label, variant, onClick(modal) } */
  setFooter(buttons) {
    this.buttonsEl.innerHTML = '';
    buttons.forEach((btn) => {
      const button = el(`<button tabindex="-1" type="button" class="btn ${btn.variant || 'btn-outline'}"></button>`);
      button.textContent = btn.label;
      button.addEventListener('click', () => btn.onClick?.(this));
      this.buttonsEl.appendChild(button);
    });
  }

  open() {
    Modal._open.add(this);
    document.body.appendChild(this.overlay);
    this._previousFocus = document.activeElement;
    document.addEventListener('keydown', this._handleKeydown);
    requestAnimationFrame(() => {
      this.overlay.classList.add('open');
      const focusable = qsa('input, button, select, textarea, [tabindex]', this.modalEl)[0];
      focusable?.focus();
    });
  }

  close() {
    Modal._open.delete(this);
    this.overlay.classList.remove('open');
    document.removeEventListener('keydown', this._handleKeydown);
    setTimeout(() => {
      this.overlay.remove();
      this._previousFocus?.focus?.();
      this.onClose?.();
    }, 150);
  }

  _handleKeydown(e) {
    if (e.key === 'Escape') {
      this.close();
      return;
    }
    if (e.key === 'Tab') this._trapFocus(e);
  }

  _trapFocus(e) {
    const focusables = qsa('input, button, select, textarea, [tabindex]', this.modalEl)
      .filter((node) => !node.disabled);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}