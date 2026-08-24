import type { UserRole } from "./enums.js";

/**
 * The notification recipient groups an admin can assign people to, in the order the admin page renders
 * them.
 *
 * A registry and not a constant per feature, because the same list has to be true in two places at once:
 * the server lazy-creates the `notification_recipient_groups` row from it on first read, and the admin
 * page draws one section per entry. A group present in only one of the two is either a page that 404s or a
 * mailing that resolves to nobody — and the resolution path has no way to say "nobody" out loud, so the
 * second failure is silent.
 *
 * Adding a group is adding an entry here. Nothing else has to change to make it assignable.
 */
export interface NotificationRecipientGroupDefinition {
  /** Matches `notification_recipient_groups.key`, and the `:key` the admin API is parameterised by. */
  key: string;
  /** Section heading on the admin page, and the row's `name`. */
  name: string;
  /** The line under the heading, and the row's `description`. */
  description: string;
  /**
   * What the confirm dialog says stops happening when the list is saved empty. Phrased as the mail that
   * stops arriving: "no recipients" on its own does not tell an admin what they just switched off.
   */
  emptyWarning: string;
  /**
   * Whether an EMPTY assignment list resolves to every active admin and director instead of to nobody.
   *
   * On for lead due diligence since it shipped — an unassigned DD group still mails the people who can act
   * on it. Off by default, because a fallback is only right where the whole leadership team is a defensible
   * audience; a report meant for one estimator is not improved by going to all of them.
   *
   * Whatever this says, `emptyWarning` has to agree with it. A group with a fallback does not go quiet when
   * it is emptied, it WIDENS, and telling an admin the opposite is how they widen it on purpose.
   */
  fallbackToAdminsAndDirectors: boolean;
  /**
   * Which roles may be assigned to this group. Unset means every active user, which is the right default
   * for a mailing list — the bid due date report goes to an estimator, whose role is `rep`.
   *
   * Set it when membership is a PERMISSION rather than a subscription. Lead due diligence is the case in
   * point: its recipients are mailed a decision token, and `decideDueDiligenceByToken` authenticates on
   * that token alone with no role check, so anyone on this list can approve a new customer regardless of
   * what the CRM would otherwise let them do. Assignment changes are not audited either, so the narrow
   * list is the only thing standing between "admin ticks a box" and "a field user approves customers".
   */
  assignableRoles?: readonly UserRole[];
}

export const NOTIFICATION_RECIPIENT_GROUPS: readonly NotificationRecipientGroupDefinition[] = [
  {
    key: "lead_due_diligence",
    name: "Lead Due Diligence",
    description: "Recipients who receive new-customer lead due diligence approval requests.",
    // NOT "the emails stop", which is what this said and is the opposite of what happens. Emptying this
    // list turns the fallback back on, so the request goes to EVERY active admin and director, each one
    // holding a link that approves or declines the customer without signing in.
    emptyWarning:
      "Approval requests will go to every active admin and director instead — each of them able to approve or decline from the email.",
    fallbackToAdminsAndDirectors: true,
    assignableRoles: ["admin", "director"],
  },
  {
    key: "bid_due_date_report",
    name: "Bid Due Date Report",
    description: "Recipients of the weekly Wednesday estimating report of upcoming bid due dates.",
    emptyWarning: "The weekly bid due date report will not be sent until recipients are added back.",
    fallbackToAdminsAndDirectors: false,
  },
  {
    key: "bid_due_date_report_cc",
    name: "Bid Due Date Report (Cc)",
    description: "Copied on the weekly Wednesday estimating report of upcoming bid due dates.",
    emptyWarning: "The weekly bid due date report will still be sent, but nobody will be copied on it.",
    // A SEPARATE group rather than a flag on a row in the one above, because the two lists answer
    // different questions and fail differently. The `to` list is the report's audience — empty means
    // the report reaches nobody, which the job treats as a hard error. This one is oversight, and an
    // empty oversight list is a choice somebody is allowed to make; the job warns and sends anyway.
    fallbackToAdminsAndDirectors: false,
  },
  {
    key: "marketing_expense_approver",
    name: "Marketing Expense Approver",
    description: "Approves marketing and advertising expense requests.",
    emptyWarning: "Marketing and advertising expense requests will have no approver until one is added back.",
    fallbackToAdminsAndDirectors: false,
  },
];

export function notificationRecipientGroupByKey(key: string): NotificationRecipientGroupDefinition | null {
  return NOTIFICATION_RECIPIENT_GROUPS.find((group) => group.key === key) ?? null;
}
