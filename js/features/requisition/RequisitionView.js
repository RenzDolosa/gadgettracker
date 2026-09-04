import { esc } from '../../utils/dom.js';
import { fmtLocalDateTime } from '../../utils/format.js';
import { REQUISITION_APPROVERS } from '../../models/Requisition.js';

/**
 * RequisitionView owns only the parts of the Requisition Form panel that
 * are safe to fully re-render from data: the fixed "Approved by"
 * signatory block and the Recent Requisitions history.
 *
 * The interactive "+ Add row" Gadget Type/Qty rows — including the Gadget
 * Type suggestion dropdown and its "N available" hint — are deliberately
 * NOT rendered here — RequisitionController manages those directly (see
 * its own header comment) — re-rendering an in-progress row from state on
 * every keystroke would drop focus/cursor position mid-type, the same
 * reason ManifestModal builds its own row table imperatively instead of
 * through a generic re-render.
 */
export class RequisitionView {
  constructor(refs) {
    this.refs = refs;
  }

  /** Static — rendered once at startup, never changes while the app runs. */
  renderApprovers() {
    if (!this.refs.approversEl) return;
    this.refs.approversEl.innerHTML = REQUISITION_APPROVERS.map((name) => `
      <div class="requisition-approver">
        <span class="requisition-approver-name">${esc(name)}</span>
        <span class="requisition-approver-line"></span>
      </div>
    `).join('');
  }

  /**
   * @param {import('../../models/Requisition.js').Requisition[]} requisitions - newest first.
   * @param {{canPrint: boolean, canAction: boolean}} [permissions] - defaults to both allowed,
   *   so any caller that doesn't pass this (there shouldn't be one — see
   *   RequisitionController._renderHistory) still gets working buttons
   *   instead of everything silently disabled.
   */
  renderHistory(requisitions, permissions = {}) {
    if (!this.refs.historyListEl) return;
    const canPrint = permissions.canPrint !== false;
    const canAction = permissions.canAction !== false;

    if (requisitions.length === 0) {
      this.refs.historyListEl.innerHTML = '<p class="requisition-history-empty">No requisitions submitted yet.</p>';
      return;
    }

    this.refs.historyListEl.innerHTML = requisitions.map((r) => {
      const itemsSummary = r.items.map((i) => `${esc(i.category)} × ${esc(String(i.qty))}`).join(', ') || 'No items';
      const finished = r.status === 'finished';
      // Prefer fulfilledItems' count (every row Process Request issued,
      // hand-typed ones included — see Requisition.js's own doc) over
      // fulfilledGadgetIds, which only counts rows that matched a real
      // Gadget. Falls back to the old id-only count for a requisition
      // finished before fulfilledItems existed.
      const issuedCount = r.fulfilledItems?.length || r.fulfilledGadgetIds?.length || 0;
      const finishedLabel = issuedCount > 0 ? `Finished · ${issuedCount} issued` : 'Finished';
      return `
        <div class="requisition-history-row${finished ? ' is-finished' : ''}" data-id="${esc(r.id)}">
          <div class="requisition-history-main">
            <div class="requisition-history-title">
              ${esc(r.requesterName || 'Unnamed requester')}
              ${finished ? `<span class="pill pill-linked">${esc(finishedLabel)}</span>` : ''}
            </div>
            <div class="requisition-history-meta">${itemsSummary} — ${esc(r.purpose || 'No purpose given')}</div>
            <div class="requisition-history-sub">${esc(fmtLocalDateTime(r.createdAt))}${r.submittedBy ? ` · By ${esc(r.submittedBy)}` : ''}</div>
          </div>
          <div class="requisition-history-actions">
            <button tabindex="-1" type="button" class="link-btn" data-action="reprint" data-id="${esc(r.id)}" ${canPrint ? '' : 'disabled title="You do not have permission to print."'}>Print</button>
            <button tabindex="-1" type="button" class="link-btn" data-action="row-menu" data-id="${esc(r.id)}" ${canAction ? '' : 'disabled title="You do not have permission to use this action."'}>Action</button>
          </div>
        </div>
      `;
    }).join('');
  }
}
