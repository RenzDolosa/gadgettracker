import { Modal } from './Modal.js';
import { el, esc, qsa } from '../utils/dom.js';
import { generateId } from '../utils/id.js';
import { fmtManifestDate } from '../utils/format.js';
import { getOperatorName } from '../core/Operator.js';
import { Toast } from './Toast.js';
import { confirmDialog } from './ConfirmDialog.js';
import { resolveMerchantPlacement, destinationWarehouseId, findMatchingLocations } from '../utils/merchantPlacement.js';
import { enhanceSelect } from './SelectField.js';

/**
 * ProcessRequestModal renders a printable "Process Request" document that
 * pairs a set of Manage assets (checked in the grid, same as Preview
 * Manifest's own selection) with a pending Requisition — the in-app
 * equivalent of physically pulling stock to fulfill a request form.
 *
 * Deliberately the *same shape* as ManifestModal, right down to reusing
 * its CSS classes (manifest-doc / manifest-detail-table / manifest-meta-*
 * / .printing-manifest) and its "Transfer to" merchant-resolution UI:
 * rows are pre-filled from the selected gadgets but every cell stays
 * editable, a person can hand-add fully blank rows for items not yet in
 * the system, and nothing is written back until Issue / Print's print
 * dialog closes and the person confirms it actually went through
 * (browsers give no way to distinguish "printed/saved" from "hit
 * Cancel" — see ManifestModal's own doc comment for why that confirm
 * step exists).
 *
 * "Transfer to" is the same merchant/location key Manifest uses — it
 * resolves to a Position Type / Warehouse / Owner exactly the way a
 * Manifest transfer does (see utils/merchantPlacement.js), and applying
 * it follows the *same* pending-vs-immediate split: a match against a
 * currently active location queues a Gadget.pendingTransfer for whoever's
 * User Group is bound to that destination warehouse to confirm — the
 * asset isn't actually placed there yet, only requested to be — while an
 * unmatched value (unreachable through Issue / Print's own validation
 * below, same as Manifest's own "never arbitrary typed text" rule) would
 * apply immediately if this were ever called directly.
 *
 * What's different from a Manifest transfer: issuing to a *person* isn't
 * something that needs receiving confirmation the way a location transfer
 * does — the requester already has the unit in hand — so `user` is always
 * written immediately, regardless of whether the merchant/placement side
 * ends up pending or applied. Once issued, the paired Requisition (if any
 * was selected) is marked finished with exactly the asset ids issued.
 *
 * "Select Asset" (beside "+ Add row") opens a checkbox picker scoped to
 * whichever Requisition is currently chosen — only Gadgets whose category
 * appears in that request's own item list, and only ones currently
 * sitting at a default stock room (see _computeAvailableByCategory's own
 * doc comment in RequisitionController.js for that exact "available"
 * definition), are offered; anything already added as a row is excluded
 * too. It's the same idea as _computeAvailableByCategory's own available-
 * count hint, just turned into something you can actually pick from
 * rather than a number to go find manually in the Manage grid.
 *
 * "+ Add row" / "Select Asset" and the warehouse picker/placement preview
 * live in the modal's sticky footer (passed to Modal as `footerExtra`,
 * same relocation as ManifestModal.js) rather than below the detail
 * table, so they stay reachable without scrolling a long request.
 */

/** Column order/labels for the detail table — identical set to
 * ManifestModal's own COLUMNS, so the print stylesheet's per-column width
 * rules (css/modal.css's body.printing-manifest nth-child rules) still
 * line up correctly for this document too. */
const COLUMNS = [
  { key: 'user', label: 'User' },
  { key: 'role', label: 'Role' },
  { key: 'category', label: 'Gadget Type' },
  { key: 'serialNumber', label: 'Serial Number' },
  { key: 'warehouseAssetTag', label: 'Warehouse Asset Tag' },
  { key: 'assetTagDefault', label: 'Asset Tag' },
  { key: 'macAddress', label: 'MAC Address' },
  { key: 'password', label: 'Password' },
  { key: 'merchant', label: 'Merchant' },
  { key: 'description', label: 'Description' },
  { key: 'recentResponsible', label: 'Recent Responsible' }
];

function rowFromGadget(g) {
  return {
    rowId: g.id,
    user: g.user || '',
    role: g.role || '',
    category: g.category || '',
    serialNumber: g.serialNumber || '',
    warehouseAssetTag: g.warehouseAssetTag || '',
    assetTagDefault: g.assetTagDefault || '',
    macAddress: g.macAddress || '',
    password: g.password || '',
    merchant: g.merchant || '',
    description: g.description || '',
    recentResponsible: typeof g.getLastResponsible === 'function' ? g.getLastResponsible() : ''
  };
}

function blankRow() {
  const row = { rowId: generateId('prow') };
  COLUMNS.forEach((c) => { row[c.key] = ''; });
  return row;
}

function rowHTML(row) {
  const cells = COLUMNS.map((c) =>
    `<td><input type="text" data-field="${c.key}" value="${esc(row[c.key])}" placeholder="—"></td>`
  ).join('');
  return `
    <tr data-row-id="${esc(row.rowId)}">
      ${cells}
      <td class="manifest-row-remove no-print">
        <button tabindex="-1" type="button" class="icon-btn danger" data-action="remove-pr-row" title="Remove row" aria-label="Remove row">✕</button>
      </td>
    </tr>`;
}

/** Meta fields that must all be filled in before Issue / Print is allowed. */
const REQUIRED_META_KEYS = ['requisitionId', 'preparedBy', 'issuedTo', 'transferTo', 'date'];

/**
 * @param {object} opts
 * @param {object[]} opts.gadgets - selected gadgets (checked rows in Manage) to pre-fill as rows.
 * @param {object[]} [opts.requisitions] - every Requisition, used to populate the picker (pending ones only are offered).
 * @param {import('../core/Store.js').Store} [opts.gadgetStore] - the Manage store these gadgets came from. Without it, Issue / Print still prints, it just can't persist anything.
 * @param {import('../core/Store.js').Store} [opts.requisitionStore] - the Requisition store; the paired request is marked finished here once issued.
 * @param {import('../core/Store.js').Store} [opts.locationStore] - created warehouse locations, for "Transfer to"'s suggestions and live placement preview — same role as in ManifestModal.
 * @param {import('../core/Store.js').Store} [opts.warehouseStore] - warehouse sites, paired with locationStore to resolve a location's owning warehouse for that same preview.
 * @param {string} [opts.defaultPreparedBy] - pre-fills the Prepared by field.
 */
export function openProcessRequestModal({ gadgets = [], requisitions = [], gadgetStore = null, requisitionStore = null, locationStore = null, warehouseStore = null, defaultPreparedBy = '' } = {}) {
  const initialRows = gadgets.length ? gadgets.map(rowFromGadget) : [blankRow()];
  const pendingRequisitions = requisitions.filter((r) => r.status !== 'finished');
  let issueBtn = null;

  const body = el(`
    <div class="manifest-doc">
      <div style="display: grid; grid-template-columns: auto 1fr; gap: 20px; margin-bottom: 8px;">
        <table class="manifest-summary-table">
          <thead><tr><th>Category</th><th>Total</th></tr></thead>
          <tbody data-role="pr-summary-body"></tbody>
        </table>

        <div>
          <div class="manifest-summary-head">
            <div class="manifest-title">REQUEST TRANSMITAL DETAILS</div>
          </div>

          <div class="manifest-meta-grid">
            <div class="manifest-meta-row">
              <label><span class="required-mark">*</span>Prepared by</label>
              <input type="text" data-meta="preparedBy" placeholder="Name of preparer">
            </div>
            <div class="manifest-meta-row">
              <label><span class="required-mark">*</span>Issued to</label>
              <input type="text" data-meta="issuedTo" placeholder="Name of requester">
            </div>
            <div class="manifest-meta-row">
              <label><span class="required-mark">*</span>Requisition</label>
              <select data-meta="requisitionId">
                <option value="" disabled selected>${pendingRequisitions.length ? 'Select a pending request…' : 'No pending requests'}</option>
                ${pendingRequisitions.map((r) => `<option value="${esc(r.id)}">${esc(r.requesterName || 'Unnamed requester')} — ${esc(r.items.map((i) => `${i.category} × ${i.qty}`).join(', ') || 'No items')}</option>`).join('')}
              </select>
            </div>
            <div class="manifest-meta-row">
              <label><span class="required-mark">*</span>Transfer to</label>
              <input type="text" data-meta="transferTo" list="processRequestMerchantOptions" placeholder="Merchant">
              <datalist id="processRequestMerchantOptions"></datalist>
            </div>
            <div class="manifest-meta-row manifest-meta-row--signature">
              <label>Signature</label>
              <div class="manifest-signature-line no-print"></div>
            </div>
            <div class="manifest-meta-row">
              <label><span class="required-mark">*</span>Date</label>
              <input type="text" data-meta="date" placeholder="e.g. Tue, Jul 14, 2026">
            </div>
          </div>
        </div>
      </div>

      <div class="manifest-table-wrap">
      <table class="manifest-detail-table">
      <thead>
      <tr>
      ${COLUMNS.map((c) => `<th>${esc(c.label)}</th>`).join('')}
      <th class="no-print"></th>
      </tr>
      </thead>
      <tbody data-role="pr-body"></tbody>
      </table>
      </div>
    </div>
  `);

  // Rendered separately from `body` and handed to Modal as `footerExtra`
  // (see Modal.js / ManifestModal.js's own copy of this) so it lands in
  // the sticky footer instead of scrolling away with the row table above.
  const footerExtra = el(`
    <div class="manifest-below-table-row">
      <div style="display: flex; align-items: center; gap: 8px;">
        <button tabindex="-1" type="button" class="btn btn-outline btn-sm no-print" data-action="add-pr-row">+ Add row</button>
        <button tabindex="-1" type="button" class="btn btn-outline btn-sm no-print" data-action="select-asset">Select Asset</button>
      </div>
      <div class="manifest-below-table-right no-print">
        <div class="manifest-warehouse-pick no-print" data-role="pr-warehouse-pick" hidden>
          <label for="processRequestWarehousePick">Select warehouse</label>
          <select id="processRequestWarehousePick" data-role="pr-warehouse-select"></select>
        </div>
        <div class="placement-preview placement-preview-block no-print" data-role="pr-placement-preview"></div>
      </div>
    </div>
  `);

  const tbody = body.querySelector('[data-role="pr-body"]');
  const summaryBody = body.querySelector('[data-role="pr-summary-body"]');

  body.querySelector('[data-meta="preparedBy"]').value = defaultPreparedBy || getOperatorName();
  body.querySelector('[data-meta="date"]').value = fmtManifestDate();

  // Picking a pending request fills in who it's for straight from the
  // submission — stays editable afterward, same as every other
  // pre-filled field on this document.
  const requisitionSelect = body.querySelector('[data-meta="requisitionId"]');
  const issuedToInput = body.querySelector('[data-meta="issuedTo"]');
  enhanceSelect(requisitionSelect);
  requisitionSelect.addEventListener('change', () => {
    const requisition = pendingRequisitions.find((r) => r.id === requisitionSelect.value);
    if (requisition) issuedToInput.value = requisition.requesterName || '';
    updateIssueButtonState();
    updateSelectAssetButtonState();
  });

  // "Transfer to" is the same merchant/location key as Manifest's own
  // field (ported wholesale from ManifestModal.js) — suggest the
  // location names actually created under Warehouse Information, and
  // show what each one resolves to before anything is even printed.
  const transferToInput = body.querySelector('[data-meta="transferTo"]');
  const placementPreviewEl = footerExtra.querySelector('[data-role="pr-placement-preview"]');
  if (locationStore) {
    const locationCodes = [...new Set(locationStore.list().filter((l) => l.enabled).map((l) => l.locationCode).filter(Boolean))].sort();
    body.querySelector('#processRequestMerchantOptions').innerHTML =
      locationCodes.map((code) => `<option value="${esc(code)}">`).join('');
  }

  // A location's name is only unique *within* its own warehouse site —
  // see utils/merchantPlacement.js's findMatchingLocations doc comment.
  // When "Transfer to" matches more than one site's location, this picker
  // appears to ask which one is meant; stays hidden otherwise.
  let selectedWarehouseId = '';
  const warehousePickWrap = footerExtra.querySelector('[data-role="pr-warehouse-pick"]');
  const warehousePickSelect = footerExtra.querySelector('[data-role="pr-warehouse-select"]');
  const warehousePickField = enhanceSelect(warehousePickSelect);

  function showWarehousePick(candidates) {
    const stillValid = selectedWarehouseId && candidates.some((c) => c.warehouseSite.id === selectedWarehouseId);
    if (!stillValid) selectedWarehouseId = '';
    warehousePickSelect.innerHTML =
      `<option value="" disabled ${selectedWarehouseId ? '' : 'selected'}>Select warehouse…</option>` +
      candidates
        .map((c) => `<option value="${esc(c.warehouseSite.id)}"${c.warehouseSite.id === selectedWarehouseId ? ' selected' : ''}>${esc(c.warehouseSite.name)}</option>`)
        .join('');
    warehousePickField.sync();
    warehousePickWrap.hidden = false;
  }

  function hideWarehousePick() {
    warehousePickWrap.hidden = true;
    warehousePickSelect.innerHTML = '';
    warehousePickField.sync();
    selectedWarehouseId = '';
  }

  /** True unless "Transfer to" is a location name that exists under more
   * than one warehouse site and no site has been picked yet. */
  function isWarehouseSelectionResolved() {
    const value = transferToInput.value.trim();
    if (!value || !locationStore || !warehouseStore) return true;
    const candidates = findMatchingLocations(value, { locationStore, warehouseStore });
    if (candidates.length <= 1) return true;
    return Boolean(selectedWarehouseId) && candidates.some((c) => c.warehouseSite.id === selectedWarehouseId);
  }

  function updatePlacementPreview() {
    const value = transferToInput.value.trim();
    placementPreviewEl.classList.remove('placement-preview-matched', 'placement-preview-unmatched');
    if (!value || !locationStore || !warehouseStore) {
      placementPreviewEl.textContent = '';
      hideWarehousePick();
      updateIssueButtonState();
      return;
    }

    const candidates = findMatchingLocations(value, { locationStore, warehouseStore });

    if (candidates.length > 1) {
      showWarehousePick(candidates);
      if (selectedWarehouseId) {
        const placement = resolveMerchantPlacement(value, { locationStore, warehouseStore, warehouseId: selectedWarehouseId });
        placementPreviewEl.textContent = `→ Position Type: ${placement.positionType} · Warehouse: ${placement.warehouse} · Owner: ${placement.owner}`;
        placementPreviewEl.classList.add('placement-preview-matched');
      } else {
        placementPreviewEl.textContent = `"${value}" exists in ${candidates.length} warehouses — select which one above to continue.`;
        placementPreviewEl.classList.add('placement-preview-unmatched');
      }
    } else {
      hideWarehousePick();
      const placement = resolveMerchantPlacement(value, { locationStore, warehouseStore });
      if (placement.matched) {
        placementPreviewEl.textContent = `→ Position Type: ${placement.positionType} · Warehouse: ${placement.warehouse} · Owner: ${placement.owner}`;
        placementPreviewEl.classList.add('placement-preview-matched');
      } else {
        placementPreviewEl.textContent = 'No warehouse location named this yet — pick one from the list, or clear "Transfer to".';
        placementPreviewEl.classList.add('placement-preview-unmatched');
      }
    }
    updateIssueButtonState();
  }
  transferToInput.addEventListener('input', updatePlacementPreview);
  warehousePickSelect.addEventListener('change', () => {
    selectedWarehouseId = warehousePickSelect.value;
    updatePlacementPreview();
  });

  function isMetaComplete() {
    return REQUIRED_META_KEYS.every((key) => body.querySelector(`[data-meta="${key}"]`).value.trim() !== '');
  }

  function updateIssueButtonState() {
    if (!issueBtn) return;
    const metaComplete = isMetaComplete();
    const ready = metaComplete && isWarehouseSelectionResolved();
    issueBtn.disabled = !ready;
    issueBtn.title = !metaComplete
      ? 'Select a requisition, then fill in Prepared by, Issued to, Transfer to, and Date first.'
      : (ready ? '' : 'Select which warehouse to transfer to first.');
  }

  REQUIRED_META_KEYS.forEach((key) => {
    body.querySelector(`[data-meta="${key}"]`).addEventListener('input', updateIssueButtonState);
  });

  function renderRows(rows) {
    tbody.innerHTML = rows.map(rowHTML).join('');
    bindRowEvents();
    recomputeSummary();
  }

  function recomputeSummary() {
    const counts = new Map();
    qsa('input[data-field="category"]', tbody).forEach((input) => {
      const key = input.value.trim() || 'Unspecified';
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const entries = [...counts.entries()];
    const grandTotal = entries.reduce((sum, [, count]) => sum + count, 0);
    const rowsHTML = entries.map(([type, count]) =>
      `<tr><td>${esc(type)}</td><td>${count}</td></tr>`
    ).join('') || '<tr><td colspan="2" style="color:var(--ink-faint);">No rows yet</td></tr>';
    summaryBody.innerHTML = rowsHTML + `<tr class="manifest-summary-grand"><td>Grand Total</td><td>${grandTotal}</td></tr>`;
  }

  function bindRowEvents() {
    qsa('tr[data-row-id]', tbody).forEach((tr) => {
      const removeBtn = tr.querySelector('[data-action="remove-pr-row"]');
      removeBtn.addEventListener('click', () => {
        tr.remove();
        recomputeSummary();
      });
      const categoryInput = tr.querySelector('input[data-field="category"]');
      categoryInput.addEventListener('input', () => recomputeSummary());
    });
  }

  renderRows(initialRows);

  footerExtra.querySelector('[data-action="add-pr-row"]').addEventListener('click', () => {
    tbody.insertAdjacentHTML('beforeend', rowHTML(blankRow()));
    bindRowEvents();
    recomputeSummary();
    const lastInput = tbody.querySelector('tr:last-child input');
    lastInput?.focus();
  });

  // ---------- Select Asset ----------
  // Lets a person pick straight from what's actually sitting in stock
  // instead of typing (or hand-copying) every field — same underlying
  // Gadget records the Manage grid itself lists, filtered down to just
  // what this request could plausibly be fulfilled with.
  const selectAssetBtn = footerExtra.querySelector('[data-action="select-asset"]');

  /** Category → requested qty for whichever Requisition is currently
   * picked, or null if none is picked yet — the picker has nothing to
   * filter against without one. */
  function requestedCategoryQtys() {
    const requisition = pendingRequisitions.find((r) => r.id === requisitionSelect.value);
    if (!requisition) return null;
    const map = new Map();
    requisition.items.forEach((item) => {
      const category = item.category || 'Uncategorized';
      map.set(category, (map.get(category) || 0) + (item.qty || 0));
    });
    return map;
  }

  /** Same "available" definition RequisitionController itself uses
   * (_computeAvailableByCategory's own doc comment): a gadget "sits at" a
   * WarehouseLocation flagged isDefaultStockRoom when its `merchant`
   * matches that location's `locationCode`. */
  function defaultStockRoomCodes() {
    if (!locationStore) return new Set();
    return new Set(locationStore.list().filter((l) => l.isDefaultStockRoom && l.locationCode).map((l) => l.locationCode));
  }

  function updateSelectAssetButtonState() {
    const ready = Boolean(requestedCategoryQtys());
    selectAssetBtn.disabled = !ready;
    selectAssetBtn.title = ready ? '' : 'Select a requisition first.';
  }

  function openAssetPicker() {
    const categoryQtys = requestedCategoryQtys();
    if (!categoryQtys || !gadgetStore) return;
    const requestedCategories = new Set(categoryQtys.keys());
    const stockCodes = defaultStockRoomCodes();
    const alreadyRowIds = new Set(qsa('tr[data-row-id]', tbody).map((tr) => tr.getAttribute('data-row-id')));

    const eligible = gadgetStore.list().filter((g) =>
      requestedCategories.has(g.category || 'Uncategorized') &&
      stockCodes.has(g.merchant) &&
      !alreadyRowIds.has(g.id)
    );

    const pickerBody = el(`
      <div>
        <div style="margin-bottom: 10px; color: var(--ink-faint); font-size: 13px;">
          Requested: ${[...categoryQtys.entries()].map(([cat, qty]) => `${esc(cat)} × ${qty}`).join(', ')}
        </div>
        ${eligible.length > 0 ? '<input type="text" class="asset-picker-search" data-role="asset-picker-search" placeholder="Search by category, serial, asset tag, or merchant…">' : ''}
        <div class="asset-picker-list" data-role="asset-picker-list"></div>
        <div class="asset-picker-empty" data-role="asset-picker-no-matches" hidden>No assets match your search.</div>
      </div>
    `);
    const listEl = pickerBody.querySelector('[data-role="asset-picker-list"]');

    if (eligible.length === 0) {
      listEl.innerHTML = `<div style="color: var(--ink-faint); padding: 12px 0;">No available ${[...requestedCategories].join(' / ')} currently in stock.</div>`;
    } else {
      listEl.innerHTML = eligible.map((g) => {
        const category = g.category || 'Uncategorized';
        const searchText = [category, g.serialNumber, g.assetTagDefault, g.merchant].filter(Boolean).join(' ').toLowerCase();
        return `
        <label class="asset-picker-row" data-picker-search="${esc(searchText)}">
          <input type="checkbox" data-picker-id="${esc(g.id)}" data-picker-category="${esc(category)}">
          <span class="asset-picker-category">${esc(category)}</span>
          <span class="asset-picker-serial">${esc(g.serialNumber || '—')}</span>
          <span class="asset-picker-mac">${esc(g.assetTagDefault || '—')}</span>
          <span class="asset-picker-merchant">${esc(g.merchant || '—')}</span>
        </label>`;
      }).join('');
    }

    // Live text filter across category / serial / asset tag / merchant —
    // rows are hidden rather than removed, so checked/disabled state
    // (including updatePickerLimits' own caps below) survives typing.
    const searchInput = pickerBody.querySelector('[data-role="asset-picker-search"]');
    const noMatchesEl = pickerBody.querySelector('[data-role="asset-picker-no-matches"]');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();
        let visibleCount = 0;
        qsa('.asset-picker-row', listEl).forEach((row) => {
          const matches = !query || row.getAttribute('data-picker-search').includes(query);
          row.hidden = !matches;
          if (matches) visibleCount++;
        });
        noMatchesEl.hidden = visibleCount > 0;
      });
    }

    // Once a category's checked count reaches what was actually
    // requested, the rest of that category's still-unchecked rows are
    // disabled — same spirit as "only give what category are requested
    // to match the request" (the earlier category filter), just applied
    // to quantity instead: you can select up to the requested amount of
    // Kaicom, not more, without that cap also blocking Laptop/Keyboard/
    // whatever else the request called for. Unchecking one frees up its
    // spot for another of the same category again.
    const pickerCheckboxes = qsa('input[data-picker-id]', listEl);
    function updatePickerLimits() {
      const checkedCountByCategory = new Map();
      pickerCheckboxes.forEach((cb) => {
        if (!cb.checked) return;
        const category = cb.getAttribute('data-picker-category');
        checkedCountByCategory.set(category, (checkedCountByCategory.get(category) || 0) + 1);
      });
      pickerCheckboxes.forEach((cb) => {
        if (cb.checked) {
          cb.disabled = false;
          cb.closest('.asset-picker-row')?.classList.remove('asset-picker-row--disabled');
          return;
        }
        const category = cb.getAttribute('data-picker-category');
        const atCap = (checkedCountByCategory.get(category) || 0) >= (categoryQtys.get(category) || 0);
        cb.disabled = atCap;
        cb.closest('.asset-picker-row')?.classList.toggle('asset-picker-row--disabled', atCap);
      });
    }
    pickerCheckboxes.forEach((cb) => cb.addEventListener('change', updatePickerLimits));
    updatePickerLimits();

    const picker = new Modal({
      title: 'Select Asset',
      body: pickerBody,
      size: 'md',
      footer: [
        { label: 'Cancel', variant: 'btn-outline', onClick: (m) => m.close() },
        {
          label: 'Add selected',
          variant: 'btn-accent',
          onClick: (m) => {
            const checked = qsa('input[data-picker-id]:checked', pickerBody).map((cb) => cb.getAttribute('data-picker-id'));
            if (checked.length === 0) { m.close(); return; }
            checked.forEach((id) => {
              const gadget = gadgetStore.get(id);
              if (!gadget) return;
              tbody.insertAdjacentHTML('beforeend', rowHTML(rowFromGadget(gadget)));
            });
            bindRowEvents();
            recomputeSummary();
            m.close();
          }
        }
      ]
    });
    picker.open();
  }

  selectAssetBtn.addEventListener('click', () => openAssetPicker());
  updateSelectAssetButtonState();

  function addLandscapePage() {
    removeLandscapePage();
    const style = document.createElement('style');
    style.id = 'processRequestLandscapePage';
    style.textContent = '@page{ size: landscape; margin: 12mm; }';
    document.head.appendChild(style);
  }

  function removeLandscapePage() {
    document.getElementById('processRequestLandscapePage')?.remove();
  }

  /**
   * Issues every row on the document — both rows that map back to a real
   * Gadget and hand-typed ones that don't (e.g. a consumable like a power
   * cable that isn't tracked as its own serialized asset in Manage). Only
   * a matched row's underlying Gadget record actually gets mutated
   * (there's nothing in Manage to write for a hand-typed one), but *every*
   * row — matched or not — is recorded in `fulfilledItems` so "Actually
   * Served" (RequisitionController._openFulfillmentLog) reflects the
   * whole document, not just the subset that happened to have a matching
   * asset id. `user` is always written immediately for a matched row —
   * the requester already has the unit in hand, nothing to confirm there.
   *
   * The merchant/placement side follows Manifest's own pending-vs-
   * immediate split exactly: a "Transfer to" that resolves to a real
   * active location queues a Gadget.pendingTransfer (positionType/
   * warehouse/owner stay as they were until someone bound to that
   * destination warehouse confirms receipt from the Manage grid); an
   * unmatched value — unreachable through Issue / Print's own validation
   * below, same as Manifest — would apply the merchant immediately. A
   * hand-typed row has no Gadget to place, so this only ever applies to
   * matched rows.
   *
   * Once issued, the paired Requisition is marked finished with exactly
   * the rows issued here — that happens now, at issuance, not deferred to
   * whenever the pending transfer eventually gets confirmed: the request
   * is fulfilled the moment the unit leaves stock for the requester,
   * regardless of how long its warehouse placement takes to settle.
   */
  function applyProcessing() {
    if (!gadgetStore) return;
    const requisitionId = requisitionSelect.value;
    const issuedTo = issuedToInput.value.trim();
    const transferTo = transferToInput.value.trim();
    if (!issuedTo || !transferTo) return;

    const placement = (locationStore && warehouseStore)
      ? resolveMerchantPlacement(transferTo, { locationStore, warehouseStore, warehouseId: selectedWarehouseId })
      : { matched: false };
    const placementPatch = placement.matched
      ? { positionType: placement.positionType, warehouse: placement.warehouse, owner: placement.owner }
      : {};
    const placementNote = placement.matched
      ? ` Resolved to ${placement.positionType} · ${placement.warehouse} · ${placement.owner}.`
      : '';
    const requestedAt = Date.now();
    const requestedBy = getOperatorName();

    const issuedIds = [];
    const fulfilledItems = [];
    let pendingCount = 0;

    qsa('tr[data-row-id]', tbody).forEach((tr) => {
      const rowId = tr.getAttribute('data-row-id');
      const gadget = gadgetStore.get(rowId);

      // Snapshot every column straight from the row's own inputs first —
      // this is the only source of truth for a hand-typed row (no
      // matching id below), and it's what "Actually Served" falls back
      // to for a matched row too, if that asset is ever deleted later.
      const snapshot = {};
      COLUMNS.forEach((c) => {
        if (c.key === 'recentResponsible') return; // derived/display-only, not worth freezing
        const input = tr.querySelector(`input[data-field="${c.key}"]`);
        snapshot[c.key] = input ? input.value.trim() : '';
      });

      if (gadget) {
        // 'None' rather than '' so the log message this feeds into
        // (below) reads as "merchant 'None' → 'X'" instead of "merchant
        // '' → 'X'" — same fallback ManifestModal.js's own
        // applyMerchantTransfer already uses, for the same reason: an
        // empty pair of quotes in a permanent history entry reads as a
        // rendering glitch, not "this gadget didn't have a merchant yet."
        const previousMerchant = gadget.merchant || 'None';

        if (placement.matched) {
          gadget.addLogEntry(
            `Issued via requisition to ${issuedTo}. Transfer requested: merchant '${previousMerchant}' → '${transferTo}'.${placementNote} Awaiting confirmation from anyone with access to ${placement.owner}.`,
            'transfer',
            { from: previousMerchant, to: transferTo },
            requestedBy
          );
          gadgetStore.update(gadget.id, {
            user: issuedTo,
            pendingTransfer: {
              toMerchant: transferTo,
              toPositionType: placement.positionType,
              toWarehouse: placement.warehouse,
              toOwner: placement.owner,
              toWarehouseId: destinationWarehouseId(placement),
              requestedAt,
              requestedBy
            }
          });
          pendingCount++;
          // Same as ManifestModal: the row keeps showing the *current*
          // merchant — the transfer hasn't actually happened yet.
        } else {
          gadget.addLogEntry(
            `Issued via requisition to ${issuedTo}. Merchant transferred from '${previousMerchant}' to '${transferTo}'.${placementNote}`,
            'transfer',
            { from: previousMerchant, to: transferTo },
            requestedBy
          );
          gadgetStore.update(gadget.id, { user: issuedTo, merchant: transferTo, pendingTransfer: null, ...placementPatch });

          snapshot.merchant = transferTo;
          const merchantInput = tr.querySelector('input[data-field="merchant"]');
          if (merchantInput) merchantInput.value = transferTo;
        }

        issuedIds.push(gadget.id);
      }
      // A hand-typed row (no `gadget`) has nothing in Manage to mutate —
      // there's no asset record to reassign a user/merchant onto — but
      // it was still printed and handed over, so it still counts as
      // issued below.

      snapshot.user = issuedTo;
      const userInput = tr.querySelector('input[data-field="user"]');
      if (userInput) userInput.value = issuedTo;

      fulfilledItems.push({ gadgetId: gadget ? gadget.id : null, ...snapshot });
    });

    if (fulfilledItems.length === 0) {
      Toast.error('Add at least one row before issuing.');
      return;
    }

    if (requisitionStore && requisitionId) {
      requisitionStore.update(requisitionId, { status: 'finished', fulfilledGadgetIds: issuedIds, fulfilledItems });
    }

    if (pendingCount > 0) {
      Toast.success(`Issued to ${issuedTo} — ${fulfilledItems.length} item${fulfilledItems.length === 1 ? '' : 's'}. Transfer to "${transferTo}" is awaiting confirmation from anyone with access to ${placement.owner}.`);
    } else {
      const suffix = placement.matched ? ` (${placement.positionType} · ${placement.warehouse} · ${placement.owner})` : '';
      Toast.success(`Processed the request for ${issuedTo} — ${fulfilledItems.length} item${fulfilledItems.length === 1 ? '' : 's'} issued, transferred to "${transferTo}"${suffix}.`);
    }
  }

  const modal = new Modal({
    title: 'Process Request',
    body,
    size: 'lg',
    footerExtra,
    footer: [
      { label: 'Close', variant: 'btn-outline', onClick: (m) => m.close() },
      {
        label: 'Issue / Print',
        variant: 'btn-accent',
        onClick: () => {
          if (!isMetaComplete()) return; // belt-and-suspenders — the button is disabled anyway
          // Same rule as Manifest: "Transfer to" must be an exact match
          // to a currently *enabled* Warehouse location — never
          // arbitrary typed text.
          const transferTo = transferToInput.value.trim();
          if (locationStore && warehouseStore) {
            if (!isWarehouseSelectionResolved()) {
              Toast.error(`"${transferTo}" exists in more than one warehouse — select which one before issuing.`);
              return;
            }
            if (!resolveMerchantPlacement(transferTo, { locationStore, warehouseStore, warehouseId: selectedWarehouseId }).matched) {
              Toast.error(`"${transferTo}" isn't a currently active merchant — pick one from the list.`);
              return;
            }
          }
          addLandscapePage();
          document.body.classList.add('printing-manifest');
          window.addEventListener('afterprint', async () => {
            document.body.classList.remove('printing-manifest');
            removeLandscapePage();

            const confirmed = await confirmDialog({
              title: 'Confirm issuance',
              message: `Did the request finish printing or saving? Confirming will issue the assets above to ${esc(issuedToInput.value.trim() || 'the requester')}, request their transfer to "${esc(transferToInput.value.trim())}", and mark the requisition finished.`,
              confirmLabel: 'Yes, issue',
              cancelLabel: 'No, skip'
            });
            if (confirmed) applyProcessing();
          }, { once: true });
          window.print();
        }
      }
    ],
    onClose: () => { removeLandscapePage(); }
  });

  issueBtn = modal.footEl.querySelector('.btn-accent');
  updateIssueButtonState();

  modal.open();
  return modal;
}
