import { Requisition, REQUISITION_APPROVERS } from '../../models/Requisition.js';
import { Toast } from '../../components/Toast.js';
import { confirmDialog } from '../../components/ConfirmDialog.js';
import { SuggestList } from '../../components/SuggestList.js';
import { openDropdownMenu } from '../../components/DropdownMenu.js';
import { Modal } from '../../components/Modal.js';
import { getOperatorName } from '../../core/Operator.js';
import { can } from '../../core/Permissions.js';
import { el, esc } from '../../utils/dom.js';
import { fmtLocalDateTime } from '../../utils/format.js';

/**
 * RequisitionController owns the Requisition Form tab: an in-app clone of
 * the reference "Operation Gadget Request Form" Google Form (see the
 * FORM-vs-Print-Preview reference screenshots this was built from).
 *
 * Item rows (Gadget Type + Qty, addable/removable via "+ Add row") are
 * managed directly here rather than through RequisitionView, since
 * they're transient in-progress form state, not something derived from
 * the store — see RequisitionView's own header comment for why a full
 * re-render would be wrong for these specifically.
 *
 * Printing reuses the same body-class + `@media print` technique as
 * ManifestModal (see css/modal.css's `.printing-manifest` rules and this
 * feature's own `.printing-requisition` rules in css/requisition.css): a
 * dedicated `#requisitionPrintArea` element — a direct child of <body>,
 * so it's unaffected by which tab panel is currently hidden — gets built
 * fresh from the submitted values right before `window.print()` runs, so
 * the printed page only ever shows what's actually filled in, same as
 * the reference's own Print Preview.
 *
 * Submitting also mirrors ManifestModal's own print-then-confirm shape:
 * browsers give no signal distinguishing "printed/saved" from "hit
 * Cancel" in the print dialog, so nothing is saved to the store until
 * the person confirms, in a dialog shown right after the print dialog
 * closes either way, that it actually went through. Declining leaves the
 * form exactly as filled in — nothing persisted, nothing cleared — so a
 * Submit clicked by mistake, or one more typo to fix, is always
 * recoverable rather than already being a saved (and reset) record.
 */
export class RequisitionController {
  constructor({ store, inventoryAssetStore, gadgetStore, locationStore, view, refs }) {
    this.store = store;
    this.inventoryAssetStore = inventoryAssetStore;
    // Only used to compute Gadget Type's "N available" suggestion hint —
    // see _computeAvailableByCategory(). Optional: if either is missing
    // (e.g. a future caller that doesn't wire them up), suggestions just
    // fall back to plain category names with no count, same as before
    // this feature existed.
    this.gadgetStore = gadgetStore;
    this.locationStore = locationStore;
    this.view = view;
    this.refs = refs;
    this._rowSeq = 0;
    this._categories = [];
    this._availableByCategory = {};
  }

  init() {
    this.view.renderApprovers();
    this._refreshSuggestions();
    this._addItemRow();

    this.refs.addRowBtn?.addEventListener('click', () => this._addItemRow());
    this.refs.formEl?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._submit();
    });
    this.refs.clearBtn?.addEventListener('click', () => this._resetForm());
    this.refs.historyListEl?.addEventListener('click', (e) => {
      const printBtn = e.target.closest('[data-action="reprint"]');
      if (printBtn) {
        if (!can('requisition.print')) return;
        const requisition = this.store.get(printBtn.dataset.id);
        if (requisition) this._reprint(requisition);
        return;
      }
      const menuBtn = e.target.closest('[data-action="row-menu"]');
      if (menuBtn) {
        if (!can('requisition.action')) return;
        this._openRowMenu(menuBtn, menuBtn.dataset.id);
      }
    });
    this.refs.clearAllBtn?.addEventListener('click', () => this._clearAll());

    this.store.on('change', () => this._renderHistory());
    // Inventory Assets is the "suggest from Inventory" source for Gadget
    // Type — its own catalog changing (an asset added/edited/imported
    // under a new category) should widen the suggestion list without
    // needing this tab to be reopened. Gadgets and Warehouse Locations
    // feed the "N available" count next to each suggestion (see
    // _computeAvailableByCategory) — a transfer in/out of the default
    // stock room, or the default itself moving to a different location,
    // should update that count live too.
    this.inventoryAssetStore?.on('change', () => this._refreshSuggestions());
    this.gadgetStore?.on('change', () => this._refreshSuggestions());
    this.locationStore?.on('change', () => this._refreshSuggestions());

    this.render();
  }

  /** Rebuilds the suggestion data (category list + available counts) and
   * refreshes any "N available" text already showing on a row — doesn't
   * touch what's typed into a category input, only the hint below it. */
  _refreshSuggestions() {
    this._categories = this.inventoryAssetStore
      ? [...new Set(this.inventoryAssetStore.list().map((a) => a.category).filter(Boolean))].sort()
      : [];
    this._availableByCategory = this._computeAvailableByCategory();
    this._syncAvailableBadges();
  }

  /** Counts gadgets currently sitting at whichever WarehouseLocation(s)
   * are flagged isDefaultStockRoom (see WarehouseLocationModal's "Stock
   * Room" column — Settings → Warehouse Information), grouped by
   * category. A gadget "sits at" a location when its `merchant` field
   * matches that location's `locationCode` — the same field the transfer
   * flow itself writes (see utils/merchantPlacement.js). If more than one
   * warehouse has its own default (each warehouse can have one), this
   * sums across all of them — a requester picking a Gadget Type isn't
   * choosing a warehouse first, so "available" means available anywhere
   * it'd normally be pulled from. */
  _computeAvailableByCategory() {
    if (!this.gadgetStore || !this.locationStore) return {};
    const defaultCodes = new Set(
      this.locationStore.list().filter((l) => l.isDefaultStockRoom && l.locationCode).map((l) => l.locationCode)
    );
    if (defaultCodes.size === 0) return {};
    const counts = {};
    this.gadgetStore.list().forEach((g) => {
      if (!defaultCodes.has(g.merchant)) return;
      const category = g.category || 'Uncategorized';
      counts[category] = (counts[category] || 0) + 1;
    });
    return counts;
  }

  /** "Zeneya" for a single default, "3 default stock rooms" for several,
   * or a generic fallback if none is set yet — used in the available-
   * count hint so it reads as "N available at Zeneya" rather than just a
   * bare number with no source. */
  // _defaultStockRoomLabel() {
  //   const defaults = this.locationStore ? this.locationStore.list().filter((l) => l.isDefaultStockRoom) : [];
  //   if (defaults.length === 0) return 'the default stock room';
  //   if (defaults.length === 1) return defaults[0].locationCode || 'the default stock room';
  //   return `${defaults.length} default stock rooms`;
  // }

  /** Public entry point for a re-render triggered from outside this
   * controller — currently only app.js's refreshLivePermissions(), which
   * calls this (alongside every other controller's own render()) so a
   * UserGroup permission change takes effect immediately in whatever tab
   * is already open, matching the rest of the app instead of needing a
   * sign-out/sign-in to pick up a Requisition permission change. */
  render() {
    this._applyPermissions();
    this._renderHistory();
  }

  /** Disables (with an explanatory tooltip, same pattern as
   * ManageController's own action-bar gating) whichever of Clear all
   * data / Print / Action this session's UserGroup denies — see
   * PERMISSION_TREE's 'requisition' children in models/UserGroup.js.
   * Clear all data is static, so this only needs to run once; Print and
   * Action are per-row and rebuilt on every _renderHistory(), so those
   * are baked in there instead (see RequisitionView.renderHistory). */
  _applyPermissions() {
    const canClearAll = can('requisition.clear-all');
    if (this.refs.clearAllBtn) {
      this.refs.clearAllBtn.disabled = !canClearAll;
      this.refs.clearAllBtn.title = canClearAll ? '' : 'You do not have permission to clear all data.';
    }
  }

  _renderHistory() {
    const requisitions = [...this.store.list()].sort((a, b) => b.createdAt - a.createdAt);
    this.view.renderHistory(requisitions, {
      canPrint: can('requisition.print'),
      canAction: can('requisition.action')
    });
  }

  /** Opens the per-row Action menu (Print's neighbor in Recent
   * Requisitions) — Finish (or Reopen, once already finished), View log,
   * plus Delete, via the shared DropdownMenu component rather than a
   * bespoke popover. "Process request" used to live here too; it now
   * lives in Manage's own action bar (see
   * ManageController.openProcessRequestModal) so the assets issued are
   * exactly the ones selected in that grid, previewed and printed the
   * same way a Manifest transfer is. */
  _openRowMenu(anchor, id) {
    if (!can('requisition.action')) return;
    const requisition = this.store.get(id);
    if (!requisition) return;
    const pending = requisition.status !== 'finished';
    const items = [
      pending
        ? { label: 'Finish', onClick: () => this._setStatus(id, 'finished') }
        : { label: 'Reopen', onClick: () => this._setStatus(id, 'pending') },
      { label: 'View log', onClick: () => this._openFulfillmentLog(id) },
      { label: 'Delete', danger: true, onClick: () => this._deleteRequisition(id) }
    ];
    openDropdownMenu({ anchor, items });
  }

  /** "View log" — the counterpart to the "Finished · N issued" pill
   * shown in Recent Requisitions once a request is Finished (see
   * RequisitionView.renderHistory). What was *requested* (Gadget Type ×
   * Qty, filled in on the form) and what was actually *served* (every row
   * Process Request issued — see ProcessRequestModal's own
   * applyProcessing(), the only writer of `fulfilledItems`/
   * `fulfilledGadgetIds`) can differ once quantities, substitutions, or a
   * hand Finish (no assets ever selected) enter the picture, so this
   * shows both side by side instead of assuming the pill's count tells
   * the whole story.
   *
   * Each served row prefers the *live* Gadget (resolved via its
   * `gadgetId`, exactly as Manage would show it right now — e.g. after a
   * pending transfer since got confirmed) and falls back to the frozen
   * snapshot `fulfilledItems` recorded at issue time otherwise — which is
   * the *only* data available for a hand-typed row (no backing Gadget to
   * begin with, e.g. a power cable that isn't tracked as its own
   * serialized asset) and for a real asset since deleted from Manage.
   * gadgetStore is the same one already wired up for the Gadget Type
   * "N available" suggestion hint, reused here for that live lookup.
   *
   * `fulfilledItems` didn't always exist — a requisition finished before
   * this field was added only recorded `fulfilledGadgetIds`. For those,
   * this falls back further to the old id-only behavior: resolve each id
   * against gadgetStore and skip (just counting) whatever no longer
   * resolves, since there's no snapshot to fall back to for those.
   */
  _openFulfillmentLog(id) {
    const requisition = this.store.get(id);
    if (!requisition) return;

    const requestedRows = requisition.items.length
      ? requisition.items.map((i) => `
          <tr><td>${esc(i.category)}</td><td>${esc(String(i.qty))}</td></tr>
        `).join('')
      : `<tr><td colspan="2" class="hint">No items were listed on this request.</td></tr>`;

    const hasSnapshots = (requisition.fulfilledItems || []).length > 0;
    // Legacy fallback: a requisition finished before fulfilledItems
    // existed only recorded gadget ids — treat each as a snapshot-less
    // entry so the loop below still has something to iterate, just with
    // nothing to fall back on if the live asset is gone.
    const fulfilledItems = hasSnapshots
      ? requisition.fulfilledItems
      : (requisition.fulfilledGadgetIds || []).map((gid) => ({ gadgetId: gid }));

    let missingCount = 0;
    const servedRows = [];
    fulfilledItems.forEach((item) => {
      const live = item.gadgetId ? this.gadgetStore?.get(item.gadgetId) : null;
      const hasSnapshot = Boolean(item.category || item.serialNumber || item.user || item.merchant);
      if (item.gadgetId && !live && !hasSnapshot) {
        // Legacy id-only entry whose asset is gone — nothing to show,
        // same as the old behavior: count it, don't render a blank row.
        missingCount++;
        return;
      }
      const source = live || item;
      servedRows.push(`
        <tr>
          <td>${esc(source.category || 'Uncategorized')}</td>
          <td>${esc(source.serialNumber || '—')}</td>
          <td>${esc(source.warehouseAssetTag || '—')}</td>
          <td>${esc(source.user || '—')}</td>
          <td>${esc(source.merchant || '—')}</td>
        </tr>
      `);
    });

    let servedBody;
    if (requisition.status !== 'finished') {
      servedBody = '<p class="hint">This requisition hasn\'t been finished yet — nothing has been issued against it.</p>';
    } else if (servedRows.length === 0) {
      servedBody = '<p class="hint">Marked finished, but no specific assets are on record — it was likely finished by hand rather than through Process Request.</p>';
    } else {
      servedBody = `
        <table class="requisition-log-table">
          <thead>
            <tr><th>Category</th><th>Serial Number</th><th>Warehouse Asset Tag</th><th>User</th><th>Merchant</th></tr>
          </thead>
          <tbody>
            ${servedRows.join('')}
          </tbody>
        </table>
        ${missingCount > 0 ? `<p class="hint">${missingCount} issued asset${missingCount === 1 ? '' : 's'} no longer exist${missingCount === 1 ? 's' : ''} in Manage — likely deleted since it was issued.</p>` : ''}
      `;
    }

    const body = el(`
      <div class="requisition-log-modal">
        <div class="requisition-log-section">
          <h4>Requested</h4>
          <table class="requisition-log-table">
            <thead><tr><th>Gadget Type</th><th>Qty</th></tr></thead>
            <tbody>${requestedRows}</tbody>
          </table>
        </div>
        <div class="requisition-log-section">
          <h4>Actually Served</h4>
          ${servedBody}
        </div>
      </div>
    `);

    new Modal({
      title: `Requisition Log — ${requisition.requesterName || 'Unnamed requester'}`,
      body,
      size: 'lg',
      footer: [{ label: 'Close', variant: 'btn-outline', onClick: (m) => m.close() }]
    }).open();
  }

  /** Finish marks a requisition fulfilled (shown with a "Finished" pill
   * in Recent Requisitions); Reopen undoes that if it was set by
   * mistake. Neither touches anything else about the record — the
   * printed copy, items, purpose, etc. are exactly what was submitted
   * either way. */
  _setStatus(id, status) {
    const requisition = this.store.get(id);
    if (!requisition) return;
    this.store.update(id, { status });
    Toast.success(status === 'finished'
      ? `Marked the requisition for ${requisition.requesterName || 'this request'} as finished.`
      : `Reopened the requisition for ${requisition.requesterName || 'this request'}.`);
  }

  async _deleteRequisition(id) {
    const requisition = this.store.get(id);
    if (!requisition) return;
    const ok = await confirmDialog({
      title: 'Delete requisition',
      message: `Delete the requisition for ${requisition.requesterName || 'this request'}? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true
    });
    if (!ok) return;
    this.store.delete(id);
    Toast.show('Requisition deleted.');
  }

  /** "Clear all data" for Recent Requisitions — same shape as Manage's
   * and Inventory Assets' own Clear-all: a danger-styled confirm before
   * wiping every submitted requisition from this browser. Doesn't touch
   * the in-progress form itself, only the history list underneath it. */
  async _clearAll() {
    if (!can('requisition.clear-all')) return;
    if (this.store.list().length === 0) {
      Toast.show('There is nothing to clear.');
      return;
    }
    const ok = await confirmDialog({
      title: 'Clear all data',
      message: 'Delete every submitted requisition from this browser? This cannot be undone.',
      confirmLabel: 'Clear all',
      danger: true
    });
    if (!ok) return;
    this.store.clear();
    Toast.show('All requisition data cleared.');
  }

  /**
   * Appends one Gadget Type + Qty row. Typing or focusing the category
   * input opens a suggestion dropdown built fresh from _categories/
   * _availableByCategory (see _openCategorySuggestions) — a row shows
   * only the one category picked for it, and "+ Add row" is how another
   * gets added, matching the reference's own FORM view. Below the input,
   * a small hint line shows how many of that category are sitting at the
   * default stock room right now (_updateAvailableBadge) — nothing shows
   * there for a category that isn't a recognized Inventory Assets
   * category, since there'd be no meaningful count to report.
   *
   * `rowId` only keys the DOM node while rows are being added/removed —
   * it's never read back out or persisted.
   */
  _addItemRow() {
    if (!this.refs.itemsEl) return;
    const rowId = `row-${++this._rowSeq}`;
    const row = document.createElement('div');
    row.className = 'requisition-item-row';
    row.dataset.rowId = rowId;
    row.innerHTML = `
      <div class="req-item-category-wrap">
        <input type="text" class="req-item-category" placeholder="Gadget type" data-role="category" autocomplete="off">
        <!-- <div class="req-item-available" data-role="available"></div> -->
      </div>
      <input type="number" class="req-item-qty" min="1" step="1" placeholder="Qty" data-role="qty">
      <button tabindex="-1" type="button" class="req-item-remove" data-action="remove-row" aria-label="Remove row">&times;</button>
    `;
    const categoryInput = row.querySelector('[data-role="category"]');
    categoryInput.addEventListener('focus', () => this._openCategorySuggestions(row, categoryInput));
    categoryInput.addEventListener('input', () => {
      this._openCategorySuggestions(row, categoryInput);
      this._updateAvailableBadge(row, categoryInput.value);
    });
    row.querySelector('[data-action="remove-row"]').addEventListener('click', () => {
      // Always leave at least one row on screen — a form with zero rows
      // reads as broken, not as "nothing selected yet"; clearing the one
      // remaining row's values is the equivalent action.
      if (this.refs.itemsEl.children.length <= 1) {
        categoryInput.value = '';
        row.querySelector('[data-role="qty"]').value = '';
        this._updateAvailableBadge(row, '');
        return;
      }
      row.remove();
    });
    this.refs.itemsEl.appendChild(row);
  }

  /** Opens (or, called again on the same anchor while typing, replaces)
   * the Gadget Type suggestion popover for one row — every known category
   * whose name contains what's currently typed (case-insensitive,
   * matches on empty text too), laid out as a fixed "Category / Available"
   * header over an independently scrolling list (see components/
   * SuggestList.js) so the column headers stay put no matter how far
   * down a long catalog someone scrolls, rather than DropdownMenu's
   * single label-per-row shape.
   *
   * Built via `new SuggestList().open()` directly rather than a toggle-
   * style wrapper: every keystroke needs a *freshly filtered* list on the
   * same anchor, not for it to disappear the way a second click on a
   * toggle trigger would. SuggestList's own singleton rule still enforces
   * "only one open app-wide", so this doesn't reintroduce the multiple-
   * popovers-stacking problem that rule exists to prevent.
   */
  _openCategorySuggestions(row, inputEl) {
    const query = inputEl.value.trim().toLowerCase();
    const matches = this._categories.filter((c) => !query || c.toLowerCase().includes(query));
    if (matches.length === 0) return;
    new SuggestList({
      anchor: inputEl,
      columns: ['Category', 'Available'],
      rows: matches.map((category) => {
        const available = this._availableByCategory[category];
        return {
          cells: [category, available === undefined ? 'No stock' : String(available)],
          className: available === undefined || available === 0 ? 'is-zero' : '',
          onClick: () => {
            inputEl.value = category;
            this._updateAvailableBadge(row, category);
          }
        };
      })
    }).open();
  }

  /** Sets (or clears) the "N available at <location>" hint under one
   * row's category input. Only shows anything for a category that's
   * actually in _categories — free-typed text that doesn't match a real
   * Inventory Assets category has no count to report, so the hint just
   * stays blank rather than implying zero means "none exist". */
  _updateAvailableBadge(row, categoryRaw) {
    const badge = row.querySelector('[data-role="available"]');
    if (!badge) return;
    const category = (categoryRaw || '').trim();
    if (!category || !this._categories.includes(category)) {
      badge.textContent = '';
      badge.classList.remove('is-zero');
      return;
    }
    const available = this._availableByCategory[category] || 0;
    badge.textContent = `${available} available at ${this._defaultStockRoomLabel()}`;
    badge.classList.toggle('is-zero', available === 0);
  }

  /** Re-runs _updateAvailableBadge for every row currently on screen —
   * called after _refreshSuggestions() so a row already showing a count
   * doesn't go stale while the form is still open. */
  _syncAvailableBadges() {
    if (!this.refs.itemsEl) return;
    this.refs.itemsEl.querySelectorAll('.requisition-item-row').forEach((row) => {
      const input = row.querySelector('[data-role="category"]');
      this._updateAvailableBadge(row, input?.value || '');
    });
  }

  _collectItems() {
    if (!this.refs.itemsEl) return [];
    return Array.from(this.refs.itemsEl.querySelectorAll('.requisition-item-row')).map((row) => ({
      category: row.querySelector('[data-role="category"]').value.trim(),
      qty: Number(row.querySelector('[data-role="qty"]').value) || 0
    }));
  }

  _showErrors(errors) {
    this.refs.formEl?.querySelectorAll('.field-error').forEach((node) => { node.textContent = ''; });
    Object.entries(errors).forEach(([field, message]) => {
      const node = this.refs.formEl?.querySelector(`[data-error-for="${field}"]`);
      if (node) node.textContent = message;
    });
  }

  _submit() {
    const raw = {
      email: this.refs.emailInput?.value.trim() || '',
      requesterName: this.refs.requesterNameInput?.value.trim() || '',
      items: this._collectItems(),
      purpose: this.refs.purposeInput?.value.trim() || ''
    };

    const { valid, errors } = Requisition.validate(raw);
    if (!valid) {
      this._showErrors(errors);
      Toast.error('Fill in the required fields before submitting.');
      return;
    }
    this._showErrors({});

    // Not saved yet — a preview copy, so the printed page and the
    // eventual store record end up with identical values (same id,
    // same createdAt) once confirmed, without persisting anything a
    // person might still want to back out of and keep editing.
    const requisition = new Requisition({
      ...raw,
      items: raw.items.filter((i) => i.category && i.qty > 0),
      submittedBy: getOperatorName()
    });

    this._renderPrintArea(requisition);
    this._runPrint(async () => {
      const confirmed = await confirmDialog({
        title: 'Confirm requisition',
        message: `Did the requisition for ${requisition.requesterName || 'this request'} finish printing or saving? Confirming will submit it and clear the form for a new request.`,
        confirmLabel: 'Yes, submit',
        cancelLabel: 'No, keep editing'
      });
      if (!confirmed) return;

      this.store.create(requisition);
      Toast.success(`Requisition submitted for ${requisition.requesterName}.`);
      this._resetForm();
    });
  }

  _resetForm() {
    this.refs.formEl?.reset();
    if (this.refs.itemsEl) this.refs.itemsEl.innerHTML = '';
    this._addItemRow();
    this._showErrors({});
  }

  /** Reprints an already-submitted entry from Recent Requisitions — no
   * confirm-to-submit step, since there's nothing left to confirm: it
   * was already saved when the original Submit went through. */
  _reprint(requisition) {
    this._renderPrintArea(requisition);
    this._runPrint();
  }

  /**
   * Builds the print-only summary into #requisitionPrintArea — same
   * "only what's filled in shows up" shape as the reference's own Print
   * Preview (no Email-checkbox instructional text, no blank/unused rows).
   * Content only — see _runPrint() for actually triggering the dialog.
   */
  _renderPrintArea(requisition) {
    const printArea = document.getElementById('requisitionPrintArea');
    if (!printArea) return;

    const itemsRows = requisition.items.map((i) => `
      <tr><td>${esc(i.category)}</td><td>${esc(String(i.qty))}</td></tr>
    `).join('');

    printArea.innerHTML = `
      <div class="req-print-bar"></div>
      <div class="req-print-body">
        <h1 class="req-print-title">Requisition Form</h1>
        <p class="req-print-subtitle">Operation Gadget Request Form</p>
        <div class="req-print-field"><span class="req-print-label">Requester Name</span><span class="req-print-value">${esc(requisition.requesterName)}</span></div>
        <div class="req-print-field"><span class="req-print-label">Email</span><span class="req-print-value">${esc(requisition.email)}</span></div>
        <table class="req-print-table">
          <thead><tr><th>Gadget Type</th><th>Quantity</th></tr></thead>
          <tbody>${itemsRows}</tbody>
        </table>
        <div class="req-print-field req-print-field--block"><span class="req-print-label">Purpose</span><p class="req-print-value">${esc(requisition.purpose)}</p></div>
        <div class="req-print-approved">
          <span class="req-print-label">Approved by</span>
          <p class="requisition-hint">Signature below…</p>
          <div class="requisition-approvers">
            ${REQUISITION_APPROVERS.map((name) => `
              <div class="requisition-approver">
                <span class="requisition-approver-name">${esc(name)}</span>
                <span class="requisition-approver-line"></span>
              </div>
            `).join('')}
          </div>
        </div>
        <p class="req-print-footer">Submitted ${esc(fmtLocalDateTime(requisition.createdAt))}${requisition.submittedBy ? ` · By ${esc(requisition.submittedBy)}` : ''}</p>
      </div>
    `;
  }

  /**
   * Adds the print-only body class, runs window.print(), and once the
   * dialog closes (print or cancel — afterprint fires either way)
   * removes the class, clears the print area, then runs `onAfterPrint`
   * if given. Same body-class technique as ManifestModal's
   * `.printing-manifest` (see css/modal.css / css/requisition.css).
   */
  _runPrint(onAfterPrint) {
    const printArea = document.getElementById('requisitionPrintArea');
    document.body.classList.add('printing-requisition');
    window.addEventListener('afterprint', async () => {
      document.body.classList.remove('printing-requisition');
      if (printArea) printArea.innerHTML = '';
      await onAfterPrint?.();
    }, { once: true });
    window.print();
  }
}
