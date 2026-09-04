import { SupabaseStore } from './core/SupabaseStore.js';
import { TabManager } from './core/TabManager.js';
import { Gadget } from './models/Gadget.js';
import { ManageView } from './features/manage/ManageView.js';
import { ManageController } from './features/manage/ManageController.js';
import { InventoryAsset } from './models/InventoryAsset.js';
import { InventoryAssetView } from './features/inventoryAssets/InventoryAssetView.js';
import { InventoryAssetController } from './features/inventoryAssets/InventoryAssetController.js';
import { getOperatorName, setOperatorName, syncOperatorDisplay } from './core/Operator.js';
import { Toast } from './components/Toast.js';
import { Warehouse } from './models/Warehouse.js';
import { WarehouseLocation } from './models/WarehouseLocation.js';
import { SettingsController } from './features/settings/SettingsController.js';
import { ReportsController } from './features/reports/ReportsController.js';
import { ReportsView } from './features/reports/ReportsView.js';
import { RequisitionController } from './features/requisition/RequisitionController.js';
import { RequisitionView } from './features/requisition/RequisitionView.js';
import { Requisition } from './models/Requisition.js';
import { UserAccount } from './models/UserAccount.js';
import { UserAccountView } from './features/userManagement/UserAccountView.js';
import { UserAccountController } from './features/userManagement/UserAccountController.js';
import { UserGroup } from './models/UserGroup.js';
import { UserGroupView } from './features/userManagement/UserGroupView.js';
import { UserGroupController } from './features/userManagement/UserGroupController.js';
import { supabase } from './core/supabaseClient.js';
import { AuthView } from './features/auth/AuthView.js';
import { AuthController } from './features/auth/AuthController.js';
import { updatePassword, updateOwnUsername } from './core/Auth.js';
import { isPasswordValid, describeMissingRequirements, friendlyPasswordError } from './utils/passwordPolicy.js';
import { mountPasswordRequirements } from './components/PasswordRequirements.js';
import { setPermissions, can } from './core/Permissions.js';
import { setBoundWarehouseIds } from './core/WarehouseScope.js';
import { setCurrentUsername } from './core/CurrentUser.js';
import { getEmployeeProfile } from './core/EmployeeSession.js';
import { EMPLOYEE_PORTAL_EMAIL } from './core/supabaseConfig.js';

// Demo/seed data (Maria Santos's laptop, the sample warehouse, etc.) used to
// live here as seedGadgets()/seedInventoryAssets()/etc. and got handed to
// each Store as a localStorage fallback. Now that records live in Supabase,
// that seeding happens once, server-side — see supabase/seed.sql — instead
// of being re-applied by the browser on every empty-storage first load.

function collectRefs() {
  return {
    // Filter bar
    filterKeyword: document.getElementById('filterKeyword'),
    filterPosition: document.getElementById('filterPosition'),
    filterWarehouse: document.getElementById('filterWarehouse'),
    filterCategory: document.getElementById('filterCategory'),
    warehouseFilterBtn: document.getElementById('warehouseFilterBtn'),
    searchBtn: document.getElementById('searchBtn'),
    resetBtn: document.getElementById('resetBtn'),

    // Action bar
    exportBtn: document.getElementById('exportBtn'),
    columnBtn: document.getElementById('manageColumnBtn'),
    manifestBtn: document.getElementById('manifestBtn'),
    manifestSep: document.getElementById('manifestSep'),
    pendingTransfersBtn: document.getElementById('pendingTransfersBtn'),
    pendingTransfersSep: document.getElementById('pendingTransfersSep'),
    transferItemBtn: document.getElementById('transferItemBtn'),
    transferItemSep: document.getElementById('transferItemSep'),
    requestItemBtn: document.getElementById('requestItemBtn'),
    requestItemSep: document.getElementById('requestItemSep'),
    transfersMenuBtn: document.getElementById('transfersMenuBtn'),
    deleteSelectedBtn: document.getElementById('deleteSelectedBtn'),
    deleteSelectedSep: document.getElementById('deleteSelectedSep'),
    refreshBtn: document.getElementById('refreshBtn'),

    // Table
    tableHead: document.getElementById('tableHead'),
    tableBody: document.getElementById('tableBody'),
    emptyState: document.getElementById('emptyState'),
    selectAllCheckbox: document.getElementById('selectAllCheckbox'),

    // Footer / pagination
    selectedCount: document.getElementById('selectedCount'),
    resultCount: document.getElementById('resultCount'),
    selectAllFilteredBtn: document.getElementById('selectAllFilteredBtn'),
    clearSelectionBtn: document.getElementById('clearSelectionBtn'),
    pageSizeSelect: document.getElementById('pageSizeSelect'),
    prevPageBtn: document.getElementById('prevPageBtn'),
    nextPageBtn: document.getElementById('nextPageBtn'),
    pageNumbers: document.getElementById('pageNumbers'),
    gotoPageInput: document.getElementById('gotoPageInput'),
    gotoPageBtn: document.getElementById('gotoPageBtn')
  };
}

/** Refs scoped to the Inventory Assets panel — kept separate from collectRefs()
 * above (the Manage/Gadgets panel) so the two features never accidentally
 * share or clash over element ids. */
function collectInventoryAssetRefs() {
  return {
    // Filter bar
    filterKeyword: document.getElementById('iaFilterKeyword'),
    filterCategory: document.getElementById('iaFilterCategory'),
    searchBtn: document.getElementById('iaSearchBtn'),
    resetBtn: document.getElementById('iaResetBtn'),

    // Action bar
    addItemBtn: document.getElementById('iaAddItemBtn'),
    importFileInput: document.getElementById('iaImportFileInput'),
    exportBtn: document.getElementById('iaExportBtn'),
    columnBtn: document.getElementById('iaColumnBtn'),
    bulkDeleteBtn: document.getElementById('iaBulkDeleteBtn'),
    bulkDeleteSep: document.getElementById('iaBulkDeleteSep'),
    clearAllBtn: document.getElementById('iaClearAllBtn'),
    refreshBtn: document.getElementById('iaRefreshBtn'),
    emptyAddBtn: document.getElementById('iaEmptyAddBtn'),

    // Table
    tableHead: document.getElementById('iaTableHead'),
    tableBody: document.getElementById('iaTableBody'),
    emptyState: document.getElementById('iaEmptyState'),
    selectAllCheckbox: document.getElementById('iaSelectAllCheckbox'),

    // Footer / pagination
    selectedCount: document.getElementById('iaSelectedCount'),
    resultCount: document.getElementById('iaResultCount'),
    pageSizeSelect: document.getElementById('iaPageSizeSelect'),
    prevPageBtn: document.getElementById('iaPrevPageBtn'),
    nextPageBtn: document.getElementById('iaNextPageBtn'),
    pageNumbers: document.getElementById('iaPageNumbers'),
    gotoPageInput: document.getElementById('iaGotoPageInput'),
    gotoPageBtn: document.getElementById('iaGotoPageBtn')
  };
}

/** Refs for the Settings tab's nav + Warehouse Information sub-view. */
function collectSettingsRefs() {
  return {
    settingsNav: document.getElementById('settingsNav'),
    whAddBtn: document.getElementById('whAddBtn'),
    whImportBtn: document.getElementById('whImportBtn'),
    whImportFileInput: document.getElementById('whImportFileInput'),
    warehouseTree: document.getElementById('warehouseTree'),
    warehouseDetailPanel: document.getElementById('warehouseDetailPanel')
  };
}

/** Refs for Settings → User management → User. */
/** Refs for the User group grid (Settings → User management → User group). */
function collectUserGroupRefs() {
  return {
    // Filter bar
    filterGroupNumber: document.getElementById('ugFilterGroupNumber'),
    filterName: document.getElementById('ugFilterName'),
    enabledFilterMount: document.getElementById('ugEnabledFilterMount'),
    searchBtn: document.getElementById('ugSearchBtn'),
    resetBtn: document.getElementById('ugResetBtn'),

    // Action bar
    addGroupBtn: document.getElementById('ugAddGroupBtn'),
    viewLogBtn: document.getElementById('ugViewLogBtn'),
    emptyAddBtn: document.getElementById('ugEmptyAddBtn'),

    // Table
    tableBody: document.getElementById('ugTableBody'),
    emptyState: document.getElementById('ugEmptyState'),

    // Footer / pagination
    resultCount: document.getElementById('ugResultCount'),
    pageSizeSelect: document.getElementById('ugPageSizeSelect'),
    prevPageBtn: document.getElementById('ugPrevPageBtn'),
    nextPageBtn: document.getElementById('ugNextPageBtn'),
    pageNumbers: document.getElementById('ugPageNumbers'),
    gotoPageInput: document.getElementById('ugGotoPageInput'),
    gotoPageBtn: document.getElementById('ugGotoPageBtn')
  };
}

function collectUserAccountRefs() {
  return {
    // Filter bar
    filterUserNumber: document.getElementById('uaFilterUserNumber'),
    filterUsername: document.getElementById('uaFilterUsername'),
    filterLoginAccount: document.getElementById('uaFilterLoginAccount'),
    enabledFilterMount: document.getElementById('uaEnabledFilterMount'),
    searchBtn: document.getElementById('uaSearchBtn'),
    resetBtn: document.getElementById('uaResetBtn'),

    // Action bar
    addUserBtn: document.getElementById('uaAddUserBtn'),
    viewLogBtn: document.getElementById('uaViewLogBtn'),
    emptyAddBtn: document.getElementById('uaEmptyAddBtn'),

    // Table
    tableBody: document.getElementById('uaTableBody'),
    emptyState: document.getElementById('uaEmptyState'),

    // Footer / pagination
    resultCount: document.getElementById('uaResultCount'),
    pageSizeSelect: document.getElementById('uaPageSizeSelect'),
    prevPageBtn: document.getElementById('uaPrevPageBtn'),
    nextPageBtn: document.getElementById('uaNextPageBtn'),
    pageNumbers: document.getElementById('uaPageNumbers'),
    gotoPageInput: document.getElementById('uaGotoPageInput'),
    gotoPageBtn: document.getElementById('uaGotoPageBtn')
  };
}

/** Refs for the Reports dashboard + activity feed. */
function collectReportsRefs() {
  return {
    reportStats: document.getElementById('reportStats'),
    reportByCategory: document.getElementById('reportByCategory'),
    reportByWarehouse: document.getElementById('reportByWarehouse'),
    reportByPosition: document.getElementById('reportByPosition'),
    reportByAssetCategory: document.getElementById('reportByAssetCategory'),
    reportByLocationType: document.getElementById('reportByLocationType'),
    reportByLocation: document.getElementById('reportByLocation'),
    reportActivityFeed: document.getElementById('reportActivityFeed'),
    warehouseFilterBtn: document.getElementById('reportsWarehouseFilterBtn'),
    exportBtn: document.getElementById('reportsExportBtn')
  };
}

function collectRequisitionRefs() {
  return {
    formEl: document.getElementById('requisitionForm'),
    emailInput: document.getElementById('reqEmail'),
    requesterNameInput: document.getElementById('reqRequesterName'),
    purposeInput: document.getElementById('reqPurpose'),
    itemsEl: document.getElementById('requisitionItems'),
    addRowBtn: document.getElementById('requisitionAddRowBtn'),
    clearBtn: document.getElementById('requisitionClearBtn'),
    approversEl: document.getElementById('requisitionApprovers'),
    historyListEl: document.getElementById('requisitionHistoryList'),
    clearAllBtn: document.getElementById('requisitionClearAllBtn')
  };
}

function bindAdvancedFilterToggle() {
  const toggle = document.getElementById('filterAdvancedToggle');
  const row = document.getElementById('filterAdvancedRow');
  if (!toggle || !row) return;

  toggle.addEventListener('click', () => {
    const willShow = row.hidden;
    row.hidden = !willShow;
    toggle.setAttribute('aria-expanded', String(willShow));
    toggle.innerHTML = willShow
      ? 'Hide <span class="chev">▲</span>'
      : 'Show <span class="chev">▾</span>';
  });
}

/** Maps each openable tab's id to its PERMISSION_TREE key (models/UserGroup.js)
 * — not 1:1 by name (the Manage tab's id is 'assets', historically, while
 * its permission key is 'manage'). */
const TAB_PERMISSION_KEYS = {
  home: 'home',
  assets: 'manage',
  'inventory-assets': 'inventory-assets',
  reports: 'reports',
  requisition: 'requisition',
  settings: 'settings'
};

function initTabs() {
  const allTabs = [
    { id: 'home', title: 'Home Page', pinned: true, closable: false },
    { id: 'assets', title: 'Manage', closable: true },
    { id: 'inventory-assets', title: 'Inventory Assets', closable: true },
    { id: 'reports', title: 'Reports', closable: true },
    { id: 'requisition', title: 'Requisition', closable: true },
    { id: 'settings', title: 'Settings', closable: true }
  ];
  const allowedTabs = allTabs.filter((t) => can(TAB_PERMISSION_KEYS[t.id]));

  const tabs = new TabManager({
    tabstripEl: document.getElementById('tabstrip'),
    panelsEl: document.getElementById('panels'),
    tabs: allowedTabs
  });

  document.querySelectorAll('.rail-icon[data-open-tab]').forEach((btn) => {
    const tabId = btn.getAttribute('data-open-tab');
    if (!can(TAB_PERMISSION_KEYS[tabId])) {
      // Hidden, not just left unclickable — same reasoning as the
      // Settings nav below: someone whose group denies a whole area
      // shouldn't see it listed as an option at all. TabManager itself
      // never even learns this tab exists (see allowedTabs above), so
      // there's nothing to open even if this were somehow clicked.
      btn.hidden = true;
      return;
    }
    btn.addEventListener('click', () => tabs.open(tabId));
  });

  if (allowedTabs.length > 0) {
    tabs.open(allowedTabs[0].id);
  } else {
    // A group with literally every permission denied is a config
    // mistake, not a state the app should just render blank for.
    Toast.error('Your account isn\'t permitted to access any section yet — contact an administrator.');
  }
}

/** Maps each Settings nav section's data-settings-section value to its
 * full, nested PERMISSION_TREE key. */
const SETTINGS_SECTION_PERMISSION_KEYS = {
  general: 'settings.general',
  'warehouse-info': 'settings.warehouse-info',
  'user-groups': 'settings.user-mgmt.user-groups',
  'user-accounts': 'settings.user-mgmt.user-accounts'
};

/**
 * Hides whichever Settings nav items/subitems the current user's group
 * denies — including collapsing an entire group header (e.g. "User
 * management") when every one of its subitems is denied, the same way
 * "IP whitelist" already hides itself for being an unbuilt stub. Purely
 * a nav-visibility pass; SettingsController's own click-to-show logic is
 * untouched; a hidden button just never gets a chance to be clicked.
 *
 * Resets every item to visible before re-evaluating, rather than only
 * ever adding `hidden` — this runs again any time User Group permissions
 * change live (see refreshLivePermissions), not just once at sign-in, so
 * a section that was hidden a moment ago needs to be able to reappear
 * the instant its group is granted access, not just disappear further.
 */
function applySettingsNavPermissions() {
  const nav = document.getElementById('settingsNav');
  if (!nav) return;

  nav.querySelectorAll('[data-settings-section]').forEach((btn) => { btn.hidden = false; });
  nav.querySelectorAll('.settings-nav-group').forEach((group) => { group.hidden = false; });

  let activeSectionHidden = false;

  nav.querySelectorAll('[data-settings-section]').forEach((btn) => {
    const key = SETTINGS_SECTION_PERMISSION_KEYS[btn.getAttribute('data-settings-section')];
    if (key && !can(key)) {
      if (btn.classList.contains('active')) activeSectionHidden = true;
      btn.hidden = true;
    }
  });

  nav.querySelectorAll('.settings-nav-group').forEach((group) => {
    const subitems = [...group.querySelectorAll('[data-settings-section]')];
    if (subitems.length > 0 && subitems.every((el) => el.hidden)) {
      group.hidden = true;
    }
  });

  // The section that was showing by default (General, normally) just got
  // hidden out from under the person looking at it — show the first
  // section their group actually allows instead of leaving the content
  // pane on a section its own nav button no longer exists for.
  if (activeSectionHidden) {
    const firstVisible = nav.querySelector('[data-settings-section]:not([hidden])');
    firstVisible?.click();
  }
}

/** Wires the Settings tab's one field: the operator name used to stamp
 * new history entries and pre-fill manifests (see core/Operator.js). */
function bindSettingsPanel(session) {
  const form = document.getElementById('operatorForm');
  const input = document.getElementById('operatorNameInput');
  if (!form || !input) return;

  // The signed-in account's real username is the source of truth for
  // "who is this" — use it here rather than trusting whatever's cached
  // in Operator's localStorage, which can otherwise show a stale name
  // left over from an unsaved edit or a different account that signed
  // in on this same browser before.
  const currentUsername = session?.user?.user_metadata?.username;
  input.value = currentUsername || getOperatorName();
  if (currentUsername) setOperatorName(currentUsername);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    setOperatorName(name);
    input.value = getOperatorName();

    // "Your name" and the account's actual username (User management,
    // the top-bar chip, and — for administrators — Supabase Auth's own
    // user_metadata.username) are the same underlying identity; keep
    // them in sync rather than letting the two silently drift apart.
    if (name) {
      const { error } = await updateOwnUsername(name, session);
      if (error) console.error('[settings] Could not sync username:', error.message);
      syncOperatorDisplay(name);
    }

    Toast.success('Saved. New activity will be recorded under this name.');
  });
}

/** Wires Settings → General → Change password: two-field form (new +
 * confirm) that calls Auth.js's updatePassword(), which trusts the current
 * session as identity proof (no "current password" re-entry, same as most
 * account-settings password changes). Field-error styling matches every
 * other form's .field-error convention (WarehouseForm, UserAccountForm). */
function bindChangePasswordPanel(session) {
  const form = document.getElementById('changePasswordForm');
  const currentInput = document.getElementById('currentPasswordInput');
  const newInput = document.getElementById('newPasswordInput');
  const confirmInput = document.getElementById('confirmPasswordInput');
  const submitBtn = document.getElementById('changePasswordSubmitBtn');
  const emailLabel = document.getElementById('changePasswordAccountEmail');
  if (!form || !currentInput || !newInput || !confirmInput) return;

  // Shows the account's username rather than its email — the same
  // identity people already see in the top-bar profile chip (see
  // core/Operator.js's syncOperatorDisplay), so this reads as "your
  // account" rather than surfacing a second, less-recognizable label
  // for the same thing.
  if (emailLabel) emailLabel.textContent = session?.user?.user_metadata?.username || session?.user?.email || 'your account';

  const clearErrors = () => {
    form.querySelectorAll('.field-error').forEach((e) => { e.textContent = ''; });
    [currentInput, newInput, confirmInput].forEach((i) => i.classList.remove('invalid'));
  };
  const showFieldError = (input, name, message) => {
    input.classList.add('invalid');
    const errEl = form.querySelector(`[data-error-for="${name}"]`);
    if (errEl) errEl.textContent = message;
  };

  // Same reveal-toggle pattern as the auth screen / ManageForm's password
  // field (css/modal.css .password-field / .password-toggle), keyed off
  // data-action since this form has three independent password fields.
  form.querySelector('[data-action="toggle-current-password"]')?.addEventListener('click', (e) => {
    const showing = currentInput.type === 'text';
    currentInput.type = showing ? 'password' : 'text';
    e.currentTarget.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });
  form.querySelector('[data-action="toggle-new-password"]')?.addEventListener('click', (e) => {
    const showing = newInput.type === 'text';
    newInput.type = showing ? 'password' : 'text';
    e.currentTarget.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });
  form.querySelector('[data-action="toggle-confirm-password"]')?.addEventListener('click', (e) => {
    const showing = confirmInput.type === 'text';
    confirmInput.type = showing ? 'password' : 'text';
    e.currentTarget.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });

  // See utils/passwordPolicy.js for why this mirrors the project's actual
  // Supabase Auth password policy instead of just a length check — this
  // is what replaces submitting blind and getting GoTrue's raw
  // "at least one character of each: abcdefg..., ABCDEFG..." error back.
  // Mounted into #newPasswordRequirementsSlot (see index.html's
  // .change-password-row) so it sits beside New password + Confirm
  // password, not stacked under either one.
  const passwordChecklist = mountPasswordRequirements(newInput, {
    target: document.getElementById('newPasswordRequirementsSlot')
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();

    const currentPassword = currentInput.value;
    const newPassword = newInput.value;
    const confirmPassword = confirmInput.value;
    let valid = true;
    if (!currentPassword) {
      showFieldError(currentInput, 'currentPassword', 'Enter your current password.');
      valid = false;
    }
    if (!isPasswordValid(newPassword)) {
      showFieldError(newInput, 'newPassword', describeMissingRequirements(newPassword));
      valid = false;
    }
    if (confirmPassword !== newPassword) {
      showFieldError(confirmInput, 'confirmPassword', 'Passwords do not match.');
      valid = false;
    }
    if (!valid) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Updating…';
    try {
      const { error } = await updatePassword(currentPassword, newPassword);
      if (error) {
        if (/current password/i.test(error.message || '')) {
          showFieldError(currentInput, 'currentPassword', error.message);
        } else {
          Toast.error(friendlyPasswordError(error.message, newPassword) || 'Could not update password. Please try again.');
        }
        return;
      }
      form.reset();
      passwordChecklist.update(); // clear the checklist back to its neutral, empty state
      Toast.success('Password updated.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Update password';
    }
  });
}

/**
 * Resolves the signed-in account's assigned User Group (Settings → User
 * management → User group) and applies its permissions via
 * core/Permissions.js — the one access-control layer left now that
 * admin/employee no longer gates anything by itself (see
 * AuthController.js's own header comment). Employee sessions read their
 * group straight off EmployeeSession's stashed profile (verify_employee_login
 * already returns it — see supabase/schema.sql); administrator sessions
 * look their own user_accounts row up by authUserId. No group assigned,
 * or the assigned group no longer exists or was disabled, resolves to
 * null permissions — core/Permissions.js's can() treats that as
 * unrestricted, so nobody who predates this feature is suddenly locked
 * out of everything.
 *
 * The same resolved group's boundWarehouseIds is applied here too, via
 * core/WarehouseScope.js — one lookup, two singletons updated, since
 * both read off the exact same group record.
 *
 * The account itself (not just its group) is also stashed via
 * core/CurrentUser.js's setCurrentUsername() — the one place that needs
 * "who is signed in", not "what can they do" (see that module's own doc
 * comment for why it's a real account lookup rather than Operator.js's
 * self-reported name).
 */
function applyCurrentUserPermissions(session, userAccountStore, userGroupStore) {
  const isEmployeePortalSession = (session.user?.email || '').toLowerCase() === EMPLOYEE_PORTAL_EMAIL.toLowerCase();
  const account = isEmployeePortalSession
    ? getEmployeeProfile()
    : userAccountStore.list().find((u) => u.authUserId === session.user.id);

  const group = account?.userGroupId ? userGroupStore.get(account.userGroupId) : null;
  const resolvedGroup = group?.enabled ? group : null;

  setPermissions(resolvedGroup ? resolvedGroup.permissions : null);
  setBoundWarehouseIds(resolvedGroup ? resolvedGroup.boundWarehouseIds : null);
  setCurrentUsername(account?.username || '');
}

async function startApp(session) {
  if (!supabase) {
    console.error('[supabase] Not configured — fill in js/core/supabaseConfig.js with your project URL and anon key.');
    Toast.error('Supabase isn\'t configured yet — see js/core/supabaseConfig.js.');
  }

  const store = new SupabaseStore({
    table: 'gadgets',
    factory: (raw) => new Gadget(raw)
  });

  const inventoryAssetStore = new SupabaseStore({
    table: 'inventory_assets',
    factory: (raw) => new InventoryAsset(raw)
  });

  const warehouseStore = new SupabaseStore({
    table: 'warehouses',
    factory: (raw) => new Warehouse(raw),
    // Warehouse Information's tree (SettingsController.renderTree) lists
    // sites in whatever order list() returns them, oldest-first per the
    // Settings screen's requirement — the default (newest-first) is right
    // for Manage/Inventory Assets grids, but wrong here.
    ascending: true
  });

  const warehouseLocationStore = new SupabaseStore({
    table: 'warehouse_locations',
    factory: (raw) => new WarehouseLocation(raw)
  });

  const userAccountStore = new SupabaseStore({
    table: 'user_accounts',
    factory: (raw) => new UserAccount(raw)
  });

  const userGroupStore = new SupabaseStore({
    table: 'user_groups',
    factory: (raw) => new UserGroup(raw)
  });

  const requisitionStore = new SupabaseStore({
    table: 'requisitions',
    factory: (raw) => new Requisition(raw)
  });

  // Every optimistic write (create/update/delete) can now fail for reasons
  // that never existed with localStorage — offline, RLS denial, a dropped
  // connection. SupabaseStore already rolls the local cache back and
  // re-renders; this just tells the person it happened.
  [store, inventoryAssetStore, warehouseStore, warehouseLocationStore, userAccountStore, userGroupStore, requisitionStore]
    .forEach((s) => s.on('error', ({ type }) => {
      if (type === 'init' || type === 'load') return; // already logged + toasted above
      Toast.error('Could not save that change — please check your connection and try again.');
    }));

  // Kick off every initial fetch in parallel rather than one at a time —
  // these tables don't depend on each other to load. Each store's own
  // constructor already leaves `records` as [] until this resolves, and
  // every controller below re-renders on the store's 'change' event, so
  // this await just avoids an initial "empty" paint before the real data
  // arrives a moment later.
  await Promise.all([
    store.init(),
    inventoryAssetStore.init(),
    warehouseStore.init(),
    warehouseLocationStore.init(),
    userAccountStore.init(),
    userGroupStore.init(),
    requisitionStore.init()
  ]);

  applyCurrentUserPermissions(session, userAccountStore, userGroupStore);

  const refs = collectRefs();
  const view = new ManageView(refs);
  const controller = new ManageController({ store, view, refs, inventoryAssetStore, warehouseStore, locationStore: warehouseLocationStore, requisitionStore });
  controller.init();

  const inventoryAssetRefs = collectInventoryAssetRefs();
  const inventoryAssetView = new InventoryAssetView(inventoryAssetRefs);
  const inventoryAssetController = new InventoryAssetController({
    store: inventoryAssetStore,
    gadgetStore: store,
    view: inventoryAssetView,
    refs: inventoryAssetRefs
  });
  inventoryAssetController.init();

  const settingsController = new SettingsController({
    warehouseStore,
    locationStore: warehouseLocationStore,
    refs: collectSettingsRefs()
  });
  settingsController.init();
  applySettingsNavPermissions();

  const userGroupRefs = collectUserGroupRefs();
  const userGroupView = new UserGroupView(userGroupRefs);
  const userGroupController = new UserGroupController({
    store: userGroupStore,
    userAccountStore,
    warehouseStore,
    view: userGroupView,
    refs: userGroupRefs
  });
  userGroupController.init();

  const userAccountRefs = collectUserAccountRefs();
  const userAccountView = new UserAccountView(userAccountRefs);
  const userAccountController = new UserAccountController({
    store: userAccountStore,
    userGroupStore,
    view: userAccountView,
    refs: userAccountRefs
  });
  userAccountController.init();

  const reportsRefs = collectReportsRefs();
  const reportsView = new ReportsView(reportsRefs);
  const reportsController = new ReportsController({
    store,
    inventoryAssetStore,
    warehouseStore,
    locationStore: warehouseLocationStore,
    requisitionStore,
    view: reportsView,
    refs: reportsRefs
  });
  reportsController.init();

  const requisitionRefs = collectRequisitionRefs();
  const requisitionView = new RequisitionView(requisitionRefs);
  const requisitionController = new RequisitionController({
    store: requisitionStore,
    inventoryAssetStore,
    gadgetStore: store,
    locationStore: warehouseLocationStore,
    view: requisitionView,
    refs: requisitionRefs
  });
  requisitionController.init();

  initTabs();
  bindAdvancedFilterToggle();
  bindSettingsPanel(session);
  bindChangePasswordPanel(session);

  // Live permission propagation: userGroupStore/userAccountStore are both
  // realtime-subscribed (see SupabaseStore's own doc comment) — an admin
  // editing a User Group's permissions or Bind warehouse list, or
  // reassigning someone's group, already lands in these stores' caches
  // the moment it happens, in every open tab/session, not just the one
  // that made the change. The only thing missing was applying that to
  // *this* session's own access: applyCurrentUserPermissions() and
  // applySettingsNavPermissions() were both only ever called once, at
  // sign-in, so a permission change wouldn't take effect here until the
  // next full sign-out/sign-in.
  //
  // Re-running both, then re-rendering every controller whose action-bar
  // buttons and row actions are gated by can()/isWarehouseAllowed(), is
  // what makes that instant instead: a button disabled a second ago
  // because Confirm transfers was off becomes clickable the moment an
  // admin turns it on, with no reload, in whatever tab is already open.
  //
  // Deliberately unfiltered — this re-evaluates on *any* row change in
  // either table, not just edits to this session's own group/account.
  // Filtering to "was it actually mine" would need to track the group id
  // across reassignment (today's group might not be tomorrow's), and the
  // work skipped by filtering is cheap: a couple of lookups plus renders
  // these controllers already do constantly in response to other store
  // changes. Same "simplicity over cleverness" trade SupabaseStore's own
  // realtime handler already makes.
  function refreshLivePermissions() {
    applyCurrentUserPermissions(session, userAccountStore, userGroupStore);
    applySettingsNavPermissions();
    controller.render();
    inventoryAssetController.render();
    userGroupController.render();
    userAccountController.render();
    reportsController.render();
    requisitionController.render();
  }
  userGroupStore.on('change', refreshLivePermissions);
  userAccountStore.on('change', refreshLivePermissions);

  document.getElementById('appShell').hidden = false;
}

/** Refs for the login screen (see #authScreen in index.html) — one unified
 * sign-in form (auto-detects employee vs administrator), plus a secondary
 * sign-up toggle for the one-time administrator bootstrap. */
function collectAuthRefs() {
  return {
    screen: document.getElementById('authScreen'),
    sub: document.getElementById('authSub'),
    signUpToggle: document.getElementById('authSignUpToggle'),
    errorBox: document.getElementById('authError'),
    form: document.getElementById('authForm'),
    usernameField: document.getElementById('authUsernameField'),
    usernameInput: document.getElementById('authUsername'),
    identifierInput: document.getElementById('authIdentifier'),
    passwordInput: document.getElementById('authPassword'),
    passwordToggle: document.getElementById('authPasswordToggle'),
    submitBtn: document.getElementById('authSubmitBtn'),
    profileUsername: document.getElementById('profileUsername'),
    signOutBtn: document.getElementById('signOutBtn')
  };
}

/**
 * Entry point. Auth gates everything else: startApp() (all the stores,
 * controllers, tabs) only runs once AuthController confirms a real
 * Supabase session exists, whether that's because one was already active
 * on page load or because the person just signed in.
 */
function bootstrap() {
  const authRefs = collectAuthRefs();
  const authView = new AuthView(authRefs);
  const authController = new AuthController({
    view: authView,
    refs: authRefs,
    onSignedIn: (session) => startApp(session),
    onSignedOut: () => {
      // No teardown path exists for the stores/controllers startApp() built
      // (realtime subscriptions, event listeners, etc.), so rather than
      // partially un-wire all of that, a full reload gives every feature a
      // clean slate the next time someone signs in on this tab.
      location.reload();
    }
  });
  authController.init();
}

document.addEventListener('DOMContentLoaded', bootstrap);