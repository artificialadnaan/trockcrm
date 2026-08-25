/**
 * Marketing & advertising expense requests — the vocabulary the server, the worker and the client all
 * have to agree on, plus the two money helpers.
 *
 * ON MONEY. There is no decimal library in this repo (no decimal.js / big.js / bignumber.js in any
 * package.json, nothing money-shaped in shared/src/lib/), and `numeric(14,2)` round-trips as a STRING.
 * So: the AUTHORITATIVE `total_requested` is computed in SQL inside the INSERT/UPDATE and never in JS.
 * What lives here is (a) input VALIDATION, which is string-shape checking and involves no arithmetic, and
 * (b) `sumMoneyForDisplay`, an integer-cent sum used only to draw the running total above the submit
 * button. Neither one is ever the value that gets stored.
 */

export const MARKETING_EXPENSE_STATUSES = [
  "draft",
  "pending",
  "approved",
  "denied",
  "withdrawn",
] as const;
export type MarketingExpenseStatus = (typeof MARKETING_EXPENSE_STATUSES)[number];

/** 'skipped' closes out a later step when an earlier one denied, or when the submitter withdrew. */
export const MARKETING_EXPENSE_DECISIONS = ["approved", "denied", "skipped"] as const;
export type MarketingExpenseDecision = (typeof MARKETING_EXPENSE_DECISIONS)[number];

/** What an approver can choose. 'skipped' is written by the system, never by a person. */
export const MARKETING_EXPENSE_APPROVER_DECISIONS = ["approved", "denied"] as const;
export type MarketingExpenseApproverDecision = (typeof MARKETING_EXPENSE_APPROVER_DECISIONS)[number];

export const MARKETING_EXPENSE_PAYMENT_METHODS = [
  "invoice_ap",
  "company_card",
  "reimbursement",
] as const;
export type MarketingExpensePaymentMethod = (typeof MARKETING_EXPENSE_PAYMENT_METHODS)[number];

export const MARKETING_EXPENSE_PAYMENT_METHOD_LABELS: Record<MarketingExpensePaymentMethod, string> = {
  invoice_ap: "Invoice to Accounts Payable",
  company_card: "Company card",
  reimbursement: "Employee reimbursement",
};

export const MARKETING_EXPENSE_ATTACHMENT_KINDS = [
  "quote_proposal",
  "event_details",
  "travel_estimate",
  "other",
] as const;
export type MarketingExpenseAttachmentKind = (typeof MARKETING_EXPENSE_ATTACHMENT_KINDS)[number];

export const MARKETING_EXPENSE_ATTACHMENT_KIND_LABELS: Record<MarketingExpenseAttachmentKind, string> = {
  quote_proposal: "Quote or proposal",
  event_details: "Event details / agenda",
  travel_estimate: "Travel estimate",
  other: "Other supporting document",
};

/** The eight cost columns, in form order. This IS the set the SQL total sums — keep them in step. */
export const MARKETING_EXPENSE_COST_FIELDS = [
  "costAdvertising",
  "costRegistration",
  "costTravel",
  "costLodging",
  "costMeals",
  "costMaterials",
  "costOther1",
  "costOther2",
] as const;
export type MarketingExpenseCostField = (typeof MARKETING_EXPENSE_COST_FIELDS)[number];

export const MARKETING_EXPENSE_COST_LABELS: Record<MarketingExpenseCostField, string> = {
  costAdvertising: "Advertising / sponsorship",
  costRegistration: "Registration / booth fees",
  costTravel: "Travel (air, mileage, rental)",
  costLodging: "Lodging",
  costMeals: "Meals & entertainment",
  costMaterials: "Materials / printing / giveaways",
  costOther1: "Other",
  costOther2: "Other",
};

export const MARKETING_EXPENSE_APPROVER_GROUP_KEY = "marketing_expense_approver";

/**
 * The `AppError` code the submit endpoint returns when the request is already past `draft`.
 *
 * A CONTRACT between two packages, so it lives in one place. The submit endpoint has two 409s — this one
 * and "no approver configured" — and they mean opposite things to the client: this one says the operation
 * SUCCEEDED and its response was lost, the other says it genuinely failed. A mistyped literal on either
 * side turns a recovered submit back into a duplicate request, with nothing failing to say so.
 */
export const MARKETING_EXPENSE_ALREADY_SUBMITTED_CODE = "ALREADY_SUBMITTED";

export function isMarketingExpenseStatus(value: unknown): value is MarketingExpenseStatus {
  return (MARKETING_EXPENSE_STATUSES as readonly string[]).includes(value as string);
}

export function isMarketingExpensePaymentMethod(
  value: unknown,
): value is MarketingExpensePaymentMethod {
  return (MARKETING_EXPENSE_PAYMENT_METHODS as readonly string[]).includes(value as string);
}

export function isMarketingExpenseAttachmentKind(
  value: unknown,
): value is MarketingExpenseAttachmentKind {
  return (MARKETING_EXPENSE_ATTACHMENT_KINDS as readonly string[]).includes(value as string);
}

export function isMarketingExpenseApproverDecision(
  value: unknown,
): value is MarketingExpenseApproverDecision {
  return (MARKETING_EXPENSE_APPROVER_DECISIONS as readonly string[]).includes(value as string);
}

/**
 * The largest value `numeric(14,2)` holds: 12 integer digits and 2 decimals.
 *
 * Every individual cost field may legitimately be this large, which is exactly why the SUM needs its own
 * bound — eight valid inputs can add up to an invalid total, and the overflow lands as a database error
 * during the insert rather than as a validation message.
 */
export const MONEY_COLUMN_MAX_CENTS = 99_999_999_999_999;

/**
 * Does this set of amounts sum to more than the column can hold?
 *
 * Integer CENTS, not floats, and this is VALIDATION rather than computation — the stored `total_requested`
 * is still summed by Postgres inside the INSERT. A range check has to happen before the statement runs, and
 * exact integer arithmetic is the only way to do it without reintroducing the float problem. The maximum
 * possible sum here is 8 x 99999999999999, comfortably inside Number.MAX_SAFE_INTEGER.
 */
export function moneyTotalExceedsColumn(values: ReadonlyArray<unknown>): boolean {
  let cents = 0;
  for (const value of values) {
    const parsed = parseMoneyInput(value);
    if (!parsed.ok) continue;
    const [whole, fraction = ""] = parsed.value.split(".");
    cents += Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  }
  return cents > MONEY_COLUMN_MAX_CENTS;
}

export type MoneyParseResult =
  | { ok: true; value: string }
  | { ok: false; reason: "negative" | "format" };

// Up to 12 integer digits and at most 2 decimals — the exact shape numeric(14,2) stores without rounding.
// Anchored, so no leading sign, no exponent, no thousands separators, no currency symbol.
const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Validate one money field on its way in, WITHOUT arithmetic.
 *
 * A blank CurrencyInput is `""`, which is the form's cleared state and means zero — not an error. Anything
 * else has to look like plain dollars: a negative or an exponent would otherwise reach Postgres and come
 * back as a CHECK-constraint 23514, which the error handler renders as a 500 with no field named. Catching
 * the shape here is what makes it a 400 that says which box is wrong.
 *
 * Returns the ORIGINAL digits, trimmed — never a re-formatted float. `parseFloat("4250.75").toString()`
 * happens to round-trip, but that is a property of this example and not of the type.
 */
export function parseMoneyInput(raw: unknown): MoneyParseResult {
  if (raw === undefined || raw === null) return { ok: true, value: "0" };

  let text: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, reason: "format" };
    if (raw < 0) return { ok: false, reason: "negative" };
    // String(1e21) is "1e+21", which MONEY_PATTERN rejects — deliberately. A number that large is not a
    // marketing expense, and numeric(14,2) could not hold it anyway.
    text = String(raw);
  } else if (typeof raw === "string") {
    text = raw.trim();
    if (text.length === 0) return { ok: true, value: "0" };
    if (text.startsWith("-")) return { ok: false, reason: "negative" };
  } else {
    return { ok: false, reason: "format" };
  }

  if (!MONEY_PATTERN.test(text)) return { ok: false, reason: "format" };
  return { ok: true, value: text };
}

/**
 * The running total the form draws above the submit button. DISPLAY ONLY — the stored total is the SQL
 * sum, recomputed server-side regardless of anything the client sends.
 *
 * Sums in integer CENTS rather than with `+` on floats, so `0.1 + 0.2` reads `0.30` and not
 * `0.30000000000000004`. Unparseable and negative entries count as zero: a half-typed box must not make
 * the total read NaN or go backwards while someone is still typing.
 */
export function sumMoneyForDisplay(values: ReadonlyArray<unknown>): string {
  let cents = 0;
  for (const value of values) {
    const parsed = parseMoneyInput(value);
    if (!parsed.ok) continue;
    const [whole, fraction = ""] = parsed.value.split(".");
    cents += Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  }
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

/**
 * Render a DATE-ONLY value (`needed_by`, a Postgres `date`) as a local calendar date.
 *
 * `new Date("2026-10-01")` is midnight UTC, so `toLocaleDateString()` in Dallas renders 30 September — an
 * expense deadline shown a day early, which is worse than showing none. Building the date from its parts
 * makes it midnight LOCAL instead, so the day that comes out is the day that went in, in every zone.
 *
 * Only for date-only columns. A real timestamptz (`submitted_at`) SHOULD go through the zone-aware path.
 */
export function formatDateOnly(value: string | null | undefined): string {
  if (typeof value !== "string") return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return "—";
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day)).toLocaleDateString();
}

/** Render a numeric(14,2) string as `$1,234.56` for an email body or a table cell. */
export function formatMoney(value: string | number | null | undefined): string {
  const parsed = parseMoneyInput(value ?? "0");
  const amount = parsed.ok ? parsed.value : "0";
  const [whole, fraction = "00"] = amount.split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${grouped}.${fraction.padEnd(2, "0")}`;
}

// ── Queue job contract ──────────────────────────────────────────────────────

/**
 * `job_queue.job_type` for all three emails. Declared HERE, not in the worker job file, because the
 * enqueuer (server) and the handler (worker) cannot import each other and a mistyped literal on either
 * side is a job that is written and never picked up — with nothing failing to say so.
 */
export const MARKETING_EXPENSE_EMAIL_JOB = "marketing_expense_email";

export const MARKETING_EXPENSE_EMAIL_KINDS = [
  "submitted_approver",
  "submitted_submitter",
  "decided_submitter",
] as const;
export type MarketingExpenseEmailKind = (typeof MARKETING_EXPENSE_EMAIL_KINDS)[number];

export function isMarketingExpenseEmailKind(value: unknown): value is MarketingExpenseEmailKind {
  return (MARKETING_EXPENSE_EMAIL_KINDS as readonly string[]).includes(value as string);
}

/**
 * What the enqueuer writes and the handler reads.
 *
 * `tenantSchema` is on the PAYLOAD and not taken from `job_queue.office_id`, which is a UUID FK to
 * `offices(id)` and not a schema name — the reference handler (rfp-vote-outcome.ts) discards its officeId
 * argument for exactly this reason.
 *
 * `snapshot` is FROZEN at enqueue time and re-frozen into the receipt row at claim time. A retry after a
 * later edit must rebuild a byte-identical Resend payload or the idempotency key is rejected as a
 * key/payload mismatch.
 */
export interface MarketingExpenseEmailPayload {
  tenantSchema: string;
  requestId: string;
  emailKind: MarketingExpenseEmailKind;
  /** 0 for the two submit-time kinds; the deciding step for `decided_submitter`. */
  stepOrder: number;
  officeId: string | null;
  recipientEmails: string[];
  snapshot: MarketingExpenseEmailSnapshot;
}

export interface MarketingExpenseEmailSnapshot {
  requestNumber: string;
  requestedByName: string;
  vendorEvent: string;
  neededBy: string | null;
  totalRequested: string;
  purpose: string;
  /** Only on `decided_submitter`. */
  decision: MarketingExpenseApproverDecision | null;
  decisionReason: string | null;
  /** The parent status AFTER the decision, so the body can say whether anything is still outstanding. */
  requestStatus: MarketingExpenseStatus;
}

// ── API shapes ──────────────────────────────────────────────────────────────

export interface MarketingExpenseRequestSummary {
  id: string;
  requestNumber: string;
  status: MarketingExpenseStatus;
  vendorEvent: string;
  neededBy: string | null;
  totalRequested: string;
  submittedAt: string | null;
  createdAt: string;
  submittedByName: string | null;
  /** The decision on the LATEST decided step, when there is one. */
  latestDecision: MarketingExpenseDecision | null;
  latestDecisionReason: string | null;
  latestDecidedByName: string | null;
  latestDecidedAt: string | null;
}

export interface MarketingExpenseRequestDetail extends MarketingExpenseRequestSummary {
  submittedBy: string;
  requestedByName: string;
  department: string | null;
  locationDates: string | null;
  purpose: string;
  expectedReturn: string;
  costAdvertising: string;
  costRegistration: string;
  costTravel: string;
  costLodging: string;
  costMeals: string;
  costMaterials: string;
  costOther1: string;
  costOther1Label: string | null;
  costOther2: string;
  costOther2Label: string | null;
  budgetJobCode: string | null;
  travelRequired: boolean;
  attendees: string | null;
  businessMeetings: string | null;
  paymentMethod: MarketingExpensePaymentMethod | null;
  attachmentKinds: MarketingExpenseAttachmentKind[];
  stepsRequired: number;
  approvals: MarketingExpenseApprovalRow[];
  attachments: MarketingExpenseAttachmentRow[];
}

export interface MarketingExpenseApprovalRow {
  id: string;
  stepOrder: number;
  approverGroupKey: string;
  decision: MarketingExpenseDecision | null;
  decidedByName: string | null;
  decidedAt: string | null;
  reason: string | null;
}

export interface MarketingExpenseAttachmentRow {
  id: string;
  displayName: string;
  fileSizeBytes: number;
  createdAt: string;
}
