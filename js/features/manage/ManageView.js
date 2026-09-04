import { esc, qsa } from '../../utils/dom.js';
import { fmtInt, fmtDate } from '../../utils/format.js';
import { temporaryPositionLabel } from '../../models/Gadget.js';
import { renderPagination } from '../../components/Pagination.js';
import { enhanceSelect } from '../../components/SelectField.js';

/**
 * ManageView owns DOM rendering only. It receives plain data and a table
 * of callbacks — it never touches the Store or localStorage directly.
 */
export class ManageView {
  constructor(refs) {
    this.refs = refs;
    this._revealedPasswords = new Set();
    // Category has 20+ options, so it gets the search box; the underlying
    // <select> stays fully functional (value/change/innerHTML) — see
    // components/SelectField.js for why that matters here. Position Type
    // and Warehouse Area have far fewer options in practice, so they're
    // enhanced for consistent visual styling but without the search box.
    enhanceSelect(this.refs.filterCategory, { searchable: true });
    enhanceSelect(this.refs.filterPosition);
    enhanceSelect(this.refs.filterWarehouse);
  }

  /** Populates the Category / Position Type / Warehouse Area <select> filters,
   * preserving each one's current selection. Warehouse *site* has its own,
   * separate filter control — the side tab bar (see renderWarehouseFilterButton)
   * — so there's no dropdown to keep in sync here for that one. */
  renderFilterOptions(categories, positionTypes, warehouseAreas, filters) {
    this._fillSelect(this.refs.filterCategory, categories, 'All Categories', filters.category);
    this._fillSelect(this.refs.filterPosition, positionTypes, 'Position Type', filters.position);
    this._fillSelect(this.refs.filterWarehouse, warehouseAreas, 'Warehouse Area', filters.warehouseArea);
  }

  /**
   * Reflects state on the single, always-present "Warehouse" filter
   * button: hidden entirely when there's nothing to filter by (no
   * warehouse exists in Settings yet), otherwise shown and highlighted
   * while a non-"all" filter is active. Its label shows the selected
   * warehouse's name (or "Warehouse" when nothing's selected) — it was
   * previously left as static placeholder text in the HTML and never
   * actually updated here. The button's click handler (which opens the
   * actual flyout of warehouse options) is wired once by the controller —
   * this method never touches innerHTML, so nothing needs re-binding on
   * every render.
   */
  renderWarehouseFilterButton(hasOptions, activeOwner) {
    const btn = this.refs.warehouseFilterBtn;
    if (!btn) return;
    btn.hidden = !hasOptions;
    btn.classList.toggle('active', activeOwner !== 'all');
    btn.textContent = activeOwner === 'all' ? 'Warehouse' : activeOwner;
  }

  _fillSelect(selectEl, options, allLabel, currentValue) {
    selectEl.innerHTML = `<option value="all">${esc(allLabel)}</option>` +
      options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
    selectEl.value = options.includes(currentValue) ? currentValue : 'all';
    selectEl._selectField?.sync();
  }

  renderTable(pageGadgets, selectedIds, handlers, duplicateSerials = new Set(), catalogIssuesById = new Map(), perms = {}) {
    const { canEdit = true, canViewLog = true, canDelete = true, canActOnTransfer = () => false } = perms;
    if (pageGadgets.length === 0) {
      this.refs.tableBody.innerHTML = '';
      this.refs.emptyState.style.display = 'block';
      this._syncSelectAllCheckbox([], selectedIds);
      return;
    }
    this.refs.emptyState.style.display = 'none';

    this.refs.tableBody.innerHTML = pageGadgets.map((g, index) => this._rowHTML(g, index, selectedIds.has(g.id), duplicateSerials, catalogIssuesById.get(g.id), { canEdit, canViewLog, canDelete, canActOnTransfer: canActOnTransfer(g) })).join('');

    qsa('tr[data-id]', this.refs.tableBody).forEach((row) => {
      const id = row.getAttribute('data-id');
      // Each action button is rendered disabled below when its permission
      // is denied (see _rowHTML) — skip wiring the handler too rather
      // than rely solely on browsers not firing click on a disabled button.
      if (canEdit) row.querySelector('[data-action="edit"]').addEventListener('click', () => handlers.onEdit(id));
      if (canViewLog) row.querySelector('[data-action="log"]').addEventListener('click', () => handlers.onViewLog(id));
      if (canDelete) row.querySelector('[data-action="delete"]').addEventListener('click', () => handlers.onDelete(id));
      row.querySelector('[data-action="select-row"]').addEventListener('change', (e) => handlers.onToggleSelect(id, e.target.checked));
      const confirmBtn = row.querySelector('[data-action="confirm-transfer"]');
      if (confirmBtn && !confirmBtn.disabled) confirmBtn.addEventListener('click', () => handlers.onConfirmTransfer(id));
      const cancelBtn = row.querySelector('[data-action="cancel-transfer"]');
      if (cancelBtn && !cancelBtn.disabled) cancelBtn.addEventListener('click', () => handlers.onCancelTransfer(id));
      const toggle = row.querySelector('[data-action="reveal-password"]');
      if (toggle) {
        toggle.addEventListener('click', () => {
          if (this._revealedPasswords.has(id)) this._revealedPasswords.delete(id);
          else this._revealedPasswords.add(id);
          handlers.onRerender();
        });
      }
    });

    this.refs.selectAllCheckbox.onchange = (e) => handlers.onToggleSelectAll(e.target.checked);
    this._syncSelectAllCheckbox(pageGadgets, selectedIds);
  }

  _syncSelectAllCheckbox(pageGadgets, selectedIds) {
    const cb = this.refs.selectAllCheckbox;
    if (pageGadgets.length === 0) {
      cb.checked = false;
      cb.indeterminate = false;
      return;
    }
    const selectedOnPage = pageGadgets.filter((g) => selectedIds.has(g.id)).length;
    cb.checked = selectedOnPage === pageGadgets.length;
    cb.indeterminate = selectedOnPage > 0 && selectedOnPage < pageGadgets.length;
  }

  renderSortHeaders(sortBy, sortDir) {
    qsa('th[data-sort]', this.refs.tableHead).forEach((th) => {
      const key = th.getAttribute('data-sort');
      th.classList.toggle('sorted', key === sortBy);
      const arrow = th.querySelector('.arrow');
      if (arrow) arrow.textContent = key === sortBy ? (sortDir === 'asc' ? '↑' : '↓') : '↕';
    });
  }

  /**
   * @param {object} info - { totalItems, selectedCount, page, pageSize, totalPages, allPageSelected, allFilteredSelected }
   * @param {object} handlers - { onPrevPage, onNextPage, onPageClick(page), onPageSizeChange(size), onGotoPage(page), onSelectAllFiltered(), onClearSelection() }
   */
  renderFooter(info, handlers) {
    const { totalItems, selectedCount, page, pageSize, totalPages, allPageSelected = false, allFilteredSelected = false } = info;

    this.refs.resultCount.textContent = `${fmtInt(totalItems)} ${totalItems === 1 ? 'asset' : 'assets'}`;
    this.refs.selectedCount.textContent = `Checked ${fmtInt(selectedCount)}`;

    // "Select all N filtered" — only worth offering once the whole
    // current page is already checked AND there's more beyond it to
    // reach; otherwise it'd either be redundant (nothing more to select)
    // or misleading (offering to reach rows before the page itself is
    // even fully checked). See ManageController.render()'s own comment
    // for how allPageSelected/allFilteredSelected are derived.
    const selectAllBtn = this.refs.selectAllFilteredBtn;
    if (selectAllBtn) {
      const show = allPageSelected && !allFilteredSelected;
      selectAllBtn.style.display = show ? '' : 'none';
      if (show) selectAllBtn.textContent = `Select all ${fmtInt(totalItems)} filtered assets`;
      selectAllBtn.onclick = () => handlers.onSelectAllFiltered();
    }

    const clearSelectionBtn = this.refs.clearSelectionBtn;
    if (clearSelectionBtn) {
      clearSelectionBtn.style.display = selectedCount > 0 ? '' : 'none';
      clearSelectionBtn.onclick = () => handlers.onClearSelection();
    }

    renderPagination(this.refs, { page, pageSize, totalPages }, handlers);
  }

  _rowHTML(g, index, selected, duplicateSerials = new Set(), catalogIssue = null, perms = {}) {
    const { canEdit = true, canViewLog = true, canDelete = true, canActOnTransfer = false } = perms;
    const revealed = this._revealedPasswords.has(g.id);
    const passwordDisplay = g.password
      ? (revealed ? esc(g.password) : '••••••••')
      : '<span style="color:var(--ink-faint);">—</span>';

    const isDuplicateSerial = Boolean(g.serialNumber) && duplicateSerials.has(g.serialNumber.trim().toLowerCase());
    const serialProblems = [];
    if (isDuplicateSerial) serialProblems.push('Duplicate serial number — also used by another asset');
    if (catalogIssue?.serialNumber) serialProblems.push(catalogIssue.serialNumber);
    const serialCellClass = serialProblems.length ? ' class="cell-duplicate-serial"' : '';
    const serialCellTitle = serialProblems.length ? ` title="${esc(serialProblems.join(' / '))}"` : '';

    const catIssue = catalogIssue?.category;
    const tagIssue = catalogIssue?.assetTagDefault;
    const macIssue = catalogIssue?.macAddress;
    const badge = (message) => (message ? `<span class="catalog-flag" title="${esc(message)}">⚠</span>` : '');

    const p = g.pendingTransfer;
    const pendingNote = p
      ? `<div class="pill pill-pending" title="Requested by ${esc(p.requestedBy || 'someone')} · awaiting confirmation from anyone with access to ${esc(p.toOwner || 'the destination warehouse')}">→ ${esc(p.toMerchant)}</div>`
      : '';
    // The "—" placeholder means "no merchant set" — but with a pending
    // transfer already spelling that out as "→ toMerchant" right after
    // it, showing both together read as "— → INSPI group": a dash that
    // implies nothing's there, immediately followed by proof something
    // is (the transfer itself). Only show the placeholder when there's
    // no pending transfer to make it redundant.
    const merchantCurrent = g.merchant
      ? esc(g.merchant)
      : (p ? '' : '<span style="color:var(--ink-faint);">—</span>');

    return `
      <tr data-id="${g.id}" class="${selected ? 'row-selected' : ''}">
        <td data-label="SN" class="sn-col"><div style="display: flex; justify-content: end; padding: 0;">${index + 1}</div></td>
        <td class="checkbox-col"><div><input type="checkbox" tabindex="-1" data-action="select-row" ${selected ? 'checked' : ''} aria-label="Select asset" style="height: 15px; width: 15px;"></div></td>
        <td data-col="user" data-label="User"><div class="item-name">${g.user ? esc(g.user) : '<span style="color:var(--ink-faint);">Unassigned</span>'}</div></td>
        <td data-col="role" data-label="Role"><div>${g.role ? esc(g.role) : '<span style="color:var(--ink-faint);">—</span>'}</div></td>
        <td data-col="category" data-label="Category"${catIssue ? ' class="cell-catalog-invalid"' : ''}><div><span class="pill pill-cat" title="${esc(g.category)}">${esc(g.category)}</span> ${badge(catIssue)}</div></td>
        <td data-col="serialNumber" data-label="Serial Number"${serialCellClass}${serialCellTitle}><div>${g.serialNumber ? `<span class="code-tag" title="${esc(g.serialNumber)}"><span class="bars"></span>${esc(g.serialNumber)}</span>` : '<span style="color:var(--ink-faint);">—</span>'}</div></td>
        <td data-col="warehouseAssetTag" data-label="Warehouse Asset Tag" style="font-family:var(--font-mono); font-size:12px;"><div>${g.warehouseAssetTag ? esc(g.warehouseAssetTag) : '<span style="color:var(--ink-faint);">—</span>'}</div></td>
        <td data-col="assetTagDefault" data-label="Asset Tag (Default)" style="font-family:var(--font-mono); font-size:12px;"${tagIssue ? ' class="cell-catalog-invalid"' : ''}><div>${g.assetTagDefault ? `<span class="code-tag"><span class="bars"></span>${esc(g.assetTagDefault)}</span>` : '<span style="color:var(--ink-faint);">—</span>'} ${badge(tagIssue)}</div></td>
        <td data-col="macAddress" data-label="Mac Address" style="font-family:var(--font-mono); font-size:12px;"${macIssue ? ' class="cell-catalog-invalid"' : ''}><div>${g.macAddress ? esc(g.macAddress) : '<span style="color:var(--ink-faint);">—</span>'} ${badge(macIssue)}</div></td>
        <td data-col="password" data-label="Password">
          <div class="password-cell">
            <span class="password-value">${passwordDisplay}</span>
            ${g.password ? `<button tabindex="-1" class="icon-btn password-reveal-btn" data-action="reveal-password" aria-label="${revealed ? 'Hide password' : 'Reveal password'}" title="${revealed ? 'Hide' : 'Reveal'}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>` : ''}
          </div>
        </td>
        <td data-col="merchant" data-label="Merchant" style="font-family:var(--font-mono); font-size:12px;"><div>${merchantCurrent}${pendingNote}</div></td>
        <td data-col="remarks" data-label="Remarks"><div class="clamp-text" title="${esc(g.remarks)}">${g.remarks ? esc(g.remarks) : '<span style="color:var(--ink-faint);">—</span>'}</div></td>
        <td data-col="description" data-label="Description"><div class="clamp-text" title="${esc(g.description)}">${g.description ? esc(g.description) : '<span style="color:var(--ink-faint);">—</span>'}</div></td>
        <td data-col="positionType" data-label="PositionType"><div>${
          g.temporaryPosition
            ? `<span title="Temporarily parked in a holding bin, not its normal warehouse">${esc(temporaryPositionLabel(g.temporaryPosition))}</span>`
            : (g.positionType ? esc(g.positionType) : '<span style="color:var(--ink-faint);">Unassigned</span>')
        }</div></td>
        <td data-col="warehouse" data-label="Warehouse"><div>${g.warehouse ? `<span class="pill pill-warehouse">${esc(g.warehouse)}</span>` : '<span style="color:var(--ink-faint);">Unassigned</span>'}</div></td>
        <td data-col="owner" data-label="Owner" class="owner-col" style="font-family:var(--font-mono); font-size:12px;"><div>${g.owner ? esc(g.owner) : '<span style="color:var(--ink-faint);">—</span>'}</div></td>
        <td data-col="createdAt" data-label="Created" class="created-col"><div><small>${fmtDate(g.createdAt)}</small></div></td>
        <td data-col="updatedAt" data-label="Updated" class="updated-col"><div><small>${fmtDate(g.updatedAt)}</small></div></td>
        <td data-col="actions" data-label="Actions">
          <div class="row-actions">
            ${p ? `<button tabindex="-1" class="icon-btn success" data-action="confirm-transfer" aria-label="Confirm receipt" title="${canActOnTransfer ? `Confirm receipt at '${esc(p.toMerchant)}'` : 'You do not have Confirm transfers access.'}" ${canActOnTransfer ? '' : 'disabled'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
            </button>
            <button tabindex="-1" class="icon-btn danger" data-action="cancel-transfer" aria-label="Cancel pending transfer" title="${canActOnTransfer ? 'Cancel this pending transfer' : 'You need Confirm transfers access, or edit access to the merchant field, to cancel this.'}" ${canActOnTransfer ? '' : 'disabled'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>
            </button>` : ''}
            <button tabindex="-1" class="icon-btn" data-action="edit" aria-label="Edit asset" title="${canEdit ? 'Edit' : 'You do not have permission to edit assets.'}" ${canEdit ? '' : 'disabled'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>
            <button tabindex="-1" class="icon-btn" data-action="log" aria-label="View history log" title="${canViewLog ? 'View log' : 'You do not have permission to view the log.'}" ${canViewLog ? '' : 'disabled'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
            </button>
            <button tabindex="-1" class="icon-btn danger" data-action="delete" aria-label="Delete asset" title="${canDelete ? 'Delete' : 'You do not have permission to delete assets.'}" ${canDelete ? '' : 'disabled'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  }
}