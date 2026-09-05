import { generateId } from '../utils/id.js';

/**
 * Requisition is a single submission of the in-app "Requisition Form" — a
 * clone of the reference Google Form ("Operation Gadget Request Form",
 * see the FORM vs Print Preview reference screenshots this feature was
 * built from). `items` is one row per Gadget Type selected, each with its
 * own quantity — the reference form's own "+ Add row" pattern, so a
 * single requisition can ask for more than one kind of gadget at once
 * rather than being limited to a single category/qty pair.
 */
export class Requisition {
  constructor(data = {}) {
    this.id = data.id || generateId('requisition');
    this.email = data.email || '';
    this.requesterName = data.requesterName || '';
    // [{ category: 'KAICOM', qty: 12 }, ...]
    this.items = Array.isArray(data.items)
      ? data.items.map((i) => ({ category: i.category || '', qty: Number(i.qty) || 0 }))
      : [];
    this.purpose = data.purpose || '';
    // Who was signed into this browser when the form was filled out —
    // deliberately distinct from `requesterName`, which is free text
    // exactly like the reference Google Form's own field: the person
    // requesting isn't necessarily the person at the keyboard filling
    // this out on their behalf.
    this.submittedBy = data.submittedBy || '';
    this.createdAt = data.createdAt || Date.now();
    // 'pending' | 'finished' — set from Recent Requisitions' own Action
    // menu (see RequisitionController._finishRequisition/_reopenRequisition),
    // never from the form itself; nothing about filling out a request
    // determines whether it's been fulfilled yet.
    this.status = data.status === 'finished' ? 'finished' : 'pending';
    // Gadget ids actually issued by "Process Request" (Manage's own
    // action bar — see ManageController.openProcessRequestModal /
    // ProcessRequestModal.js) — empty for a requisition marked finished
    // by hand instead, since nothing was issued for those. Purely a
    // record of what happened; Reopen does not undo this or hand the
    // gadgets back. Kept alongside `fulfilledItems` (below) rather than
    // replaced by it, since it's still the cheapest way to cross-check
    // "is this asset still exactly as it was when issued" against a
    // *live* Gadget record.
    this.fulfilledGadgetIds = Array.isArray(data.fulfilledGadgetIds) ? data.fulfilledGadgetIds : [];
    // One snapshot per row Process Request actually issued — every row on
    // that document, not just the ones that matched a real Gadget.
    // fulfilledGadgetIds alone can't represent a hand-typed row (e.g. a
    // consumable like a power cable that isn't tracked as its own
    // serialized asset in Manage — see ProcessRequestModal's own doc
    // comment on hand-added blank rows): it has no gadget id to record,
    // so before this field existed it was silently dropped from "Actually
    // Served" entirely even though it was printed and handed over. Each
    // entry is `{ gadgetId, category, serialNumber, warehouseAssetTag,
    // assetTagDefault, macAddress, password, merchant, description, user }`
    // — `gadgetId` is null for a hand-typed row. RequisitionController's
    // fulfillment log prefers the *live* Gadget (via gadgetId) when one
    // still exists, and falls back to this frozen snapshot otherwise —
    // which is also what covers a real asset later deleted from Manage.
    this.fulfilledItems = Array.isArray(data.fulfilledItems)
      ? data.fulfilledItems.map((i) => ({
          gadgetId: i.gadgetId || null,
          category: i.category || '',
          serialNumber: i.serialNumber || '',
          warehouseAssetTag: i.warehouseAssetTag || '',
          assetTagDefault: i.assetTagDefault || '',
          macAddress: i.macAddress || '',
          password: i.password || '',
          merchant: i.merchant || '',
          description: i.description || '',
          role: i.role || '',
          user: i.user || ''
        }))
      : [];
    // When this requisition was actually issued against via Process
    // Request (see ProcessRequestModal.js's applyProcessing, the only
    // writer of this field alongside fulfilledItems/fulfilledGadgetIds
    // above) — null for one finished by hand instead, or one finished
    // before this field existed. Powers the "Date" column on "Actually
    // Served" rows in the requisition export (ReportsController's
    // _servedRowsForExport); nothing currently shows it in the on-screen
    // fulfillment log, but it's recorded here rather than per-item since
    // every row issued in one Process Request session happens at the
    // same moment.
    this.servedAt = data.servedAt || null;
  }

  /** Validates a raw form payload before it becomes a Requisition. */
  static validate(data) {
    const errors = {};

    const email = (data.email || '').trim();
    if (!email) errors.email = 'Email is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.';

    if (!data.requesterName || !data.requesterName.trim()) errors.requesterName = 'Requester name is required.';

    const items = (data.items || []).filter((i) => (i.category || '').trim() && Number(i.qty) > 0);
    if (items.length === 0) errors.items = 'Select at least one gadget type and enter a quantity.';

    if (!data.purpose || !data.purpose.trim()) errors.purpose = 'Purpose is required.';

    return { valid: Object.keys(errors).length === 0, errors };
  }
}

/**
 * The fixed signatory panel printed on every requisition — same three
 * names in both reference screenshots (Bruce Lim / James Dejero / Paul
 * So). This is deliberately NOT per-submission data: nothing on the form
 * lets a person change who approves a request, so it lives here as a
 * constant rather than a Requisition field. Move it to Settings if it
 * ever needs to be admin-editable.
 */
export const REQUISITION_APPROVERS = ['Bruce Lim', 'James Dejero', 'Paul So'];