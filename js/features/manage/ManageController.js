import { Modal } from '../../components/Modal.js';
import { Toast } from '../../components/Toast.js';
import { confirmDialog } from '../../components/ConfirmDialog.js';
import { openLogModal } from '../../components/LogModal.js';
import { openManifestModal as showManifestModal } from '../../components/ManifestModal.js';
import { openProcessRequestModal as showProcessRequestModal } from '../../components/ProcessRequestModal.js';
import { openDropdownMenu } from '../../components/DropdownMenu.js';
import { enhanceSelect } from '../../components/SelectField.js';
import { Gadget, TEMP_POSITION_TYPES, temporaryPositionLabel, effectivePositionLabel } from '../../models/Gadget.js';
import { buildManageForm } from './ManageForm.js';
import { toCsv, downloadCsv } from '../../utils/csv.js';
import { el, esc } from '../../utils/dom.js';
import { getOperatorName } from '../../core/Operator.js';
import { can } from '../../core/Permissions.js';
import { isWarehouseAllowed, isWarehouseScoped } from '../../core/WarehouseScope.js';
import { fmtLocalDateTime, fmtLocalDateStamp } from '../../utils/format.js';
import { resolveMerchantPlacement } from '../../utils/merchantPlacement.js';
import { ColumnConfig } from '../../core/ColumnConfig.js';
import { openColumnConfigPanel } from '../../components/ColumnConfigPanel.js';
import { applyColumnLayout } from '../../utils/columnLayout.js';
import { syncInventoryAssetFromGadget } from '../../core/InventoryGadgetSync.js';

/** Manage's configurable columns — everything in the grid except the
 * leading row-number/select columns and the trailing Actions column,
 * neither of which the column-configuration panel lets you touch (see
 * core/ColumnConfig.js's own doc comment for why). Order here is the
 * default order; width is the starting pixel width. Persisted per
 * browser under 'gadget-tracker:columns:manage' — see ColumnConfig. */
const MANAGE_DEFAULT_COLUMNS = [
  { key: 'user', label: 'User', width: 140 },
  { key: 'role', label: 'Role', width: 100 },
  { key: 'category', label: 'Category', width: 130 },
  { key: 'serialNumber', label: 'Serial Number', width: 160 },
  { key: 'warehouseAssetTag', label: 'Warehouse Asset Tag', width: 160 },
  { key: 'assetTagDefault', label: 'Asset Tag (Default)', width: 160 },
  { key: 'macAddress', label: 'Mac Address', width: 150 },
  { key: 'password', label: 'Password', width: 120 },
  { key: 'merchant', label: 'Merchant', width: 140 },
  { key: 'remarks', label: 'Remarks', width: 160 },
  { key: 'description', label: 'Description', width: 180 },
  { key: 'positionType', label: 'Position Type', width: 140 },
  { key: 'warehouse', label: 'Warehouse', width: 140 },
  { key: 'owner', label: 'Owner', width: 100 },
  { key: 'createdAt', label: 'Created', width: 150 },
  { key: 'updatedAt', label: 'Updated', width: 150 }
];

/** Column order/labels shared by the CSV export, the import template, and the importer. */
const IMPORT_HEADERS = ['User', 'Role', 'Category', 'Serial Number', 'Warehouse Asset Tag', 'Asset Tag (Default)', 'MAC Address', 'Merchant', 'Owner', 'Remarks', 'Description'];

/**
 * ManageController is the feature's entry point: it owns UI state
 * (filters/sort/pagination/selection), talks to the Store for CRUD, and
 * delegates all rendering to ManageView. Modal/Toast/ConfirmDialog/
 * LogModal/DropdownMenu are generic components reused as-is.
 */
export class ManageController {
  constructor({ store, view, refs, inventoryAssetStore, warehouseStore, locationStore, requisitionStore }) {
    this.store = store;
    this.view = view;
    this.refs = refs;
    // Read-only reference to Requisition Form submissions — feeds the
    // "Requisition" picker in Process Request (see openProcessRequestModal)
    // and lets it mark the chosen one finished once assets are issued.
    // Manage never writes anything else to it.
    this.requisitionStore = requisitionStore;
    // Read-only reference to the Inventory Assets module, which is the
    // source of truth for category/serial/MAC/asset-tag suggestions in
    // the add/edit form (see _openGadgetModal). Manage never writes to it.
    this.inventoryAssetStore = inventoryAssetStore;
    // Read-only reference to Warehouse Information (Settings). This is
    // the authoritative registry of warehouse sites — the source for
    // both the warehouse filter dropdown and the side tab bar — so a
    // warehouse shows up as filterable the moment it's added in
    // Settings, even before any asset has been assigned to it.
    this.warehouseStore = warehouseStore;
    // Read-only reference to Warehouse Information's created locations
    // (Settings → a warehouse's zone → "create warehouse location").
    // Merchant is the key: whenever a gadget's merchant is set to a name
    // that matches one of these locations' codes, Position Type /
    // Warehouse / Owner are derived from where that location lives (see
    // utils/merchantPlacement.js) instead of being typed by hand.
    this.locationStore = locationStore;

    // Column visibility/width/order/pin state for this grid — see
    // core/ColumnConfig.js. A client-side display preference, not
    // warehouse data, so it lives in localStorage rather than Supabase.
    this.columnConfig = new ColumnConfig('gadget-tracker:columns:manage', MANAGE_DEFAULT_COLUMNS);

    this.state = {
      filters: { keyword: '', category: 'all', position: 'all', warehouseArea: 'all', owner: 'all', pendingOnly: false },
      sortBy: 'category',
      sortDir: 'asc',
      page: 1,
      pageSize: 50
    };
    this.selected = new Set();
    // Guards the store 'change' subscription below during
    // _confirmSelectedTransfers/_cancelSelectedTransfers — see their own
    // doc comments for why a bulk operation needs this.
    this._bulkTransferInProgress = false;

    this.store.on('change', () => { if (!this._bulkTransferInProgress) this.render(); });
    this.warehouseStore?.on('change', () => this.render());
    this.locationStore?.on('change', () => this.render());
    // A Requisition submitted/finished/deleted elsewhere (Requisition tab)
    // should update Process Request's picker immediately, same as every
    // other cross-feature store this controller already listens to.
    this.requisitionStore?.on('change', () => this.render());
    this._bindFilterBar();
    this._bindActionBar();
    this._bindTableHead();
    this._bindFooter();
  }

  init() {
    this.render();

    // A one-time nudge for anyone whose User Group is specifically bound
    // to a warehouse a transfer is waiting on. Deliberately scoped to
    // *warehouse-restricted* sessions only, not everything
    // manage.confirm-transfers could act on — an unrestricted account
    // with oversight access doesn't need a toast every time they sign in
    // for transfers that aren't really theirs to chase (see
    // _pendingTransfersForMe).
    const mine = this._pendingTransfersForMe();
    if (mine.length > 0) {
      Toast.show(`You have ${mine.length} transfer${mine.length === 1 ? '' : 's'} awaiting your confirmation.`);
    }
  }

  // ---------- Derived data ----------
  _knownCategories() {
    return [...new Set(this.store.list().map((g) => g.category).filter(Boolean))].sort();
  }

  /** Position Type filter options — every real label a gadget's Position
   * Type column can show (see models/Gadget.js's effectivePositionLabel),
   * except "Unassigned" — that's the default state most assets start in,
   * not something worth offering as its own filter choice. */
  _knownPositionTypes() {
    return [...new Set(this.store.list().map((g) => effectivePositionLabel(g)).filter((label) => label !== 'Unassigned'))].sort();
  }

  /** Warehouse Area filter options — every value the Manage grid's own
   * Warehouse column can show (`g.warehouse`, the zone/area a position
   * resolved to — see utils/merchantPlacement.js), not the warehouse
   * *site* names the separate "Warehouse" scope filter button already
   * covers (that one filters by `g.owner`; this is a different column
   * entirely). "Unassigned" is excluded for the same reason as
   * _knownPositionTypes() above. */
  _knownWarehouseAreas() {
    return [...new Set(this.store.list().map((g) => g.warehouse).filter(Boolean))].sort();
  }

  /**
   * Pending transfers into a warehouse this session's User Group is
   * specifically bound to — the "personal inbox" count used for the
   * onload toast. Deliberately '' for an *unrestricted* session (no
   * group, or a group with no "Bind warehouse" list) rather than
   * treating unrestricted-so-technically-allowed as "mine, personally" —
   * that's oversight access, not a job assignment, and toasting
   * oversight holders for every transfer app-wide on every sign-in would
   * be noise, not a nudge. See core/WarehouseScope.js's isWarehouseScoped.
   *
   * Also requires manage.confirm-transfers itself, same as
   * _canActOnPendingTransfer — being scoped to a warehouse without that
   * permission means there's nothing here this person can actually act
   * on, so telling them "N transfers awaiting your confirmation" would
   * be the same bug this whole permission exists to prevent, just
   * surfacing as a misleading notification instead of an unauthorized
   * button.
   */
  _pendingTransfersForMe() {
    if (!isWarehouseScoped() || !can('manage.confirm-transfers')) return [];
    return this.store.list().filter((g) => g.pendingTransfer && isWarehouseAllowed(g.pendingTransfer.toWarehouseId));
  }

  /** Every pending transfer this session is actually allowed to confirm/cancel — assigned-to-me ones plus, for manage.confirm-transfers holders, everyone else's too. Drives the toolbar badge count and the "Pending transfers" quick filter. */
  _pendingTransfersActionable() {
    return this.store.list().filter((g) => g.pendingTransfer && this._canActOnPendingTransfer(g));
  }

  /** Shows/hides and labels the "Pending transfers (n)" toolbar toggle — visible whenever there's something to act on, or while the filter itself is switched on (so it stays reachable to turn back off even if the count just dropped to zero). */
  _updatePendingTransfersButton() {
    if (!this.refs.pendingTransfersBtn) return;
    const count = this._pendingTransfersActionable().length;
    const active = this.state.filters.pendingOnly;
    const show = count > 0 || active;
    this.refs.pendingTransfersBtn.style.display = show ? '' : 'none';
    if (this.refs.pendingTransfersSep) this.refs.pendingTransfersSep.style.display = show ? '' : 'none';
    this.refs.pendingTransfersBtn.textContent = `Pending Transfers (${count})`;
    this.refs.pendingTransfersBtn.classList.toggle('active', active);
  }

  /**
   * Warehouse names for the side filter button's flyout — every real site
   * configured in Warehouse Information (Settings), not just whatever
   * Owner values happen to already be sitting on a Manage record. A
   * warehouse should be filterable — and show up as "active" once
   * selected — the moment it exists in Settings, even before any asset
   * has actually been assigned to it. Filtering itself still matches
   * against each record's `owner` field (see _filteredSortedGadgets);
   * this only changes where the *option list* comes from.
   *
   * When the signed-in session is warehouse-scoped (its User Group has a
   * non-empty "Bind warehouse" list — see core/WarehouseScope.js), this
   * is also where that restriction is enforced: only bound warehouses
   * ever appear as an option here, full stop.
   */
  _knownOwners() {
    if (!this.warehouseStore) return [];
    return this.warehouseStore.list()
      .filter((w) => isWarehouseAllowed(w.id))
      .map((w) => w.name).filter(Boolean).sort();
  }

  /**
   * The owner filter actually in effect: the person's own selection,
   * except when they're scoped to exactly one warehouse — in that case
   * there's nothing to choose between, so that single warehouse is
   * applied automatically rather than making "All" a meaningless extra
   * click. See _openWarehouseFilterMenu() for the matching "All" option
   * being hidden in that same case.
   */
  _effectiveOwnerFilter() {
    const owners = this._knownOwners();
    if (isWarehouseScoped() && owners.length === 1) return owners[0];
    return this.state.filters.owner;
  }

  /** Resolves a merchant name against created locations — see
   * utils/merchantPlacement.js. Bound to this controller's stores so
   * ManageForm's live preview and the actual save-time derivation both
   * go through the exact same lookup. */
  _resolvePlacement(merchant) {
    return resolveMerchantPlacement(merchant, { locationStore: this.locationStore, warehouseStore: this.warehouseStore });
  }

  /** Serial numbers (lowercased, trimmed) that appear on more than one record, inventory-wide. */
  _duplicateSerialSet() {
    const counts = new Map();
    this.store.list().forEach((g) => {
      const key = (g.serialNumber || '').trim().toLowerCase();
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
  }

  /**
   * Serial numbers (lowercased, trimmed) already assigned to some Manage
   * record — used to keep the add/edit form from suggesting a serial that
   * would just trigger the duplicate-serial error anyway. Excludes the
   * gadget currently being edited, if any, so its own serial isn't
   * filtered out of its own suggestion list.
   */
  _usedSerialSet(excludeGadgetId = null) {
    const used = new Set();
    this.store.list().forEach((g) => {
      if (g.id === excludeGadgetId) return;
      const key = (g.serialNumber || '').trim().toLowerCase();
      if (key) used.add(key);
    });
    return used;
  }

  /**
   * Maps gadget id -> catalog issues, for records already saved in Manage
   * whose category/serial/asset tag don't (or no longer) match Inventory
   * Assets — e.g. saved before that catalog entry existed, or the catalog
   * entry was since edited or removed. Only entries with at least one
   * issue are included, so most renders return an empty map.
   */
  _catalogIssuesById() {
    const map = new Map();
    this.store.list().forEach((g) => {
      const issues = this._catalogIssues({ category: g.category, serialNumber: g.serialNumber, assetTagDefault: g.assetTagDefault, macAddress: g.macAddress }, g);
      if (issues.category || issues.serialNumber || issues.assetTagDefault || issues.macAddress) {
        map.set(g.id, issues);
      }
    });
    return map;
  }

  /**
   * Checks category / serialNumber / assetTagDefault / macAddress against
   * the Inventory Assets catalog (source of truth). Returns { category,
   * serialNumber, assetTagDefault, macAddress }, each either null (fine)
   * or a message describing the mismatch.
   *
   * If a serial number is given, the other three must all agree with
   * THAT SAME catalog record — a real serial can't be paired with a
   * category, tag, or MAC lifted from a different device. With no serial
   * given, each is checked independently against whatever values exist
   * anywhere in the catalog.
   *
   * @param {object} fields
   * @param {import('../../models/Gadget.js').Gadget|null} [gadget] - the
   *   record being edited, if any. When it's already linked to a real
   *   InventoryAsset row (gadget.inventoryAssetId), the whole
   *   must-already-match-the-catalog check above is skipped: editing
   *   these fields on a linked gadget doesn't need to agree with Inventory
   *   Assets first, because saving pushes the correction straight onto
   *   the linked row itself (see core/InventoryGadgetSync.js's
   *   syncInventoryAssetFromGadget, called from _saveGadget) — the two
   *   are kept in sync going forward rather than required to already
   *   match going in. Only a same-serial collision against some *other*
   *   InventoryAsset record is still checked, since that would be a real
   *   duplicate the moment it synced over.
   */
  _catalogIssues({ category, serialNumber, assetTagDefault, macAddress }, gadget = null) {
    const assets = this.inventoryAssetStore ? this.inventoryAssetStore.list() : [];
    const issues = { category: null, serialNumber: null, assetTagDefault: null, macAddress: null };
    const serial = (serialNumber || '').trim();

    if (gadget?.inventoryAssetId) {
      if (serial) {
        const collision = assets.find((a) => a.id !== gadget.inventoryAssetId && (a.serialNumber || '').trim().toLowerCase() === serial.toLowerCase());
        if (collision) issues.serialNumber = 'This serial number is already used by another Inventory Assets record.';
      }
      return issues;
    }

    if (serial) {
      const match = assets.find((a) => (a.serialNumber || '').trim() === serial);
      if (!match) {
        issues.serialNumber = 'This serial number was not found in Inventory Assets.';
        if (category) issues.category = 'Can\'t verify category — this serial number isn\'t in Inventory Assets.';
        if (assetTagDefault) issues.assetTagDefault = 'Can\'t verify asset tag — this serial number isn\'t in Inventory Assets.';
        if (macAddress) issues.macAddress = 'Can\'t verify MAC address — this serial number isn\'t in Inventory Assets.';
      } else {
        if (category && match.category !== category) {
          issues.category = `Inventory Assets lists this serial under "${match.category}", not "${category}".`;
        }
        if (assetTagDefault && match.assetTag !== assetTagDefault) {
          issues.assetTagDefault = match.assetTag
            ? `Inventory Assets lists this serial's tag as "${match.assetTag}", not "${assetTagDefault}".`
            : 'Inventory Assets has no asset tag on file for this serial number.';
        }
        if (macAddress && (match.macAddress || '').toLowerCase() !== macAddress.toLowerCase()) {
          issues.macAddress = match.macAddress
            ? `Inventory Assets lists this serial's MAC address as "${match.macAddress}", not "${macAddress}".`
            : 'Inventory Assets has no MAC address on file for this serial number.';
        }
      }
    } else {
      if (category && !assets.some((a) => a.category === category)) {
        issues.category = 'This category does not exist in Inventory Assets.';
      }
      if (assetTagDefault && !assets.some((a) => a.assetTag === assetTagDefault)) {
        issues.assetTagDefault = 'This asset tag does not exist in Inventory Assets.';
      }
      if (macAddress && !assets.some((a) => (a.macAddress || '').toLowerCase() === macAddress.toLowerCase())) {
        issues.macAddress = 'This MAC address does not exist in Inventory Assets.';
      }
    }

    return issues;
  }

  /** True if any of category/serialNumber/assetTagDefault/macAddress fails catalog validation. */
  _hasCatalogIssue(fields, gadget = null) {
    const issues = this._catalogIssues(fields, gadget);
    return Boolean(issues.category || issues.serialNumber || issues.assetTagDefault || issues.macAddress);
  }

  _filteredSortedGadgets() {
    const f = this.state.filters;
    const kw = f.keyword.trim().toLowerCase();
    const ownerFilter = this._effectiveOwnerFilter();
    // When scoped, "All" still only ever means "all of MY warehouses" —
    // this is what actually enforces that, on top of whatever single
    // warehouse (or "all") the person picked from the flyout. An
    // unassigned asset (ownerKey === 'Unassigned') isn't excluded by
    // this, even though 'Unassigned' is never itself in _knownOwners():
    // it doesn't belong to any *other* warehouse either, so hiding it
    // from every scoped group would make it invisible to everyone —
    // nobody could ever claim it into their own warehouse.
    //
    // A gadget with a pending transfer *into* one of this session's
    // warehouses is also let through, even while its current owner is
    // still a warehouse outside scope — otherwise the very receiver
    // assigned to confirm it (who's typically scoped to the destination
    // warehouse, not the source one) could never find the row to act on
    // it. Ownership hasn't moved yet, so it stays counted under its old
    // owner everywhere else (Reports, the Owner column, etc.) — this is
    // strictly about visibility for the pending receiver.
    const allowedOwners = isWarehouseScoped() ? new Set(this._knownOwners()) : null;

    let gadgets = this.store.list().filter((g) => {
      if (f.category !== 'all' && g.category !== f.category) return false;
      if (f.position !== 'all' && effectivePositionLabel(g) !== f.position) return false;
      if (f.warehouseArea !== 'all' && (g.warehouse || 'Unassigned') !== f.warehouseArea) return false;
      if (f.pendingOnly && (!g.pendingTransfer || !this._canActOnPendingTransfer(g))) return false;
      const ownerKey = g.owner || 'Unassigned';
      const pendingToOwner = g.pendingTransfer?.toOwner;
      if (allowedOwners && ownerKey !== 'Unassigned' && !allowedOwners.has(ownerKey)) {
        if (!pendingToOwner || !allowedOwners.has(pendingToOwner)) return false;
      }
      // Same exception as the scope check just above, for the same
      // reason: a scoped session with exactly one bound warehouse gets
      // that warehouse auto-applied as the owner filter (see
      // _effectiveOwnerFilter), and this asset's *current* owner is
      // still its old warehouse — ownership hasn't moved yet, that's the
      // whole point of "pending". Without this, the scope check above
      // lets the row through, and this very next check silently excluded
      // it again right after — the practical effect was that a pending
      // transfer was only ever visible to an unscoped ("Bound Warehouse:
      // all") session, since that's the only case where ownerFilter is
      // 'all' and this check is skipped entirely.
      if (ownerFilter !== 'all' && ownerKey !== ownerFilter && pendingToOwner !== ownerFilter) return false;
      if (kw) {
        const haystack = [g.user, g.role, g.category, g.serialNumber, g.warehouseAssetTag, g.assetTagDefault, g.macAddress, g.warehouse, g.owner, g.remarks, g.description]
          .join(' ').toLowerCase();
        if (!haystack.includes(kw)) return false;
      }
      return true;
    });

    const dir = this.state.sortDir === 'asc' ? 1 : -1;
    gadgets = gadgets.slice().sort((a, b) => {
      let va, vb;
      // Every case here must match a real `data-sort` value from
      // index.html's Manage table header — anything missing here used to
      // silently fall through to the default (sort by User) instead of
      // sorting by whatever column was actually clicked, which is exactly
      // what made most of this table's column headers look clickable but
      // not actually work.
      switch (this.state.sortBy) {
        case 'user': va = (a.user || '').toLowerCase(); vb = (b.user || '').toLowerCase(); break;
        case 'role': va = (a.role || '').toLowerCase(); vb = (b.role || '').toLowerCase(); break;
        case 'category': va = (a.category || '').toLowerCase(); vb = (b.category || '').toLowerCase(); break;
        case 'serialNumber': va = (a.serialNumber || '').toLowerCase(); vb = (b.serialNumber || '').toLowerCase(); break;
        case 'warehouseAssetTag': va = (a.warehouseAssetTag || '').toLowerCase(); vb = (b.warehouseAssetTag || '').toLowerCase(); break;
        case 'assetTagDefault': va = (a.assetTagDefault || '').toLowerCase(); vb = (b.assetTagDefault || '').toLowerCase(); break;
        case 'macAddress': va = (a.macAddress || '').toLowerCase(); vb = (b.macAddress || '').toLowerCase(); break;
        case 'password': va = (a.password || '').toLowerCase(); vb = (b.password || '').toLowerCase(); break;
        case 'merchant': va = (a.merchant || '').toLowerCase(); vb = (b.merchant || '').toLowerCase(); break;
        case 'remarks': va = (a.remarks || '').toLowerCase(); vb = (b.remarks || '').toLowerCase(); break;
        case 'description': va = (a.description || '').toLowerCase(); vb = (b.description || '').toLowerCase(); break;
        case 'positionType': va = (a.positionType || '').toLowerCase(); vb = (b.positionType || '').toLowerCase(); break;
        case 'warehouse': va = (a.warehouse || '').toLowerCase(); vb = (b.warehouse || '').toLowerCase(); break;
        case 'createdAt': va = a.createdAt; vb = b.createdAt; break;
        case 'updatedAt': va = a.updatedAt; vb = b.updatedAt; break;
        default: va = (a.user || '').toLowerCase(); vb = (b.user || '').toLowerCase();
      }
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
    return gadgets;
  }

  // ---------- Rendering ----------
  render() {
    const allIds = new Set(this.store.list().map((g) => g.id));
    this.selected.forEach((id) => { if (!allIds.has(id)) this.selected.delete(id); });

    const filtered = this._filteredSortedGadgets();
    const totalItems = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / this.state.pageSize));
    if (this.state.page > totalPages) this.state.page = totalPages;
    if (this.state.page < 1) this.state.page = 1;

    const start = (this.state.page - 1) * this.state.pageSize;
    const pageGadgets = filtered.slice(start, start + this.state.pageSize);

    this.view.renderFilterOptions(this._knownCategories(), this._knownPositionTypes(), this._knownWarehouseAreas(), this.state.filters);
    this.view.renderWarehouseFilterButton(this._knownOwners().length > 0, this._effectiveOwnerFilter());
    this._updatePendingTransfersButton();
    this.view.renderTable(pageGadgets, this.selected, {
      onEdit: (id) => this.openEditModal(id),
      onViewLog: (id) => this.viewLog(id),
      onDelete: (id) => this.deleteGadget(id),
      onConfirmTransfer: (id) => this._confirmTransferWithPrompt(id),
      onCancelTransfer: (id) => this._cancelTransferWithPrompt(id),
      onToggleSelect: (id, checked) => this._toggleSelect(id, checked),
      onToggleSelectAll: (checked) => this._toggleSelectAll(pageGadgets, checked),
      onRerender: () => this.render()
    }, this._duplicateSerialSet(), this._catalogIssuesById(), {
      canEdit: can('manage.edit'),
      canViewLog: can('manage.view-log'),
      canDelete: can('manage.delete'),
      canActOnTransfer: (gadget) => this._canActOnPendingTransfer(gadget)
    });
    this.view.renderSortHeaders(this.state.sortBy, this.state.sortDir);
    // allPageSelected/allFilteredSelected drive the footer's "Select all
    // N filtered" hint (see ManageView.renderFooter) — shown only once
    // every row on THIS page is checked but the filtered set is bigger
    // than one page, so there's actually more to select; recomputed
    // fresh every render rather than tracked as separate state, so it
    // never needs to be manually kept in sync with selecting/deselecting
    // individual rows, changing the filter, or changing page size.
    const allPageSelected = pageGadgets.length > 0 && pageGadgets.every((g) => this.selected.has(g.id));
    const allFilteredSelected = totalItems > 0 && filtered.every((g) => this.selected.has(g.id));
    this.view.renderFooter(
      { totalItems, selectedCount: this.selected.size, page: this.state.page, pageSize: this.state.pageSize, totalPages, allPageSelected, allFilteredSelected },
      {
        onPrevPage: () => this._goToPage(this.state.page - 1),
        onNextPage: () => this._goToPage(this.state.page + 1),
        onPageClick: (page) => this._goToPage(page),
        onPageSizeChange: (size) => { this.state.pageSize = size; this.state.page = 1; this.render(); },
        onGotoPage: (page) => this._goToPage(page),
        onSelectAllFiltered: () => this._selectAllFiltered(),
        onClearSelection: () => this._clearSelection()
      }
    );
    this._updateSelectionActions();
    this._applyColumnLayout();
  }

  /** Moves each column's already-rendered <th>/<td data-col> nodes into
   * the configured order, applying width/visibility/pin — see
   * utils/columnLayout.js's own doc comment for why this reorders
   * existing DOM nodes instead of re-deriving cell content. Called after
   * every render() (renderTable() just rebuilt tableBody's rows fresh),
   * and again immediately after Save in the config panel. */
  _applyColumnLayout() {
    const headerRow = this.refs.tableHead?.querySelector('tr');
    if (!headerRow) return;
    applyColumnLayout(headerRow, this.refs.tableBody.querySelectorAll('tr'), this.columnConfig.get());
  }

  _openColumnConfig() {
    openColumnConfigPanel({
      anchor: this.refs.columnBtn,
      columns: this.columnConfig.get(),
      onReset: () => this.columnConfig.reset(),
      onSave: (columns) => {
        this.columnConfig.save(columns);
        this._applyColumnLayout();
      }
    });
  }

  _goToPage(page) {
    this.state.page = page;
    this.render();
  }

  /** Opens the "Warehouse" button's flyout: a DropdownMenu (same singleton
   * used everywhere else in the app) listing "All" plus every warehouse
   * configured in Warehouse Information. Picking one filters the table to
   * records whose `owner` matches that warehouse's name — see
   * _knownOwners() for why the option list is sourced from Settings
   * rather than from whatever's already on Manage's own records.
   *
   * The "All" entry itself is only offered when it means something: when
   * the session isn't warehouse-scoped at all, or it's bound to more
   * than one warehouse. Scoped to exactly one, there's nothing to pick
   * between — see _effectiveOwnerFilter(), which applies that single
   * warehouse automatically instead. */
  _openWarehouseFilterMenu() {
    const owners = this._knownOwners();
    const active = this._effectiveOwnerFilter();
    const showAllOption = !isWarehouseScoped() || owners.length > 1;
    openDropdownMenu({
      anchor: this.refs.warehouseFilterBtn,
      items: [
        ...(showAllOption ? [{ label: active === 'all' ? '✓ All' : 'All', onClick: () => this._selectOwnerFilter('all') }] : []),
        ...owners.map((o) => ({ label: o === active ? `✓ ${o}` : o, onClick: () => this._selectOwnerFilter(o) }))
      ]
    });
  }

  _selectOwnerFilter(value) {
    this.state.filters.owner = value;
    this.state.page = 1;
    this.render();
  }

  // ---------- Selection ----------
  _toggleSelect(id, checked) {
    if (checked) this.selected.add(id);
    else this.selected.delete(id);
    this.render();
  }

  _toggleSelectAll(pageGadgets, checked) {
    pageGadgets.forEach((g) => {
      if (checked) this.selected.add(g.id);
      else this.selected.delete(g.id);
    });
    this.render();
  }

  _updateSelectionActions() {
    const hasSelection = this.selected.size > 0;
    const canManifest = can('manage.preview-manifest');
    const canAdjust = can('manage.adjust-position');

    // Permission still controls visibility (no permission ⇒ not even
    // shown, same as every other permission-gated control in this app);
    // selection now only controls the enabled/disabled state, not
    // visibility — see css/layout.css's .selection-gated:disabled.
    this.refs.manifestBtn.style.display = canManifest ? '' : 'none';
    this.refs.manifestBtn.disabled = !hasSelection;
    this.refs.manifestBtn.title = hasSelection ? '' : 'Select one or more assets first.';
    this.refs.manifestSep.style.display = canManifest ? '' : 'none';

    this.refs.transferItemBtn.style.display = canAdjust ? '' : 'none';
    this.refs.transferItemBtn.disabled = !hasSelection;
    this.refs.transferItemBtn.title = hasSelection ? '' : 'Select one or more assets first.';
    this.refs.transferItemSep.style.display = canAdjust ? '' : 'none';

    if (this.refs.requestItemBtn) {
      const canRequest = can('manage.process-request');
      const hasPendingRequisitions = Boolean(this.requisitionStore?.list().some((r) => r.status !== 'finished'));
      this.refs.requestItemBtn.style.display = canRequest ? '' : 'none';
      this.refs.requestItemBtn.disabled = !hasPendingRequisitions;
      this.refs.requestItemBtn.title = hasPendingRequisitions ? '' : 'No pending requisitions to process.';
      if (this.refs.requestItemSep) this.refs.requestItemSep.style.display = canRequest ? '' : 'none';
    }

    this._updatePendingTransferBulkButtons(hasSelection);

    // "Delete selected" — same gate as the per-row Delete action
    // (manage.delete); a group allowed to delete one asset at a time is
    // allowed to delete many at once, so this reuses that permission
    // rather than adding a separate delete-selected node just for the
    // bulk path, the way Inventory Assets' own clear-all/delete-selected
    // pair does. Exists specifically so a leftover batch of assets no
    // longer represented in Inventory Assets — see _catalogIssuesById —
    // doesn't have to be removed one row, one confirm dialog, at a time.
    if (this.refs.deleteSelectedBtn) {
      const canDeleteSelected = can('manage.delete');
      this.refs.deleteSelectedBtn.style.display = canDeleteSelected ? '' : 'none';
      this.refs.deleteSelectedBtn.disabled = !hasSelection;
      this.refs.deleteSelectedBtn.title = hasSelection ? '' : 'Select one or more assets first.';
      if (this.refs.deleteSelectedSep) this.refs.deleteSelectedSep.style.display = canDeleteSelected ? '' : 'none';
    }
  }

  /**
   * "Transfers" — a dropdown (same shape as "Adjust Position", see
   * _openAdjustPositionMenu) bundling the bulk siblings of the per-row
   * ✓/✕ actions in the Actions column (confirmTransfer/
   * cancelPendingTransfer), for exactly the scenario the Pending
   * Transfers filter itself is meant for: dozens or hundreds of rows
   * waiting on the same warehouse, clicked through one at a time
   * otherwise. Used to be two separate always-visible buttons
   * ("Confirm Transfers (N)" / "Cancel Transfers (N)") sitting side by
   * side in the toolbar — collapsed into one trigger + menu so the
   * action bar doesn't grow a new pair of buttons for every bulk
   * capability it gains. Each item is still gated the same way its old
   * standalone button was — manage.confirm-transfers, plus (Cancel only)
   * manage.edit.merchant — and only counts checked rows that are
   * actually actionable right now (has a pendingTransfer this session is
   * allowed to touch), so an item's own count never promises more than
   * _confirmSelectedTransfers/_cancelSelectedTransfers below will
   * actually do.
   */
  _updatePendingTransferBulkButtons(hasSelection) {
    if (!this.refs.transfersMenuBtn) return;
    const canConfirm = can('manage.confirm-transfers');
    const canCancel = can('manage.confirm-transfers') || can('manage.edit.merchant');
    const confirmable = canConfirm ? this._selectedPendingTransferGadgets() : [];
    const cancellable = canCancel ? this._selectedCancellableTransferGadgets() : [];

    this.refs.transfersMenuBtn.style.display = (canConfirm || canCancel) ? '' : 'none';
    this.refs.transfersMenuBtn.disabled = confirmable.length === 0 && cancellable.length === 0;
    this.refs.transfersMenuBtn.title = this.refs.transfersMenuBtn.disabled
      ? (hasSelection ? 'None of the selected assets have a pending transfer you can confirm or cancel.' : 'Select one or more assets with a pending transfer first.')
      : '';
  }

  /** Opens the "Transfers" dropdown — see _updatePendingTransferBulkButtons
   * for why this replaced two standalone buttons. Each item carries its
   * own live count and is only included when that action actually has
   * something to act on, same as the old buttons hiding/disabling
   * themselves individually. */
  _openTransfersMenu() {
    if (this.refs.transfersMenuBtn.disabled) return;
    const canConfirm = can('manage.confirm-transfers');
    const canCancel = can('manage.confirm-transfers') || can('manage.edit.merchant');
    const confirmable = canConfirm ? this._selectedPendingTransferGadgets() : [];
    const cancellable = canCancel ? this._selectedCancellableTransferGadgets() : [];

    const items = [];
    if (confirmable.length > 0) {
      items.push({ label: `Confirm Transfers (${confirmable.length})`, onClick: () => this._confirmSelectedTransfers() });
    }
    if (cancellable.length > 0) {
      items.push({ label: `Cancel Transfers (${cancellable.length})`, danger: true, onClick: () => this._cancelSelectedTransfers() });
    }
    if (items.length === 0) return;
    openDropdownMenu({ anchor: this.refs.transfersMenuBtn, items });
  }

  /** Checked rows with a pending transfer this session can confirm — see _canActOnPendingTransfer. */
  _selectedPendingTransferGadgets() {
    return [...this.selected]
      .map((id) => this.store.get(id))
      .filter((g) => g && g.pendingTransfer && this._canActOnPendingTransfer(g));
  }

  /** Checked rows with a pending transfer this session can cancel — same "confirm-transfers
   * OR edit.merchant" rule as the single-row cancelPendingTransfer itself. */
  _selectedCancellableTransferGadgets() {
    return [...this.selected]
      .map((id) => this.store.get(id))
      .filter((g) => g && g.pendingTransfer && (this._canActOnPendingTransfer(g) || can('manage.edit.merchant')));
  }

  // ---------- Filter bar bindings ----------
  _bindFilterBar() {
    const applyOnEnter = (el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._applyFilters(); });
    applyOnEnter(this.refs.filterKeyword);

    // Dropdowns apply immediately on selection — there's no "typing in progress"
    // state to wait out, so requiring a separate Search click just makes them
    // look broken.
    this.refs.filterPosition.addEventListener('change', () => this._applyFilters());
    this.refs.filterWarehouse.addEventListener('change', () => this._applyFilters());
    this.refs.filterCategory.addEventListener('change', () => this._applyFilters());

    this.refs.searchBtn.addEventListener('click', () => this._applyFilters());
    this.refs.resetBtn.addEventListener('click', () => this._resetFilters());
    this.refs.warehouseFilterBtn?.addEventListener('click', () => this._openWarehouseFilterMenu());
    this.refs.pendingTransfersBtn?.addEventListener('click', () => {
      this.state.filters.pendingOnly = !this.state.filters.pendingOnly;
      this.state.page = 1;
      this.render();
    });
  }

  _applyFilters() {
    this.state.filters = {
      keyword: this.refs.filterKeyword.value,
      category: this.refs.filterCategory.value,
      position: this.refs.filterPosition.value,
      warehouseArea: this.refs.filterWarehouse.value,
      owner: this.state.filters.owner,
      pendingOnly: this.state.filters.pendingOnly
    };
    this.state.page = 1;
    this.render();
  }

  _resetFilters() {
    this.refs.filterKeyword.value = '';
    this.state.filters = { keyword: '', category: 'all', position: 'all', warehouseArea: 'all', owner: 'all', pendingOnly: false };
    this.state.page = 1;
    this.render();
  }

  // ---------- Action bar / table head bindings ----------
  _bindActionBar() {
    this.refs.exportBtn.addEventListener('click', () => this._openExportMenu());
    this.refs.columnBtn?.addEventListener('click', () => this._openColumnConfig());
    this.refs.manifestBtn.addEventListener('click', () => this.openManifestModal());
    this.refs.transferItemBtn.addEventListener('click', () => this._openAdjustPositionMenu());
    this.refs.requestItemBtn?.addEventListener('click', () => this.openProcessRequestModal());
    this.refs.transfersMenuBtn?.addEventListener('click', () => this._openTransfersMenu());
    this.refs.deleteSelectedBtn?.addEventListener('click', () => this._deleteSelected());
    this.refs.refreshBtn.addEventListener('click', () => this.render());
  }

  _bindTableHead() {
    this.refs.tableHead.querySelectorAll('th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort');
        if (this.state.sortBy === key) {
          this.state.sortDir = this.state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          this.state.sortBy = key;
          this.state.sortDir = 'asc';
        }
        this.render();
      });
    });
  }

  _bindFooter() {
    // Pagination controls are re-bound on every render() via ManageView.renderFooter,
    // since page count / totals change with the data. Nothing static to bind here.
  }

  // ---------- CRUD orchestration ----------
  openEditModal(id) {
    if (!can('manage.edit')) return;
    const gadget = this.store.get(id);
    if (gadget) this._openGadgetModal(gadget);
  }

  _knownUsers() {
    return [...new Set(this.store.list().map((g) => g.user).filter(Boolean))].sort();
  }

  /** Every Role value already in use, suggested in the Edit/Add form's Role field — same idea as _knownUsers, just for the other half of that same field pair. */
  _knownRoles() {
    return [...new Set(this.store.list().map((g) => g.role).filter(Boolean))].sort();
  }

  _openGadgetModal(gadget) {
    const inventoryAssets = this.inventoryAssetStore ? this.inventoryAssetStore.list() : [];
    // Field-level permissions under Manage → Edit (see models/UserGroup.js's
    // PERMISSION_TREE) — this is always an existing asset now (Add no
    // longer lives on this side — see this class's own header comment),
    // so these always apply.
    const fieldPermKeys = {
      category: 'manage.edit.category',
      serialNumber: 'manage.edit.serial-number',
      macAddress: 'manage.edit.mac-address',
      assetTagDefault: 'manage.edit.asset-tag-default',
      remarks: 'manage.edit.remarks'
    };
    const lockedFields = Object.entries(fieldPermKeys).filter(([, key]) => !can(key)).map(([field]) => field);
    const form = buildManageForm(gadget, {
      userOptions: this._knownUsers(),
      roleOptions: this._knownRoles(),
      inventoryAssets,
      usedSerials: this._usedSerialSet(gadget.id),
      lockedFields
    });

    const modal = new Modal({
      title: 'Edit asset',
      body: form.node,
      footer: [
        { label: 'Cancel', variant: 'btn-outline', onClick: (m) => m.close() },
        {
          label: 'Save asset',
          variant: 'btn-accent',
          onClick: (m) => {
            const raw = form.getData();
            const existingGadgets = this.store.list().filter((g) => g.id !== gadget.id);
            const { valid, errors } = Gadget.validate(raw, { existingGadgets });
            const catalogIssues = this._catalogIssues(raw, gadget);
            const hasCatalogIssue = Boolean(catalogIssues.category || catalogIssues.serialNumber || catalogIssues.assetTagDefault || catalogIssues.macAddress);
            if (!valid || hasCatalogIssue) {
              form.showErrors({
                ...errors,
                ...(catalogIssues.category ? { category: catalogIssues.category } : {}),
                ...(catalogIssues.serialNumber ? { serialNumber: catalogIssues.serialNumber } : {}),
                ...(catalogIssues.assetTagDefault ? { assetTagDefault: catalogIssues.assetTagDefault } : {}),
                ...(catalogIssues.macAddress ? { macAddress: catalogIssues.macAddress } : {})
              });
              return;
            }
            this._saveGadget(gadget, raw);
            m.close();
          }
        }
      ]
    });
    modal.open();
    form.focusFirst();
  }

  _saveGadget(gadget, raw) {
    const serial = (raw.serialNumber || '').trim();

    // Once linked, stays linked — the whole point of the bidirectional
    // sync (core/InventoryGadgetSync.js's syncInventoryAssetFromGadget,
    // called below) is that editing the serial here *corrects* the
    // linked InventoryAsset's serial to match, not that a changed serial
    // goes looking for some other record to attach to instead. Only an
    // unlinked gadget (inventoryAssetId null — legacy data, or its old
    // link was cleared when that InventoryAsset was deleted; see
    // schema.sql's `on delete set null`) re-derives it by serial match on
    // save, same opportunistic linking _catalogIssues() already required
    // an exact match for.
    let inventoryAssetId = gadget.inventoryAssetId || null;
    if (!inventoryAssetId && serial && this.inventoryAssetStore) {
      const matchedAsset = this.inventoryAssetStore.list().find((a) => (a.serialNumber || '').trim() === serial);
      inventoryAssetId = matchedAsset ? matchedAsset.id : null;
    }

    // Merchant/positionType/warehouse/owner/pendingTransfer are deliberately
    // absent from this payload: Edit asset no longer touches them at
    // all — Store.update() only patches the keys it's given (see
    // core/Store.js), so whatever the gadget's current placement is stays
    // exactly as-is. The only way any of those five fields ever change now
    // is through the Manifest / Transmittal flow (ManifestModal.js's
    // applyMerchantTransfer) and the confirm/cancel actions that follow a
    // pending one — this form has no say over them any more.
    const payload = {
      user: raw.user,
      role: raw.role,
      category: raw.category || 'Uncategorized',
      serialNumber: raw.serialNumber,
      macAddress: raw.macAddress,
      warehouseAssetTag: raw.warehouseAssetTag,
      assetTagDefault: raw.assetTagDefault,
      password: raw.password,
      remarks: raw.remarks,
      description: raw.description,
      inventoryAssetId
    };

    this._logFieldChanges(gadget, payload);
    this.store.update(gadget.id, payload);
    // Pushes Category/Serial Number/Asset Tag/MAC Address onto the linked
    // InventoryAsset row, if any — the other half of the bidirectional
    // sync InventoryAssetController's own _saveAsset already does in
    // reverse (syncGadgetsFromInventoryAsset). Built from `payload`
    // rather than re-reading `gadget`, since `gadget` is the pre-save
    // instance and would push stale values.
    if (this.inventoryAssetStore) {
      syncInventoryAssetFromGadget({
        inventoryAssetId,
        category: payload.category,
        serialNumber: payload.serialNumber,
        assetTagDefault: payload.assetTagDefault,
        macAddress: payload.macAddress
      }, this.inventoryAssetStore);
    }
    Toast.success(`Saved changes for ${payload.user || 'this asset'}.`);
  }

  /**
   * Compares the record's current values against the incoming payload
   * *before* the store overwrites them, and writes typed log entries so
   * LogModal's Users/Remarks tabs have something to show. Merchant/
   * warehouse transfers are logged separately, at the point they actually
   * happen (ManifestModal.js's applyMerchantTransfer, and
   * confirmTransfer/cancelPendingTransfer below) — Add/Edit asset no
   * longer changes either, so there's nothing transfer-related left for
   * this to compare.
   */
  _logFieldChanges(gadget, payload) {
    if (gadget.user !== payload.user) {
      const from = gadget.user || 'Unassigned';
      const to = payload.user || 'Unassigned';
      gadget.addLogEntry(`Reassigned from ${from} to ${to}.`, 'user', { from, to }, getOperatorName());
    }
    if (gadget.remarks !== payload.remarks) {
      gadget.addLogEntry(payload.remarks ? `Remarks updated: "${payload.remarks}"` : 'Remarks cleared.', 'remarks', null, getOperatorName());
    }
    const otherFieldsChanged = ['role', 'category', 'serialNumber', 'macAddress', 'warehouseAssetTag', 'assetTagDefault', 'password', 'description']
      .some((key) => gadget[key] !== payload[key]);
    if (otherFieldsChanged) {
      gadget.addLogEntry('Asset details updated.', 'update', null, getOperatorName());
    }
  }

  /**
   * True when the signed-in session may confirm or cancel this gadget's
   * pending transfer: their group has been explicitly granted
   * manage.confirm-transfers — full stop, same single-permission gate as
   * every other action in this tree (manage.edit, manage.delete,
   * manage.adjust-position, ...). No implicit bypass for being scoped to
   * the destination warehouse: warehouse scope (core/WarehouseScope.js)
   * already controls a separate thing — which pending transfers show up
   * in the grid at all (see _filteredSortedGadgets's allowedOwners/
   * pendingToOwner check) — not what you're allowed to *do* with the
   * ones you can see. Folding scope into this action-level check meant
   * an unrestricted group (no boundWarehouseIds set — the common,
   * default case) passed isWarehouseAllowed() for every warehouse
   * automatically, letting anyone confirm/cancel regardless of what
   * Confirm transfers was actually set to.
   */
  _canActOnPendingTransfer(gadget) {
    if (!gadget.pendingTransfer) return false;
    return can('manage.confirm-transfers');
  }

  /** Applies a pending transfer: writes merchant/positionType/warehouse/owner from the
   * stashed request and clears it. See models/Gadget.js's pendingTransfer for the shape.
   * `silent` skips the per-item Toast — used by _confirmSelectedTransfers so confirming
   * a few hundred rows doesn't also queue a few hundred toasts; the bulk caller shows one
   * combined message instead. */
  confirmTransfer(id, { silent = false } = {}) {
    const gadget = this.store.get(id);
    if (!gadget || !gadget.pendingTransfer) return;
    if (!this._canActOnPendingTransfer(gadget)) {
      if (!silent) Toast.error('You do not have Confirm transfers access.');
      return;
    }
    const p = gadget.pendingTransfer;
    gadget.addLogEntry(
      `Transfer confirmed: merchant '${gadget.merchant || 'None'}' → '${p.toMerchant}'. Resolved to ${p.toPositionType || 'Unassigned'} · ${p.toWarehouse || '—'} · ${p.toOwner || '—'}.`,
      'transfer',
      { from: gadget.merchant || '', to: p.toMerchant },
      getOperatorName()
    );
    this.store.update(gadget.id, {
      merchant: p.toMerchant,
      positionType: p.toPositionType,
      warehouse: p.toWarehouse,
      owner: p.toOwner,
      pendingTransfer: null
    });
    if (!silent) Toast.success(`Transfer to '${p.toMerchant}' confirmed.`);
  }

  /** Withdraws a pending transfer without applying it — merchant/positionType/warehouse/
   * owner are untouched, exactly as if the request had never been made. If the pending
   * transfer carries a `previousUser` (only set when it was created alongside issuing the
   * asset to a person — see ProcessRequestModal.js's applyProcessing), the user is put
   * back to that value too, since issuing-and-transferring was one combined action and
   * cancelling undoes both halves. That restore is written directly through store.update
   * rather than through _logFieldChanges' "Reassigned from X to Y" ('user'-type) log entry
   * — Gadget.getLastResponsible() reads the *last* 'user' log entry as "recent
   * responsible", and a cancelled, never-actually-completed handoff shouldn't count as
   * one. A plain Manifest merchant transfer never sets `previousUser`, so this leaves
   * `user` alone for that case, same as before. Open to the same people who can confirm,
   * plus manage.edit.merchant holders (the same permission that could have requested it in
   * the first place, so they can also take it back). `silent` — see confirmTransfer's own
   * doc comment just above. */
  cancelPendingTransfer(id, { silent = false } = {}) {
    const gadget = this.store.get(id);
    if (!gadget || !gadget.pendingTransfer) return;
    if (!this._canActOnPendingTransfer(gadget) && !can('manage.edit.merchant')) {
      if (!silent) Toast.error('You do not have permission to cancel this transfer.');
      return;
    }
    const p = gadget.pendingTransfer;
    const restoresUser = Object.prototype.hasOwnProperty.call(p, 'previousUser');
    gadget.addLogEntry(
      `Transfer to '${p.toMerchant}' cancelled before confirmation.${restoresUser ? ` User reassignment undone — reverted to '${p.previousUser || 'Unassigned'}'.` : ''}`,
      'transfer',
      { from: p.toMerchant, to: gadget.merchant || '' },
      getOperatorName()
    );
    this.store.update(gadget.id, {
      pendingTransfer: null,
      ...(restoresUser ? { user: p.previousUser } : {})
    });
    if (!silent) Toast.show(`Pending transfer to '${p.toMerchant}' cancelled.`);
  }

  /** Row-action entry point for Confirm: asks first, since this is the one click that
   * actually moves the asset (changes merchant/warehouse/owner), same weight as Delete. */
  async _confirmTransferWithPrompt(id) {
    const gadget = this.store.get(id);
    if (!gadget?.pendingTransfer) return;
    const p = gadget.pendingTransfer;
    const ok = await confirmDialog({
      title: 'Confirm receipt',
      message: `Confirm this asset has arrived at '${p.toMerchant}' (${p.toPositionType || 'Unassigned'} · ${p.toWarehouse || '—'} · ${p.toOwner || '—'})? This will finalize the transfer.`,
      confirmLabel: 'Confirm receipt'
    });
    if (ok) this.confirmTransfer(id);
  }

  /** Row-action entry point for Cancel — a lighter prompt than Confirm's, since cancelling
   * is reversible (the merchant can just be transferred again) where confirming isn't. */
  async _cancelTransferWithPrompt(id) {
    const gadget = this.store.get(id);
    if (!gadget?.pendingTransfer) return;
    const p = gadget.pendingTransfer;
    const ok = await confirmDialog({
      title: 'Cancel pending transfer',
      message: `Cancel the pending transfer to '${p.toMerchant}'? The asset will stay at its current merchant.`,
      confirmLabel: 'Cancel transfer',
      danger: true
    });
    if (ok) this.cancelPendingTransfer(id);
  }

  /**
   * Bulk sibling of _confirmTransferWithPrompt — one confirm dialog, then
   * confirmTransfer() run silently across every checked, actionable row
   * (see _selectedPendingTransferGadgets), with a single summary Toast at
   * the end instead of one per row. Each call still re-checks
   * _canActOnPendingTransfer/pendingTransfer for itself, so a row that
   * changed out from under the selection between opening the dialog and
   * confirming (someone else confirms/cancels it first, a live update
   * from another tab, etc.) is simply skipped rather than mis-applied —
   * the summary count reflects what actually happened, not what was
   * requested.
   *
   * this._bulkTransferInProgress mutes the store's own change → render
   * loop for the duration (see the this.store.on('change', ...)
   * subscription up in the constructor) so a few hundred sequential
   * store.update() calls don't also trigger a few hundred full grid
   * re-renders; render() is invoked once, manually, right after.
   */
  async _confirmSelectedTransfers() {
    const gadgets = this._selectedPendingTransferGadgets();
    if (gadgets.length === 0) return;
    const ok = await confirmDialog({
      title: 'Confirm receipt',
      message: `Confirm ${gadgets.length} asset${gadgets.length === 1 ? '' : 's'} arrived at ${gadgets.length === 1 ? 'its requested transfer destination' : 'their requested transfer destinations'}? This will finalize ${gadgets.length === 1 ? 'that transfer' : 'these transfers'}.`,
      confirmLabel: `Confirm ${gadgets.length} transfer${gadgets.length === 1 ? '' : 's'}`
    });
    if (!ok) return;

    this._bulkTransferInProgress = true;
    let confirmed = 0;
    gadgets.forEach((g) => {
      const before = this.store.get(g.id)?.pendingTransfer;
      this.confirmTransfer(g.id, { silent: true });
      if (before) confirmed++;
    });
    this._bulkTransferInProgress = false;
    this.render();

    Toast.success(`${confirmed} transfer${confirmed === 1 ? '' : 's'} confirmed.`);
  }

  /** Bulk sibling of _cancelTransferWithPrompt — see _confirmSelectedTransfers's own doc
   * comment just above for the shape (single dialog, silent per-row calls, one render). */
  async _cancelSelectedTransfers() {
    const gadgets = this._selectedCancellableTransferGadgets();
    if (gadgets.length === 0) return;
    const ok = await confirmDialog({
      title: 'Cancel pending transfers',
      message: `Cancel the pending transfer on ${gadgets.length} asset${gadgets.length === 1 ? '' : 's'}? ${gadgets.length === 1 ? 'It' : 'They'} will stay at ${gadgets.length === 1 ? 'its' : 'their'} current merchant.`,
      confirmLabel: `Cancel ${gadgets.length} transfer${gadgets.length === 1 ? '' : 's'}`,
      danger: true
    });
    if (!ok) return;

    this._bulkTransferInProgress = true;
    let cancelled = 0;
    gadgets.forEach((g) => {
      const before = this.store.get(g.id)?.pendingTransfer;
      this.cancelPendingTransfer(g.id, { silent: true });
      if (before) cancelled++;
    });
    this._bulkTransferInProgress = false;
    this.render();

    Toast.show(`${cancelled} pending transfer${cancelled === 1 ? '' : 's'} cancelled.`);
  }

  /**
   * Opens the Manifest / Transmittal preview for the currently checked
   * rows, in the same order they appear in the (filtered/sorted) table
   * rather than Set insertion order.
   */
  openManifestModal() {
    if (!can('manage.preview-manifest')) return;
    if (this.selected.size === 0) return;
    const gadgets = this._filteredSortedGadgets().filter((g) => this.selected.has(g.id));
    showManifestModal({ gadgets, store: this.store, locationStore: this.locationStore, warehouseStore: this.warehouseStore });
  }

  /**
   * Opens the Process Request document — same print-then-confirm shape
   * as openManifestModal() above, and the same "Transfer to" location-
   * resolution/pending-transfer handling too: it pairs whatever's
   * checked in the grid with a pending Requisition, issues those assets
   * to that requester (applied immediately — nothing to confirm about a
   * person having their own unit in hand), and requests their transfer
   * to wherever "Transfer to" resolves to (queued as a pendingTransfer
   * for that destination warehouse to confirm, exactly like a Manifest
   * transfer). Unlike Manifest, no asset selection is required to open
   * it — gated only on there being a pending Requisition to work from
   * (see _updateSelectionActions); the document opens with a blank row
   * ready to fill in by hand if nothing's checked. Replaces the old
   * "Process request" action that used to live on each row of Recent
   * Requisitions (Requisition tab), which auto-picked matching stock
   * with no preview step; this is the same underlying issuance, now
   * driven from Manage so exactly the physical units chosen here — if
   * any — are the ones issued and recorded.
   */
  openProcessRequestModal() {
    if (!can('manage.process-request')) return;
    const requisitions = this.requisitionStore ? this.requisitionStore.list() : [];
    if (!requisitions.some((r) => r.status !== 'finished')) return; // button is disabled for this case too — belt-and-suspenders
    // Unlike Manifest, an asset selection isn't required to open this —
    // ProcessRequestModal falls back to a single blank row when nothing's
    // checked, same as it already does for any hand-added row beyond the
    // selection. Whatever *is* checked still pre-fills, same as before.
    const gadgets = this._filteredSortedGadgets().filter((g) => this.selected.has(g.id));
    showProcessRequestModal({
      gadgets,
      requisitions,
      gadgetStore: this.store,
      requisitionStore: this.requisitionStore,
      locationStore: this.locationStore,
      warehouseStore: this.warehouseStore
    });
  }

  /**
   * "Adjust Position" only makes sense with a selection (it acts on the
   * checked rows), so it opens a menu rather than a single action — even
   * though it's currently down to one entry (park the batch somewhere
   * temporary). Warehouse transfers no longer live here: they only
   * happen through the Manifest / Transmittal flow's merchant-driven
   * placement (ManifestModal.js), which is the one path that logs the
   * move and makes it receivable via confirmTransfer/cancelPendingTransfer.
   */
  _openAdjustPositionMenu() {
    if (!can('manage.adjust-position')) return;
    if (this.selected.size === 0) return;
    openDropdownMenu({
      anchor: this.refs.transferItemBtn,
      items: [
        { label: 'Transfer to temporary bin', onClick: () => this.openTemporaryBinModal() }
      ]
    });
  }

  /**
   * Bulk-moves the selected assets into a temporary holding position
   * (returns processing, defective/damage staging, etc.) — separate from
   * their normal `warehouse`. Every row needs its own position type
   * picked before Confirm enables, since "move everything to the same
   * bin" isn't generally what a mixed batch actually needs.
   *
   * Description is a secondary, optional override per row: the input
   * starts blank (showing the current description as a placeholder hint
   * rather than a value), so a blank field on Confirm leaves that
   * asset's description untouched — only a non-blank entry replaces it.
   */
  openTemporaryBinModal() {
    if (this.selected.size === 0) return;
    const gadgets = this._filteredSortedGadgets().filter((g) => this.selected.has(g.id));

    const node = el(`
      <div class="tempbin-modal">
        <p class="hint">Move the selected assets into a temporary holding position. Choose a position type for every row, then Confirm. Description is optional — leave it blank to keep each asset's current description, or type a new one to override it.</p>
        <div class="grid-scroll">
          <table>
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Serial Number</th>
                <th>Asset Tag (Default)</th>
                <th>Move to temporary bin</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    `);

    const tbody = node.querySelector('tbody');
    tbody.innerHTML = gadgets.map((g) => `
      <tr data-id="${g.id}">
        <td data-label="Merchant"><div>${g.merchant ? esc(g.merchant) : '—'}</div></td>
        <td data-label="Serial Number"><div>${g.serialNumber ? esc(g.serialNumber) : '—'}</div></td>
        <td data-label="Asset Tag (Default)"><div>${g.assetTagDefault ? esc(g.assetTagDefault) : '—'}</div></td>
        <td data-label="Move to temporary bin">
          <select data-field="positionType" required>
            <option value="" disabled hidden selected>Position Type</option>
            ${TEMP_POSITION_TYPES.map((t) => `<option value="${t.value}">${esc(t.label)}</option>`).join('')}
          </select>
        </td>
        <td data-label="Description">
          <div><input type="text" data-field="description" value="" placeholder="${g.description ? esc(g.description) : 'Leave blank to keep unchanged'}"></div>
        </td>
      </tr>
    `).join('');

    let confirmBtn = null;
    const isReady = () => [...tbody.querySelectorAll('select[data-field="positionType"]')].every((s) => s.value !== '');
    const updateConfirmState = () => {
      if (!confirmBtn) return;
      const ready = isReady();
      confirmBtn.disabled = !ready;
      confirmBtn.title = ready ? '' : 'Choose a position type for every row first.';
    };
    tbody.querySelectorAll('select[data-field="positionType"]').forEach((s) => {
      enhanceSelect(s);
      s.addEventListener('change', updateConfirmState);
    });

    const modal = new Modal({
      title: 'Move to temporary bin',
      body: node,
      size: 'lg',
      footer: [
        { label: 'Cancel', variant: 'btn-outline', onClick: (m) => m.close() },
        {
          label: 'Confirm',
          variant: 'btn-accent',
          onClick: (m) => {
            if (!isReady()) return; // belt-and-suspenders — the button is disabled anyway
            let count = 0;
            tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
              const gadget = this.store.get(tr.getAttribute('data-id'));
              if (!gadget) return;
              const value = tr.querySelector('select[data-field="positionType"]').value;
              const descriptionOverride = tr.querySelector('input[data-field="description"]').value.trim();

              const patch = {};
              let changed = false;

              if (gadget.temporaryPosition !== value) {
                const fromLabel = temporaryPositionLabel(gadget.temporaryPosition);
                const toLabel = temporaryPositionLabel(value);
                gadget.addLogEntry(
                  `Transferred position from '${fromLabel}' to '${toLabel}'.`,
                  'transfer',
                  { from: gadget.temporaryPosition, to: value },
                  getOperatorName()
                );
                patch.temporaryPosition = value;
                changed = true;
              }

              // Blank means "leave the description as-is" — only a
              // non-blank override actually replaces it.
              if (descriptionOverride && descriptionOverride !== gadget.description) {
                gadget.addLogEntry(`Description updated: "${descriptionOverride}"`, 'update', null, getOperatorName());
                patch.description = descriptionOverride;
                changed = true;
              }

              if (changed) {
                this.store.update(gadget.id, patch);
                count++;
              }
            });
            if (count > 0) Toast.success(`Updated ${count} asset${count === 1 ? '' : 's'}.`);
            m.close();
          }
        }
      ]
    });

    confirmBtn = modal.footEl.querySelector('.btn-accent');
    updateConfirmState();
    modal.open();
  }

  viewLog(id) {
    if (!can('manage.view-log')) return;
    const gadget = this.store.get(id);
    if (!gadget) return;
    openLogModal({
      title: `History — ${gadget.serialNumber || gadget.assetTagDefault || 'Unassigned asset'}`,
      entries: gadget.history
    });
  }

  async deleteGadget(id) {
    if (!can('manage.delete')) return;
    const gadget = this.store.get(id);
    if (!gadget) return;
    const ok = await confirmDialog({
      title: 'Remove asset',
      message: `Remove the asset assigned to "${gadget.user || 'Unassigned'}" from inventory? This cannot be undone.`,
      confirmLabel: 'Remove',
      danger: true
    });
    if (!ok) return;
    this.store.delete(id);
    this.selected.delete(id);
    Toast.show(`Removed asset for ${gadget.user || 'Unassigned'}.`);
  }

  /** Bulk sibling of deleteGadget() above — same confirm-then-delete
   * shape as Inventory Assets' own _deleteSelected(), just without that
   * one's cascade (a Manage row deleted here has no matching Inventory
   * Assets record to clean up — the FK only ever runs the other way; see
   * core/InventoryGadgetSync.js's own header comment). Exists so a batch
   * of assets — most commonly ones _catalogIssuesById() is already
   * flagging with ⚠ because their Inventory Assets record was cleared or
   * removed out from under them — can be cleared in one confirm instead
   * of one row/one dialog at a time. Deliberately doesn't auto-select or
   * auto-delete "everything with a catalog issue" on its own: a catalog
   * mismatch can also mean a stale field on an asset that's still very
   * much in active use, so it stays an explicit, reviewable selection
   * (helped along by _selectAllFiltered() below) rather than a one-click
   * purge of anything flagged. */
  async _deleteSelected() {
    if (!can('manage.delete')) return;
    const count = this.selected.size;
    if (count === 0) return;
    const ok = await confirmDialog({
      title: 'Delete selected assets',
      message: `Delete ${count} selected ${count === 1 ? 'asset' : 'assets'} from Manage? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true
    });
    if (!ok) return;
    const ids = [...this.selected];
    ids.forEach((id) => this.store.delete(id));
    this.selected.clear();
    Toast.show(`Deleted ${count} ${count === 1 ? 'asset' : 'assets'}.`);
  }

  /** "Select all N filtered assets" — the footer link shown once every
   * row on the current page is checked and more still match the active
   * filters (see render()'s own allPageSelected/allFilteredSelected).
   * The page-level select-all checkbox only ever reaches rows actually
   * rendered on screen (see _toggleSelectAll), so without this a search
   * matching hundreds of rows across several pages would mean paging
   * through each one to build up a selection before Delete selected (or
   * any other bulk action) could touch all of them at once. */
  _selectAllFiltered() {
    this._filteredSortedGadgets().forEach((g) => this.selected.add(g.id));
    this.render();
  }

  /** Clears the current selection outright — the footer's other new
   * link, next to "Select all N filtered", for backing out of a large
   * selection without unchecking rows one by one or reloading the tab. */
  _clearSelection() {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.render();
  }

  /** Plain export when nothing's selected (only one sensible option); a dropdown to choose between all/selected once something is. */
  _openExportMenu() {
    if (this.selected.size === 0) {
      this.exportCsv();
      return;
    }
    openDropdownMenu({
      anchor: this.refs.exportBtn,
      items: [
        { label: 'Export all', onClick: () => this.exportCsv() },
        { label: `Export selected (${this.selected.size})`, onClick: () => this.exportCsv({ selectedOnly: true }) }
      ]
    });
  }

  exportCsv({ selectedOnly = false } = {}) {
    const filtered = this._filteredSortedGadgets();
    const gadgets = selectedOnly ? filtered.filter((g) => this.selected.has(g.id)) : filtered;
    if (gadgets.length === 0) {
      Toast.show(selectedOnly ? 'No selected assets to export.' : 'There is nothing to export.');
      return;
    }
    // Password is intentionally excluded from CSV export to avoid writing
    // plaintext credentials to disk.
    const headers = ['User', 'Role', 'Category', 'Serial Number', 'Warehouse Asset Tag', 'Asset Tag (Default)', 'MAC Address', 'Merchant', 'Owner', 'Remarks', 'Description', 'Warehouse', 'Created', 'Last Updated'];
    const rows = gadgets.map((g) => [
      g.user, g.role, g.category, g.serialNumber, g.warehouseAssetTag, g.assetTagDefault,
      g.macAddress, g.merchant, g.owner, g.remarks, g.description, g.warehouse, fmtLocalDateTime(g.createdAt), fmtLocalDateTime(g.updatedAt)
    ]);
    // Every column text-forced except the two date/time ones — see
    // utils/csv.js's toCsv/escapeCell for why: opened straight in Excel,
    // a long digit string like a serial number or MAC/IMEI-shaped value
    // otherwise silently becomes scientific notation the moment the file
    // is opened, with no way to tell from the CSV alone that it happened.
    const csv = toCsv(headers, rows, { plainHeaders: ['Created', 'Last Updated'] });
    downloadCsv(csv, `stockroom-assets${selectedOnly ? '-selected' : ''}-${fmtLocalDateStamp()}.csv`);
    Toast.success(`Exported ${gadgets.length} ${selectedOnly ? 'selected ' : ''}asset${gadgets.length === 1 ? '' : 's'} to CSV.`);
  }
}