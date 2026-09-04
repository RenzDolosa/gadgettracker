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
 * ManifestModal renders a printable "Manifest / Transmittal" document for
 * a set of gadgets — a transfer/hand-over slip pairing each asset with the
 * user it's issued to, plus a header block (prepared by / department / date
 * / received by / transfer to / signature) and a Gadget Type vs. Total
 * summary.
 *
 * It's mostly a *preview* document: rows are pre-filled from the selected
 * gadgets but every cell stays editable (so a typo can be fixed before
 * printing without having to go edit the underlying asset), and the user
 * can add fully blank rows by hand for items not yet in the system. The
 * one thing it does write back is the merchant transfer: clicking
 * Transfer / Print (only enabled once Prepared by/Department/Received by/
 * Transfer to/Date are all filled in) opens the print dialog, and once
 * that closes, asks the user to confirm the print/save actually went
 * through before applying the transfer for every real asset via
 * applyMerchantTransfer() — which either updates `merchant` right away, or,
 * if "Transfer to" resolves to a real created location, queues a
 * Gadget.pendingTransfer for whoever's User Group is bound to that
 * destination warehouse to confirm instead (see that function's own doc
 * comment). That confirmation step here (print vs. pending) exists
 * because browsers give no way to tell "printed" apart from "hit
 * Cancel" — pass no `store` and this whole step is skipped, printing
 * still works.
 *
 * "Transfer to" doubles as the merchant/location key: when `locationStore`
 * and `warehouseStore` are supplied, the field suggests the location names
 * actually created under Settings → Warehouse Information (e.g. "Samples",
 * "Test Location") and shows a live preview of the Position Type /
 * Warehouse / Owner that name resolves to — the same resolution
 * applyMerchantTransfer() writes back to each asset once the transfer is
 * confirmed. Without those two stores the field behaves exactly as
 * before: a plain free-text merchant name.
 *
 * "+ Add row" and the warehouse picker/placement preview live in the
 * modal's sticky footer (passed to Modal as `footerExtra`), not below the
 * detail table — a manifest can run to hundreds of rows (see the
 * screenshot that prompted this: 1,072 checked assets), and burying the
 * only way to add a row or resolve an ambiguous "Transfer to" at the
 * bottom of that scroll meant the user had to scroll all the way down
 * just to reach them. The footer is always in view regardless of scroll
 * position or row count.
 */

/** Column order/labels for the manifest detail table, matching the printed transmittal layout. */
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
    // The user who held this asset immediately before the current one,
    // derived from its reassignment history rather than the free-text
    // remarks field — blank if it's never changed hands between users.
    recentResponsible: typeof g.getLastResponsible === 'function' ? g.getLastResponsible() : ''
  };
}

function blankRow() {
  const row = { rowId: generateId('mrow') };
  COLUMNS.forEach((c) => { row[c.key] = ''; });
  return row;
}

/** Minimum number of visible rows on the printed sheet — short manifests get
 * blank filler rows appended (print-only) so the page reads as a full ledger
 * with room to write, instead of a sparse table hugging the top of the page. */
const PRINT_MIN_ROWS = 0;

/** A wholly blank, print-only row: no data-field attributes (so it's
 * naturally excluded from the Gadget Type summary tally) and not editable. */
function padRowHTML() {
  const cells = COLUMNS.map(() => `<td><input type="text" tabindex="-1" readonly></td>`).join('');
  return `<tr class="manifest-pad-row">${cells}<td class="manifest-row-remove no-print"></td></tr>`;
}

function rowHTML(row) {
  const cells = COLUMNS.map((c) =>
    `<td><input type="text" data-field="${c.key}" value="${esc(row[c.key])}" placeholder="—"></td>`
  ).join('');
  return `
    <tr data-row-id="${esc(row.rowId)}">
      ${cells}
      <td class="manifest-row-remove no-print">
        <button tabindex="-1" type="button" class="icon-btn danger" data-action="remove-manifest-row" title="Remove row" aria-label="Remove row">✕</button>
      </td>
    </tr>`;
}

/** Meta fields that must all be filled in before Transfer / Print is allowed. */
const REQUIRED_META_KEYS = ['preparedBy', 'department', 'receivedBy', 'merchant', 'date'];

/**
 * @param {object} opts
 * @param {object[]} opts.gadgets - selected gadgets to pre-fill as manifest rows.
 * @param {import('../core/Store.js').Store} [opts.store] - the Manage store these
 *        gadgets came from. Without it, Transfer / Print still prints, it just can't
 *        persist the merchant change or log it to history.
 * @param {import('../core/Store.js').Store} [opts.locationStore] - created warehouse
 *        locations, for the "Transfer to" field's suggestions and live placement preview.
 * @param {import('../core/Store.js').Store} [opts.warehouseStore] - warehouse sites, paired
 *        with locationStore to resolve a location's owning warehouse for that same preview.
 * @param {string} [opts.defaultPreparedBy] - pre-fills the Prepared by field.
 * @param {string} [opts.defaultDepartment] - pre-fills the Department field.
 */
export function openManifestModal({ gadgets = [], store = null, locationStore = null, warehouseStore = null, defaultPreparedBy = '', defaultDepartment = '' } = {}) {
  const initialRows = gadgets.length ? gadgets.map(rowFromGadget) : [blankRow()];
  let transferBtn = null;

  const body = el(`
    <div class="manifest-doc">
      

      <div style="display: grid; grid-template-columns: auto 1fr; gap: 20px; margin-bottom: 8px;">
        <table class="manifest-summary-table">
          <thead><tr><th>Category</th><th>Total</th></tr></thead>
          <tbody data-role="manifest-summary-body"></tbody>
        </table>

        <div>
          <div class="manifest-summary-head">
            <div class="manifest-title">MANIFEST DETAILS</div>
          </div>

          <div class="manifest-meta-grid">
            <div class="manifest-meta-row">
              <label><span class="required-mark">*</span>Prepared by</label>
              <input type="text" data-meta="preparedBy" placeholder="Name of preparer">
            </div>
            <div class="manifest-meta-row">
              <label><span class="required-mark">*</span>Received by</label>
              <input type="text" data-meta="receivedBy" placeholder="Name of receiver">
            </div>
            <div class="manifest-meta-row">
              <label><span class="required-mark">*</span>Department</label>
              <input type="text" data-meta="department" placeholder="Department / team">
            </div>
            <div class="manifest-meta-row">
              <label><span class="required-mark">*</span>Transfer to</label>
              <input type="text" data-meta="merchant" list="manifestMerchantOptions" placeholder="Merchant">
              <datalist id="manifestMerchantOptions"></datalist>
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
            <tbody data-role="manifest-body"></tbody>
        </table>
        </div>
    </div>
  `);

  // Rendered separately from `body` and handed to Modal as `footerExtra`
  // (see Modal.js) so it lands in the sticky footer instead of scrolling
  // away with the (potentially very long) row table above.
  const footerExtra = el(`
    <div class="manifest-below-table-row">
      <button tabindex="-1" type="button" class="btn btn-outline btn-sm no-print" data-action="add-manifest-row">+ Add row</button>
      <div class="manifest-below-table-right no-print">
        <div class="manifest-warehouse-pick no-print" data-role="manifest-warehouse-pick" hidden>
          <label for="manifestWarehousePick">Select warehouse</label>
          <select id="manifestWarehousePick" data-role="manifest-warehouse-select"></select>
        </div>
        <div class="placement-preview placement-preview-block no-print" data-role="manifest-placement-preview"></div>
      </div>
    </div>
  `);

  const tbody = body.querySelector('[data-role="manifest-body"]');
  const summaryBody = body.querySelector('[data-role="manifest-summary-body"]');

  // "Prepared by" defaults to whoever's executing this manifest (the
  // operator name set in Settings → General, itself defaulted from the
  // signed-in username — see AuthController) unless a caller passed an
  // explicit override. "Received by" names the actual recipient of the
  // hand-over, which nothing in the app knows in advance, so it's left
  // blank for manual entry rather than reusing the preparer's name.
  body.querySelector('[data-meta="preparedBy"]').value = defaultPreparedBy || getOperatorName();
  body.querySelector('[data-meta="department"]').value = defaultDepartment;
  body.querySelector('[data-meta="date"]').value = fmtManifestDate();

  // "Transfer to" doubles as the merchant/location key (Task 1): suggest
  // the location names actually created under Warehouse Information, and
  // show what each one resolves to before the transfer is even confirmed.
  const merchantMetaInput = body.querySelector('[data-meta="merchant"]');
  const merchantPreviewEl = footerExtra.querySelector('[data-role="manifest-placement-preview"]');
  if (locationStore) {
    const locationCodes = [...new Set(locationStore.list().filter((l) => l.enabled).map((l) => l.locationCode).filter(Boolean))].sort();
    body.querySelector('#manifestMerchantOptions').innerHTML =
      locationCodes.map((code) => `<option value="${esc(code)}">`).join('');
  }

  // A location's name is only unique *within* its own warehouse site — the
  // same "Zeneya" can exist under Krus4k, Krus5k, and Krus3k at once (see
  // findMatchingLocations' doc comment in utils/merchantPlacement.js). When
  // that happens, the name alone can't say which physical site the manifest
  // means, so this picker appears to ask — and only then. It stays hidden
  // for every ordinary (zero- or one-match) "Transfer to" value, exactly as
  // before this existed.
  let selectedWarehouseId = '';
  const warehousePickWrap = footerExtra.querySelector('[data-role="manifest-warehouse-pick"]');
  const warehousePickSelect = footerExtra.querySelector('[data-role="manifest-warehouse-select"]');
  // Same styled trigger + popover as every other <select> in the app
  // (e.g. Manage's "Position Type" filter) instead of a bare native
  // control — wraps the real <select> in place, so .value/'change' below
  // keep working exactly as if it were untouched.
  const warehousePickField = enhanceSelect(warehousePickSelect);

  function showWarehousePick(candidates) {
    const stillValid = selectedWarehouseId && candidates.some((c) => c.warehouseSite.id === selectedWarehouseId);
    if (!stillValid) selectedWarehouseId = '';
    warehousePickSelect.innerHTML =
      `<option value="" disabled ${selectedWarehouseId ? '' : 'selected'}>Select warehouse…</option>` +
      candidates
        .map((c) => `<option value="${esc(c.warehouseSite.id)}"${c.warehouseSite.id === selectedWarehouseId ? ' selected' : ''}>${esc(c.warehouseSite.name)}</option>`)
        .join('');
    // The trigger's visible label is only read at build time — re-sync it
    // every time the options are replaced out from under it (see
    // SelectField.js's own usage note on this).
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
   * than one warehouse site and no site has been picked yet — the one
   * extra condition Transfer / Print needs beyond the required-fields
   * check below. */
  function isWarehouseSelectionResolved() {
    const value = merchantMetaInput.value.trim();
    if (!value || !locationStore || !warehouseStore) return true;
    const candidates = findMatchingLocations(value, { locationStore, warehouseStore });
    if (candidates.length <= 1) return true;
    return Boolean(selectedWarehouseId) && candidates.some((c) => c.warehouseSite.id === selectedWarehouseId);
  }

  function updateMerchantPreview() {
    const value = merchantMetaInput.value.trim();
    merchantPreviewEl.classList.remove('placement-preview-matched', 'placement-preview-unmatched');
    if (!value || !locationStore || !warehouseStore) {
      merchantPreviewEl.textContent = '';
      hideWarehousePick();
      updateTransferButtonState();
      return;
    }

    const candidates = findMatchingLocations(value, { locationStore, warehouseStore });

    if (candidates.length > 1) {
      showWarehousePick(candidates);
      if (selectedWarehouseId) {
        const placement = resolveMerchantPlacement(value, { locationStore, warehouseStore, warehouseId: selectedWarehouseId });
        merchantPreviewEl.textContent = `→ Position Type: ${placement.positionType} · Warehouse: ${placement.warehouse} · Owner: ${placement.owner}`;
        merchantPreviewEl.classList.add('placement-preview-matched');
      } else {
        merchantPreviewEl.textContent = `"${value}" exists in ${candidates.length} warehouses — select which one above to continue.`;
        merchantPreviewEl.classList.add('placement-preview-unmatched');
      }
    } else {
      hideWarehousePick();
      const placement = resolveMerchantPlacement(value, { locationStore, warehouseStore });
      if (placement.matched) {
        merchantPreviewEl.textContent = `→ Position Type: ${placement.positionType} · Warehouse: ${placement.warehouse} · Owner: ${placement.owner}`;
        merchantPreviewEl.classList.add('placement-preview-matched');
      } else {
        merchantPreviewEl.textContent = 'No warehouse location named this yet — Position Type / Warehouse / Owner will stay unassigned for the assets transferred here.';
        merchantPreviewEl.classList.add('placement-preview-unmatched');
      }
    }
    updateTransferButtonState();
  }
  merchantMetaInput.addEventListener('input', updateMerchantPreview);
  warehousePickSelect.addEventListener('change', () => {
    selectedWarehouseId = warehousePickSelect.value;
    updateMerchantPreview();
  });

  /** True once every required meta field (Prepared by/Department/Received
   * by/Transfer to/Date) has a non-blank value. Gates the Transfer / Print
   * button so a manifest can't go out half-filled-in. */
  function isMetaComplete() {
    return REQUIRED_META_KEYS.every((key) => body.querySelector(`[data-meta="${key}"]`).value.trim() !== '');
  }

  function updateTransferButtonState() {
    if (!transferBtn) return;
    const metaComplete = isMetaComplete();
    const ready = metaComplete && isWarehouseSelectionResolved();
    transferBtn.disabled = !ready;
    transferBtn.title = !metaComplete
      ? 'Fill in Prepared by, Department, Received by, Transfer to, and Date first.'
      : (ready ? '' : 'Select which warehouse to transfer to first.');
  }

  REQUIRED_META_KEYS.forEach((key) => {
    body.querySelector(`[data-meta="${key}"]`).addEventListener('input', updateTransferButtonState);
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
      const removeBtn = tr.querySelector('[data-action="remove-manifest-row"]');
      removeBtn.addEventListener('click', () => {
        tr.remove();
        recomputeSummary();
      });
      const categoryInput = tr.querySelector('input[data-field="category"]');
      categoryInput.addEventListener('input', () => recomputeSummary());
    });
  }

  renderRows(initialRows);

  footerExtra.querySelector('[data-action="add-manifest-row"]').addEventListener('click', () => {
    tbody.insertAdjacentHTML('beforeend', rowHTML(blankRow()));
    bindRowEvents();
    recomputeSummary();
    const lastInput = tbody.querySelector('tr:last-child input');
    lastInput?.focus();
  });

  function addPrintPadding() {
    // Idempotent: if a previous print's padding never got cleaned up
    // (e.g. afterprint didn't fire in some browser/print-driver edge
    // case), clear it first instead of stacking another batch on top.
    removePrintPadding();
    const realRowCount = qsa('tr[data-row-id]', tbody).length;
    const padCount = Math.max(0, PRINT_MIN_ROWS - realRowCount);
    for (let i = 0; i < padCount; i++) {
      tbody.insertAdjacentHTML('beforeend', padRowHTML());
    }
  }

  function removePrintPadding() {
    qsa('tr.manifest-pad-row', tbody).forEach((tr) => tr.remove());
  }

  /**
   * @page can't be scoped by a body class the way @media print can (see
   * css/modal.css's own comment on this), so the landscape override this
   * table's 12 columns need is applied as its own <style> tag instead —
   * added right before window.print(), removed right after — so it never
   * leaks into any other feature's print job (e.g. Requisition, which
   * should stay portrait).
   */
  function addLandscapePage() {
    removeLandscapePage();
    const style = document.createElement('style');
    style.id = 'manifestLandscapePage';
    style.textContent = '@page{ size: landscape; margin: 12mm; }';
    document.head.appendChild(style);
  }

  function removeLandscapePage() {
    document.getElementById('manifestLandscapePage')?.remove();
  }

  /**
   * Applies the manifest's "Transfer to" value as the new merchant for
   * every row that maps back to a real Gadget (rows added by hand via
   * "+ Add row" have no matching id and are skipped — there's nothing in
   * the store to update). Mirrors the create/edit convention used
   * elsewhere: log the change on the gadget first, then persist through
   * the store so the append-only history array is saved along with the
   * updated field in the same write.
   *
   * Merchant is the key (Task 2): when locationStore/warehouseStore were
   * supplied and "Transfer to" matches a created location, Position Type
   * / Warehouse / Owner are resolved from that location and written back
   * to every transferred asset in the same update — this is the piece
   * that actually changes all three columns, not just the merchant name.
   *
   * Receiving (Task 1): a resolved location transfer doesn't apply here
   * at all — merchant/positionType/warehouse/owner are left exactly as
   * they are, and a Gadget.pendingTransfer is written instead, the same
   * shape ManageController._saveGadget writes for a single-asset merchant
   * edit. It only actually takes effect once someone whose User Group is
   * bound to the destination warehouse (see core/WarehouseScope.js — or
   * anyone with manage.confirm-transfers) confirms it from the Manage
   * grid. This is deliberately the *same* gate as the single-asset path —
   * a manifest transfer is still a transfer to another merchant, and
   * routing a whole batch of assets around receiving confirmation just
   * because it went through this dialog instead of the Edit form would
   * make the feature trivially bypassable.
   */
  function applyMerchantTransfer() {
    if (!store) return;
    const transferTo = body.querySelector('[data-meta="merchant"]').value.trim();
    if (!transferTo) return;

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

    let updatedCount = 0;
    let pendingCount = 0;
    qsa('tr[data-row-id]', tbody).forEach((tr) => {
      const rowId = tr.getAttribute('data-row-id');
      const gadget = store.get(rowId);
      if (!gadget) return;

      const previousMerchant = gadget.merchant || 'None';
      if (previousMerchant === transferTo) return;

      if (placement.matched) {
        gadget.addLogEntry(
          `Transfer requested: merchant '${previousMerchant}' → '${transferTo}' via manifest.${placementNote} Awaiting confirmation from anyone with access to ${placement.owner}.`,
          'transfer',
          { from: previousMerchant, to: transferTo },
          requestedBy
        );
        store.update(gadget.id, {
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
        // The manifest row keeps showing the *current* merchant — the
        // transfer hasn't actually happened yet — rather than a value
        // that would misrepresent this printed sheet as already final.
      } else {
        gadget.addLogEntry(
          `Transferred merchant from '${previousMerchant}' to '${transferTo}'.${placementNote}`,
          'transfer',
          { from: previousMerchant, to: transferTo },
          requestedBy
        );
        store.update(gadget.id, { merchant: transferTo, pendingTransfer: null, ...placementPatch });
        updatedCount++;

        // Reflect the new merchant in the manifest row itself so the
        // printed sheet shows the post-transfer value, not the stale one.
        const merchantInput = tr.querySelector('input[data-field="merchant"]');
        if (merchantInput) merchantInput.value = transferTo;
      }
    });

    if (updatedCount > 0) {
      const suffix = placement.matched
        ? ` (${placement.positionType} · ${placement.warehouse} · ${placement.owner})`
        : '';
      Toast.success(`Updated merchant to "${transferTo}" for ${updatedCount} asset${updatedCount === 1 ? '' : 's'}${suffix}.`);
    }
    if (pendingCount > 0) {
      Toast.show(`${pendingCount} asset${pendingCount === 1 ? '' : 's'} queued for transfer to "${transferTo}" — awaiting confirmation from anyone with access to ${placement.owner}.`);
    }
  }

  const modal = new Modal({
    title: 'Manifest / Transmittal',
    body,
    size: 'lg',
    footerExtra,
    footer: [
      { label: 'Close', variant: 'btn-outline', onClick: (m) => m.close() },
      {
        label: 'Transfer / Print',
        variant: 'btn-accent',
        onClick: () => {
          if (!isMetaComplete()) return; // belt-and-suspenders — the button is disabled anyway
          // Same rule as Edit asset (Manage): "Transfer to" must be blank,
          // or an exact match to a currently *enabled* Warehouse location —
          // never arbitrary typed text, and never a deactivated location's
          // name. A manifest transfer is still a transfer, so it gets the
          // same gate rather than being a way around it.
          const transferTo = body.querySelector('[data-meta="merchant"]').value.trim();
          if (transferTo && locationStore && warehouseStore) {
            if (!isWarehouseSelectionResolved()) {
              Toast.error(`"${transferTo}" exists in more than one warehouse — select which one before transferring.`);
              return;
            }
            if (!resolveMerchantPlacement(transferTo, { locationStore, warehouseStore, warehouseId: selectedWarehouseId }).matched) {
              Toast.error(`"${transferTo}" isn't a currently active merchant — pick one from the list, or clear "Transfer to" to leave it unassigned.`);
              return;
            }
          }
          addPrintPadding();
          addLandscapePage();
          document.body.classList.add('printing-manifest');
          // Registered fresh on every click and always removes itself, so
          // padding gets cleaned up whether the user prints or cancels —
          // and whether they do that once or ten times in a row.
          window.addEventListener('afterprint', async () => {
            document.body.classList.remove('printing-manifest');
            removePrintPadding();
            removeLandscapePage();

            // Browsers give no signal distinguishing "printed/saved" from
            // "hit Cancel" — afterprint fires either way. An explicit
            // confirmation here is the only reliable way to apply the
            // transfer only once the user actually went through with it,
            // rather than guessing from an event that can't tell us.
            const confirmed = await confirmDialog({
              title: 'Confirm transfer',
              message: 'Did the manifest finish printing or saving? Confirming will update the merchant for the assets above and record it in their history.',
              confirmLabel: 'Yes, apply transfer',
              cancelLabel: 'No, skip'
            });
            if (confirmed) applyMerchantTransfer();
          }, { once: true });
          window.print();
        }
      }
    ],
    onClose: () => { removePrintPadding(); removeLandscapePage(); }
  });

  transferBtn = modal.footEl.querySelector('.btn-accent');
  updateTransferButtonState();

  modal.open();
  return modal;
}
