/**
 * Corrective-action lifecycle states, shared by the server, the worker, the client and the PDF renderer.
 *
 * A corrective action no longer auto-closes when the responder answers. A submission goes to an approver,
 * who either approves it (closing the item) or rejects it with comments (returning it for rework). This
 * module is the single source of truth for the resulting state sets — several predicates depend on getting
 * "is this item still outstanding?" right, and they are spread across the reconcile arithmetic, the closure
 * check, the response API and a partial index.
 */

/** Item states. `resolved` was the pre-approval name for `submitted`; migration renames the data. */
export const CORRECTIVE_ACTION_ITEM_STATUSES = ["open", "submitted", "approved", "rejected"] as const;
export type CorrectiveActionItemStatus = (typeof CORRECTIVE_ACTION_ITEM_STATUSES)[number];

/**
 * Item states that still require RESPONDER work.
 *
 * `rejected` counts as outstanding: the approver sent it back and the super/PM must answer again. It is kept
 * DISTINCT from `open` only so the UI, the PDF and the emails can show the rejection reason — every
 * "is anything left to do?" test must treat the two identically.
 *
 * Missing one of these sites lets a card close with rejected work still in it, which is the single highest-risk
 * error in the approval change. The partial index in migration 0192 was widened to match this set.
 */
export const CORRECTIVE_ACTION_OUTSTANDING_STATUSES = ["open", "rejected"] as const;

/** Item states awaiting the APPROVER. Only these may be approved or rejected. */
export const CORRECTIVE_ACTION_AWAITING_APPROVAL_STATUSES = ["submitted"] as const;

export function isCorrectiveActionOutstanding(status: string | null | undefined): boolean {
  return !!status && (CORRECTIVE_ACTION_OUTSTANDING_STATUSES as readonly string[]).includes(status);
}

export function isCorrectiveActionAwaitingApproval(status: string | null | undefined): boolean {
  return !!status && (CORRECTIVE_ACTION_AWAITING_APPROVAL_STATUSES as readonly string[]).includes(status);
}

/** SQL literal list for the outstanding set, e.g. `'open','rejected'` — keeps raw SQL in step with the above. */
export const CORRECTIVE_ACTION_OUTSTANDING_SQL_LIST = CORRECTIVE_ACTION_OUTSTANDING_STATUSES.map(
  (status) => `'${status}'`,
).join(",");

/**
 * Card-level states. `corrective_action_closed` retains its name even though it now means APPROVED — renaming
 * it would churn the QC dashboard, the reports service, the client badge and every runtime fixture for no
 * user-visible gain. `corrective_action_submitted` is 27 chars and fits the existing varchar(30).
 */
export const CORRECTIVE_ACTION_CARD_OPEN = "corrective_action_open";
export const CORRECTIVE_ACTION_CARD_AWAITING_APPROVAL = "corrective_action_submitted";
export const CORRECTIVE_ACTION_CARD_CLOSED = "corrective_action_closed";

/** Event kinds recorded on the append-only thread that documents the full back-and-forth. */
export const CORRECTIVE_ACTION_EVENT_TYPES = ["submitted", "approved", "rejected"] as const;
export type CorrectiveActionEventType = (typeof CORRECTIVE_ACTION_EVENT_TYPES)[number];
