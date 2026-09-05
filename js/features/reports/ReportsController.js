import { effectivePositionLabel } from '../../models/Gadget.js';
import { openDropdownMenu } from '../../components/DropdownMenu.js';
import { openDateRangePicker } from '../../components/DateRangePicker.js';
import { Modal } from '../../components/Modal.js';
import { Toast } from '../../components/Toast.js';
import { toCsv, downloadCsv } from '../../utils/csv.js';
import { fmtLocalDateStamp, fmtLocalDateTime } from '../../utils/format.js';
import { TYPE_LABEL } from '../settings/WarehouseLocationModal.js';
import { esc, el } from '../../utils/dom.js';
import { isWarehouseAllowed, isWarehouseScoped } from '../../core/WarehouseScope.js';

/** Labels for Gadget.addLogEntry's `type` values, for the "Activity by
 * Type" breakdown shown in a date-ranged export — same categories
 * LogModal's own tabs use, plus the two types LogModal lumps into "All"
 * (create/update) spelled out here since a standalone report has no tab
 * to fall back on. */
const ACTIVITY_TYPE_LABELS = {
  create: 'Asset Added',
  transfer: 'Transfer',
  user: 'User Reassignment',
  remarks: 'Remarks Update',
  update: 'Other Update'
};
function activityTypeLabel(type) {
  return ACTIVITY_TYPE_LABELS[type] || (type ? type[0].toUpperCase() + type.slice(1) : 'Other Update');
}

/** The checkbox list "Export summary" opens before downloading — one entry
 * per breakdown card on the dashboard (Warehouse Locations bundles both
 * location cards — "by Type" is a count of location records, "by
 * Merchant" is a count of gadgets currently placed at each merchant/
 * location — since they're one topic to a reader deciding what to
 * include). `rows(ctrl, scope)` returns this category's own CSV rows,
 * where `scope` is whichever gadgets/inventory assets/locations
 * _exportSummary already narrowed down — to "everything right now" when
 * no date range is set, or to "created within the picked range" when one
 * is, so every category (not just Recent Activity) can answer either
 * "what does this look like today" or "what got added this period"
 * depending on that one shared setting.
 *
 * `header` is this category's own CSV column row — each category gets
 * its own header block in the export (see _exportSummary's `blocks`)
 * rather than every category sharing one generic `Section, Label, Count,
 * Assigned, Date` row, so a reader opening e.g. a Gadgets-by-Warehouse-
 * only export sees "Allocation", not a vague "Label" that only makes
 * sense once you know which section you're looking at. `rows()` below
 * must emit exactly as many fields as `header` has columns. */
const EXPORT_CATEGORIES = [
  {
    key: 'category',
    label: 'Gadgets by Category',
    header: ['Section', 'Category', 'Count', 'Assigned'],
    rows: (ctrl, { gadgets }) => ctrl._categoryBreakdownWithAssigned(gadgets)
      .map((r) => ['Gadgets by Category', r.label, r.count, r.assigned])
  },
  {
    key: 'warehouse',
    label: 'Gadgets by Warehouse',
    header: ['Section', 'Allocation', 'Count'],
    rows: (ctrl, { gadgets }) => ctrl._countBy(gadgets, (g) => g.warehouse || 'Unassigned')
      .map((r) => ['Gadgets by Warehouse', r.label, r.count])
  },
  {
    key: 'position',
    label: 'Gadgets by Position Type',
    header: ['Section', 'Position', 'Count'],
    rows: (ctrl, { gadgets }) => ctrl._countBy(gadgets, (g) => ctrl._positionLabel(g))
      .map((r) => ['Gadgets by Position Type', r.label, r.count])
  },
  {
    key: 'inventoryAssets',
    label: 'Inventory Assets',
    header: ['Section', 'Category', 'Count'],
    rows: (ctrl, { inventoryAssets }) => ctrl._countBy(inventoryAssets, (a) => a.category || 'Uncategorized')
      .map((r) => ['Inventory Assets by Category', r.label, r.count])
  },
  {
    key: 'locations',
    label: 'Warehouse Locations',
    header: ['Section', 'Warehouse', 'Count'],
    rows: (ctrl, { gadgets, locations }) => [
      ...ctrl._countBy(locations, (loc) => TYPE_LABEL[loc.property] || loc.property || 'Unspecified')
        .map((r) => ['Warehouse Locations by Type', r.label, r.count]),
      ...ctrl._countBy(gadgets, (g) => g.merchant || 'Unassigned')
        .map((r) => ['Warehouse Locations by Merchant', r.label, r.count])
    ]
  }
];

/** The four Recent Activity types the export picker lets a reader
 * narrow to — same log types LogModal's own tabs split on (see
 * ACTIVITY_TYPE_LABELS above), just framed as an opt-in checklist rather
 * than tabs since a CSV export has no "switch tabs and re-export" step. */
const ACTIVITY_EXPORT_TYPES = [
  { key: 'create', label: 'Asset Added' },
  { key: 'transfer', label: 'Transfer Warehouse Location' },
  { key: 'user', label: 'Transfer Users' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'update', label: 'Other Updates' }
];

/** The one Requisition export toggle — kept as a {key,label} array (not a
 * single boolean) so the export picker's rendering code is identical to
 * ACTIVITY_EXPORT_TYPES's `.map()` above it, even though there's only one
 * entry: a Requisition submission has no "type" the way a Gadget history
 * entry does (create/transfer/user/remarks/update), so there's nothing
 * else to split it into. */
const REQUISITION_EXPORT_TYPES = [
  { key: 'requisitions', label: 'Requisitions Submitted' }
];

/**
 * ReportsController drives the read-only Reports tab: summary stat cards,
 * breakdown bars (by category / warehouse / position type), and a
 * cross-asset activity feed built from every Gadget's own history log.
 *
 * Unlike Manage/InventoryAssets/Settings, this controller never writes to
 * any store — it only reads store.list() and re-renders on 'change', the
 * same reactive pattern the other controllers use, just one-directional.
 */
export class ReportsController {
  constructor({ store, inventoryAssetStore, warehouseStore, locationStore, requisitionStore, view, refs }) {
    this.store = store; // Gadgets — the primary source for every card/breakdown here
    this.inventoryAssetStore = inventoryAssetStore;
    this.warehouseStore = warehouseStore;
    this.locationStore = locationStore;
    // Only read from at export time (see _exportSummary) — Requisitions
    // have no dashboard card of their own, so render() never touches
    // this the way it does the other stores above.
    this.requisitionStore = requisitionStore;
    this.view = view;
    this.refs = refs;
    // Same "Warehouse" side-tab filter as Manage: everything on this
    // dashboard narrows to one warehouse's assets when a filter is
    // active, 'all' otherwise. See _knownOwners() for why the flyout's
    // option list comes from Settings rather than from Gadget records.
    this.state = {
      filters: { owner: 'all' },
      // Which checkboxes were left checked last time the export picker was
      // opened, so re-opening it (e.g. to export twice in a row with the
      // same subset) doesn't reset back to "everything" every time.
      exportSelection: new Set([
        ...EXPORT_CATEGORIES.map((c) => c.key),
        ...ACTIVITY_EXPORT_TYPES.map((t) => t.key),
        ...REQUISITION_EXPORT_TYPES.map((r) => r.key)
      ]),
      // { startMs, endMs } | null — the picker's optional date range,
      // same shape _exportMonthlyReport used to take as arguments back
      // when this was a separate "Monthly report…" button. null means
      // "everything, right now" (a point-in-time snapshot); set means
      // every category narrows to records created in that window,
      // Activity narrows to entries logged in that window.
      exportDateRange: null
    };
  }

  init() {
    this.store.on('change', () => this.render());
    this.inventoryAssetStore?.on('change', () => this.render());
    this.warehouseStore?.on('change', () => this.render());
    this.locationStore?.on('change', () => this.render());
    this.refs?.warehouseFilterBtn?.addEventListener('click', () => this._openWarehouseFilterMenu());
    this.refs?.exportBtn?.addEventListener('click', () => this._openExportPicker());
    this.render();
  }

  render() {
    const gadgets = this._filteredGadgets();

    this.view.renderWarehouseFilterButton?.(this._knownOwners().length > 0, this._effectiveOwnerFilter());
    this.view.renderStats(this._stats(gadgets), {
      duplicateSerials: () => this._openDuplicateSerialsModal(gadgets)
    });
    this.view.renderCategoryBreakdown('reportByCategory', this._categoryBreakdownWithAssigned(gadgets));
    this.view.renderBreakdown('reportByWarehouse', this._countBy(gadgets, (g) => g.warehouse || 'Unassigned'));
    this.view.renderBreakdown('reportByPosition', this._countBy(gadgets, (g) => this._positionLabel(g)));
    this.view.renderBreakdown('reportByAssetCategory', this._countBy(this._inventoryAssets(), (a) => a.category || 'Uncategorized'));
    this.view.renderBreakdown('reportByLocationType', this._countBy(this._locations(), (loc) => TYPE_LABEL[loc.property] || loc.property || 'Unspecified'));
    this.view.renderBreakdown('reportByLocation', this._countBy(gadgets, (g) => g.merchant || 'Unassigned'));
    this.view.renderActivity(this._recentActivity(gadgets, 25));
  }

  /** Inventory Assets aren't warehouse-scoped, so the Warehouse filter
   * doesn't apply to this breakdown — it's a system-wide catalog count. */
  _inventoryAssets() {
    return this.inventoryAssetStore ? this.inventoryAssetStore.list() : [];
  }

  /** Warehouse Locations are scoped to the selected warehouse site — the
   * same "Warehouse" filter every other card on this dashboard already
   * respects — unlike Inventory Assets above. This is a real relationship,
   * not an approximation: a location's warehouseId always ties it to one
   * specific site (see WarehouseLocation.warehouseId), so "all locations
   * under Warehouse 1" is a precise, direct lookup. When warehouse-scoped
   * (see core/WarehouseScope.js), locations belonging to a warehouse
   * outside that scope are excluded even under "All". */
  _locations() {
    const all = this.locationStore ? this.locationStore.list() : [];
    if (!this.warehouseStore) return all;

    const scopedSiteIds = new Set(
      this.warehouseStore.list().filter((w) => isWarehouseAllowed(w.id)).map((w) => w.id)
    );
    let filtered = isWarehouseScoped() ? all.filter((loc) => scopedSiteIds.has(loc.warehouseId)) : all;

    const owner = this._effectiveOwnerFilter();
    if (owner === 'all') return filtered;

    const matchingSiteIds = new Set(
      this.warehouseStore.list().filter((w) => w.name === owner).map((w) => w.id)
    );
    return filtered.filter((loc) => matchingSiteIds.has(loc.warehouseId));
  }

  /** Every gadget, or just the ones owned by the selected warehouse when a
   * filter is active — plus, when warehouse-scoped, always restricted to
   * the session's bound warehouses regardless of the "All"/single-owner
   * selection (see ManageController._filteredSortedGadgets for the same
   * pattern, including why an unassigned gadget is never excluded by
   * scope even though 'Unassigned' isn't itself a bound warehouse). */
  _filteredGadgets() {
    const all = this.store.list();
    const owner = this._effectiveOwnerFilter();
    const allowedOwners = isWarehouseScoped() ? new Set(this._knownOwners()) : null;

    return all.filter((g) => {
      const ownerKey = g.owner || 'Unassigned';
      if (allowedOwners && ownerKey !== 'Unassigned' && !allowedOwners.has(ownerKey)) return false;
      if (owner !== 'all' && ownerKey !== owner) return false;
      return true;
    });
  }

  /**
   * Warehouse names for the side filter button's flyout — every real site
   * configured in Warehouse Information (Settings), same source Manage's
   * equivalent button uses, so a warehouse is filterable here the moment
   * it exists in Settings, even before any asset has been assigned to it.
   * Also where warehouse scoping is enforced for this dashboard — see
   * ManageController._knownOwners for the identical pattern.
   */
  _knownOwners() {
    if (!this.warehouseStore) return [];
    return this.warehouseStore.list()
      .filter((w) => isWarehouseAllowed(w.id))
      .map((w) => w.name).filter(Boolean).sort();
  }

  /** Same "lock to the one bound warehouse, no meaningless All" rule as
   * ManageController._effectiveOwnerFilter(). */
  _effectiveOwnerFilter() {
    const owners = this._knownOwners();
    if (isWarehouseScoped() && owners.length === 1) return owners[0];
    return this.state.filters.owner;
  }

  /** Opens the "Warehouse" button's flyout — same DropdownMenu pattern as Manage's equivalent. */
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
    this.render();
  }

  _positionLabel(g) {
    return effectivePositionLabel(g);
  }

  _stats(gadgets) {
    const unassigned = gadgets.filter((g) => !g.warehouse).length;
    const duplicateSerials = this._duplicateSerialCount(gadgets);
    return [
      { label: 'Total Gadgets', value: gadgets.length },
      { label: 'Inventory Assets', value: this.inventoryAssetStore ? this.inventoryAssetStore.list().length : 0 },
      { label: 'Warehouses', value: this._knownOwners().length },
      { label: 'Warehouse Locations', value: this._locations().length },
      { label: 'Unassigned Gadgets', value: unassigned, tone: unassigned ? 'warn' : null },
      { label: 'Duplicate Serials', value: duplicateSerials, tone: duplicateSerials ? 'bad' : null, key: 'duplicateSerials' }
    ];
  }

  /** Serial numbers (lowercased, trimmed) shared by more than one gadget —
   * same duplicate rule Manage's grid flags a record with, counted here as
   * the number of *serials* affected rather than the number of records. */
  /** Serial numbers shared by more than one gadget, grouped for the
   * duplicate-serials drill-down — each group keeps the gadgets' own
   * (non-lowercased) serial text plus every gadget that shares it. */
  _duplicateSerialGroups(gadgets) {
    const groups = new Map();
    gadgets.forEach((g) => {
      const key = (g.serialNumber || '').trim().toLowerCase();
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(g);
    });
    return [...groups.values()]
      .filter((list) => list.length > 1)
      .sort((a, b) => b.length - a.length);
  }

  _duplicateSerialCount(gadgets) {
    return this._duplicateSerialGroups(gadgets).length;
  }

  _countBy(gadgets, keyFn) {
    const counts = new Map();
    gadgets.forEach((g) => {
      const key = keyFn(g);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** Same shape as _countBy, plus how many of each category are actually
   * assigned to a user (g.user is set) — a deliberately different rule
   * from the Unassigned Gadgets stat above, which tracks warehouse
   * assignment instead. Kept separate from _countBy rather than
   * generalizing it, since every other card on this dashboard only ever
   * needs a single count per row. */
  _categoryBreakdownWithAssigned(gadgets) {
    const counts = new Map();
    gadgets.forEach((g) => {
      const label = g.category || 'Uncategorized';
      if (!counts.has(label)) counts.set(label, { count: 0, assigned: 0 });
      const entry = counts.get(label);
      entry.count++;
      if (g.user) entry.assigned++;
    });
    return [...counts.entries()]
      .map(([label, { count, assigned }]) => ({ label, count, assigned }))
      .sort((a, b) => b.count - a.count);
  }

  /** Flattens every gadget's own history log into one cross-asset feed,
   * newest first. A history entry on its own has no idea which asset it
   * belongs to (that's fine inside LogModal, which only ever shows one
   * gadget's log) — here, mixing every gadget's entries together, each one
   * needs a label attached so the feed reads sensibly. */
  _recentActivity(gadgets, limit) {
    const entries = [];
    gadgets.forEach((g) => {
      const assetLabel = g.user || g.serialNumber || g.category || 'Unnamed asset';
      (g.history || []).forEach((entry) => entries.push({ ...entry, assetLabel }));
    });
    return entries.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  /** Turns the inert "Duplicate Serials" count into something actionable:
   * which serial numbers are duplicated, and which assets share each one,
   * so it's actually clear what to go fix instead of just a number. */
  _openDuplicateSerialsModal(gadgets) {
    const groups = this._duplicateSerialGroups(gadgets);

    const body = groups.length === 0
      ? el('<div class="report-dup-modal"><p class="hint">No duplicate serial numbers right now.</p></div>')
      : el(`
        <div class="report-dup-modal">
          <p class="hint" style="margin-bottom:14px;">
            ${groups.length} serial number${groups.length === 1 ? '' : 's'} ${groups.length === 1 ? 'is' : 'are'} used by more than one asset.
          </p>
          ${groups.map((list) => `
            <div class="report-dup-group">
              <div class="report-dup-serial">${esc(list[0].serialNumber)}</div>
              <ul class="report-dup-list">
                ${list.map((g) => `<li>${esc(g.user || 'Unassigned')} — ${esc(g.category || 'Uncategorized')}${g.warehouse ? ` · ${esc(g.warehouse)}` : ''}</li>`).join('')}
              </ul>
            </div>
          `).join('')}
        </div>
      `);

    new Modal({
      title: 'Duplicate Serial Numbers',
      body,
      footer: [{ label: 'Close', variant: 'btn-outline', onClick: (m) => m.close() }]
    }).open();
  }

  /** Opens the "Select what to export" checklist — an optional date range
   * at the top (same DateRangePicker "Monthly report…" used to open on
   * its own button — see module doc), then one group of checkboxes per
   * breakdown card, plus a Recent Activity group broken down by log type.
   * Leaving the range as "All time" exports today's point-in-time
   * snapshot exactly like before; picking a range narrows every checked
   * category to records *created* in that window and Activity to entries
   * *logged* in it — one shared setting instead of a separate button and
   * a separate export format to keep in sync. Selections (and the range)
   * persist on `this.state` between opens. */
  _openExportPicker() {
    const body = el(`
      <div class="export-picker">
        <div class="export-picker-group">
          <h4>Date Range</h4>
          <div class="export-picker-daterange">
            <button tabindex="-1" type="button" class="btn btn-outline btn-sm" data-role="export-range-btn"></button>
            <button tabindex="-1" type="button" class="link-btn" data-role="export-range-clear" hidden>Clear</button>
          </div>
        </div>
        <div class="export-picker-group">
          <h4>Categories</h4>
          ${EXPORT_CATEGORIES.map((c) => `
            <label class="checkbox-inline export-picker-row">
              <input type="checkbox" data-export-key="${c.key}" ${this.state.exportSelection.has(c.key) ? 'checked' : ''}>
              <span>${esc(c.label)}</span>
            </label>
          `).join('')}
        </div>
        <div class="export-picker-group">
          <h4>Recent Activity</h4>
          ${ACTIVITY_EXPORT_TYPES.map((t) => `
            <label class="checkbox-inline export-picker-row">
              <input type="checkbox" data-export-key="${t.key}" ${this.state.exportSelection.has(t.key) ? 'checked' : ''}>
              <span>${esc(t.label)}</span>
            </label>
          `).join('')}
        </div>
        <div class="export-picker-group">
          <h4>Recent Requisitions</h4>
          ${REQUISITION_EXPORT_TYPES.map((r) => `
            <label class="checkbox-inline export-picker-row">
              <input type="checkbox" data-export-key="${r.key}" ${this.state.exportSelection.has(r.key) ? 'checked' : ''}>
              <span>${esc(r.label)}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `);

    const rangeBtn = body.querySelector('[data-role="export-range-btn"]');
    const rangeClearBtn = body.querySelector('[data-role="export-range-clear"]');
    const renderRangeLabel = () => {
      const range = this.state.exportDateRange;
      rangeBtn.textContent = range
        ? `${fmtLocalDateStamp(new Date(range.startMs))} – ${fmtLocalDateStamp(new Date(range.endMs))}`
        : 'All time';
      rangeClearBtn.hidden = !range;
    };
    renderRangeLabel();

    rangeBtn.addEventListener('click', () => {
      const range = this.state.exportDateRange;
      openDateRangePicker({
        anchor: rangeBtn,
        initialStart: range?.startMs ?? null,
        initialEnd: range?.endMs ?? null,
        onApply: (startMs, endMs) => {
          this.state.exportDateRange = { startMs, endMs };
          renderRangeLabel();
        }
      });
    });
    rangeClearBtn.addEventListener('click', () => {
      this.state.exportDateRange = null;
      renderRangeLabel();
    });

    const readSelection = () => new Set(
      [...body.querySelectorAll('[data-export-key]')]
        .filter((cb) => cb.checked)
        .map((cb) => cb.dataset.exportKey)
    );

    const modal = new Modal({
      title: 'Export Summary',
      body,
      footer: [
        { label: 'Cancel', variant: 'btn-outline', onClick: (m) => m.close() },
        {
          label: 'Export',
          variant: 'btn-accent',
          onClick: (m) => {
            const selected = readSelection();
            if (selected.size === 0) {
              Toast.show('Select at least one category to export.');
              return;
            }
            this.state.exportSelection = selected;
            const exported = this._exportSummary(selected, this.state.exportDateRange);
            if (exported) m.close();
          }
        }
      ]
    });
    modal.open();
  }

  /** Every submitted Requisition, newest-first — mirrors _recentActivity's
   * own "read straight from the store, let the caller filter/sort" shape.
   * Requisitions aren't Warehouse-scoped (nothing on the form ties a
   * request to one site), so — unlike gadgets/inventory assets/locations
   * — the current Warehouse filter never narrows this list. */
  _requisitions() {
    return this.requisitionStore ? [...this.requisitionStore.list()].sort((a, b) => b.createdAt - a.createdAt) : [];
  }

  /** Downloads a CSV built from whichever category and Recent Activity
   * checkboxes came back checked from _openExportPicker, either as a
   * point-in-time snapshot (range === null — every category reflects the
   * current state, same as before this picker gained a date range) or
   * scoped to `range` (every category narrows to records whose createdAt
   * falls inside it, Activity to entries logged inside it — the same
   * semantics the standalone "Monthly report…" button used to apply, just
   * generalized to every category instead of only the activity feed).
   * Returns false (and shows a Toast instead of downloading anything)
   * when a chosen range has nothing in it to report, so the caller knows
   * not to close the picker out from under an empty export. */
  _exportSummary(selected, range) {
    const allGadgets = this._filteredGadgets();
    const allInventoryAssets = this._inventoryAssets();
    const allLocations = this._locations();

    const inRange = (record) => !range || (record.createdAt >= range.startMs && record.createdAt <= range.endMs);
    const scope = {
      gadgets: range ? allGadgets.filter(inRange) : allGadgets,
      inventoryAssets: range ? allInventoryAssets.filter(inRange) : allInventoryAssets,
      locations: range ? allLocations.filter(inRange) : allLocations
    };

    const activityTypeKeys = new Set(ACTIVITY_EXPORT_TYPES.map((t) => t.key));
    const selectedActivityTypes = new Set([...selected].filter((k) => activityTypeKeys.has(k)));
    const activityEntries = this._recentActivity(allGadgets, Infinity)
      .filter((e) => selectedActivityTypes.has(e.type || 'update'))
      .filter((e) => !range || (e.timestamp >= range.startMs && e.timestamp <= range.endMs));

    const includeRequisitions = selected.has('requisitions');
    const requisitionEntries = includeRequisitions
      ? this._requisitions().filter((r) => !range || (r.createdAt >= range.startMs && r.createdAt <= range.endMs))
      : [];

    const selectedCategories = EXPORT_CATEGORIES.filter((c) => selected.has(c.key));
    if (range) {
      const nothingToReport = selectedCategories.every((c) => c.rows(this, scope).length === 0)
        && activityEntries.length === 0
        && requisitionEntries.length === 0;
      if (nothingToReport) {
        Toast.show('Nothing happened in that date range — no report to export.');
        return false;
      }
    }

    // Each section gets its own header + rows (a "block") instead of one
    // generic `Section, Label, Count, Assigned, Date` row shared by every
    // section — a block is only added when it actually has rows, so
    // ticking one lone checkbox produces a single clean table rather than
    // a stray header sitting over zero data. Blocks are stacked into one
    // CSV (see `blocks.map(...).join` below) separated by a blank line,
    // so exporting several sections at once still reads as distinct
    // tables rather than mixing e.g. warehouse names and position types
    // under one ambiguous column.
    const blocks = [];

    if (range) {
      blocks.push({
        header: ['Section', 'Field', 'Value'],
        rows: [
          ['Report Period', 'Start', fmtLocalDateStamp(new Date(range.startMs))],
          ['Report Period', 'End', fmtLocalDateStamp(new Date(range.endMs))],
          ['Report Period', 'Warehouse Filter', this._effectiveOwnerFilter() === 'all' ? 'All' : this._effectiveOwnerFilter()]
        ]
      });
    }

    selectedCategories.forEach((c) => {
      const rows = c.rows(this, scope);
      if (rows.length) blocks.push({ header: c.header, rows });
    });

    if (selectedActivityTypes.size > 0) {
      if (range) {
        const typeRows = this._countBy(activityEntries, (e) => activityTypeLabel(e.type))
          .map((r) => ['Activity by Type', r.label, r.count]);
        if (typeRows.length) blocks.push({ header: ['Section', 'Type', 'Count'], rows: typeRows });
      }
      // Asset/actor/timestamp are already separate fields on every entry
      // (see _recentActivity — assetLabel and performedBy are set
      // independently of message/timestamp), so they go straight into
      // their own Assets/Assigned/Date columns rather than being
      // concatenated into one "asset — by actor" string the way this
      // used to read under the old shared Assigned column.
      const activityRows = [...activityEntries]
        .sort((a, b) => (range ? a.timestamp - b.timestamp : b.timestamp - a.timestamp)) // ranged: oldest-first timeline; snapshot: newest-first, same as the dashboard feed
        .map((e) => ['Recent Activity', e.message, e.assetLabel, e.performedBy || 'Unknown', fmtLocalDateTime(e.timestamp)]);
      if (activityRows.length) {
        blocks.push({ header: ['Section', 'Label', 'Assets', 'Assigned', 'Date'], rows: activityRows, plainHeaders: ['Date'] });
      }
    }

    if (includeRequisitions) {
      const requisitionRows = [];
      [...requisitionEntries]
        .sort((a, b) => (range ? a.createdAt - b.createdAt : b.createdAt - a.createdAt)) // same ranged-vs-snapshot ordering as Recent Activity above
        .forEach((r) => {
          const itemsSummary = r.items.map((i) => `${i.category} × ${i.qty}`).join(', ') || 'No items';
          requisitionRows.push([
            'Recent Requisitions',
            r.requesterName || 'Unnamed requester',
            itemsSummary,
            `${r.purpose || 'No purpose given'} — by ${r.submittedBy || 'Unknown'}`,
            fmtLocalDateTime(r.createdAt)
          ]);
          requisitionRows.push(...this._servedRowsForExport(r));
        });
      if (requisitionRows.length) {
        blocks.push({ header: ['Section', 'Label', 'Count', 'Assigned', 'Date'], rows: requisitionRows, plainHeaders: ['Date'] });
      }
    }

    // Only reachable outside a date range (the `range` branch above already
    // guards this case) — e.g. the only checkbox left checked is an
    // Activity type with zero matching entries right now. Since every
    // block is now its own header, an empty `blocks` array has no header
    // row to fall back on the way the old single-shared-header CSV did,
    // so this needs its own explicit check rather than silently
    // downloading a blank file.
    if (blocks.length === 0) {
      Toast.show('Nothing to export for the selected categories.');
      return false;
    }

    const filename = range
      ? `stockroom-report-${fmtLocalDateStamp(new Date(range.startMs))}-to-${fmtLocalDateStamp(new Date(range.endMs))}.csv`
      : `stockroom-report-${fmtLocalDateStamp()}.csv`;
    // Each block renders as its own header + rows via toCsv, then blocks
    // are joined with a blank line between them — a plain CSV has no
    // native concept of "multiple tables", but a blank row between
    // differently-shaped header blocks is exactly how Excel/Sheets expect
    // to see one file hold several distinct tables.
    const csv = blocks
      .map((b) => toCsv(b.header, b.rows, { plainHeaders: b.plainHeaders || [] }))
      .join('\r\n\r\n');
    downloadCsv(csv, filename);
    Toast.success(`Exported ${selectedCategories.length} categor${selectedCategories.length === 1 ? 'y' : 'ies'}${range ? ` for ${fmtLocalDateStamp(new Date(range.startMs))} to ${fmtLocalDateStamp(new Date(range.endMs))}` : ''} to CSV.`);
    return true;
  }

  /** One CSV row per item Process Request actually issued against a
   * finished requisition — the export's counterpart to "Actually Served"
   * in RequisitionController._openFulfillmentLog (same section, just
   * flattened to CSV rows instead of a table). Same live-vs-snapshot
   * fallback as that modal: prefer the current Gadget when `gadgetId`
   * still resolves (via `this.store`, the Gadget store every other card
   * on this dashboard already reads from) — picking up anything that's
   * changed since issuance, like a pending transfer that's since been
   * confirmed — and fall back to the frozen `fulfilledItems` snapshot
   * recorded at issue time otherwise, which is the *only* data available
   * for a hand-typed row (no backing Gadget to begin with — e.g. a power
   * cable that isn't tracked as its own serialized asset) or a real asset
   * since deleted from Manage. Returns [] for a requisition that isn't
   * finished, was finished by hand (no items ever recorded), or — for a
   * requisition finished before `fulfilledItems` existed — one whose
   * `fulfilledGadgetIds` no longer resolve to anything in Manage.
   *
   * Each row's Date column is `requisition.servedAt` — when Process
   * Request actually issued this batch (see ProcessRequestModal.js's
   * applyProcessing, the only writer of that field) — blank for a
   * requisition finished before servedAt existed, since there's nothing
   * to report for those.
   */
  _servedRowsForExport(requisition) {
    if (requisition.status !== 'finished') return [];
    const hasSnapshots = (requisition.fulfilledItems || []).length > 0;
    const items = hasSnapshots
      ? requisition.fulfilledItems
      : (requisition.fulfilledGadgetIds || []).map((gid) => ({ gadgetId: gid }));
    const servedAt = requisition.servedAt ? fmtLocalDateTime(requisition.servedAt) : '';

    const rows = [];
    items.forEach((item) => {
      const live = item.gadgetId ? this.store.get(item.gadgetId) : null;
      const hasSnapshot = Boolean(item.category || item.serialNumber || item.user || item.merchant);
      if (item.gadgetId && !live && !hasSnapshot) return; // legacy id-only entry, asset gone — nothing to show
      const source = live || item;
      // No Gadget Type recorded means no asset was actually picked for
      // this row — see RequisitionController._openFulfillmentLog's own
      // identical skip for why this isn't a real served item.
      if (!source.category) return;
      rows.push([
        'Recent Requisitions — Served',
        requisition.requesterName || 'Unnamed requester',
        source.category || 'Uncategorized',
        `Serial: ${source.serialNumber || '—'} · Tag: ${source.warehouseAssetTag || '—'} · User: ${source.user || '—'} · Merchant: ${source.merchant || '—'}`,
        servedAt
      ]);
    });
    return rows;
  }
}