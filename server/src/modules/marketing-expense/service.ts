import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { alias } from "drizzle-orm/pg-core";
import {
  files,
  jobQueue,
  marketingExpenseRequestApprovals,
  marketingExpenseRequests,
  users,
} from "@trock-crm/shared/schema";
import * as schema from "@trock-crm/shared/schema";
import {
  MARKETING_EXPENSE_ALREADY_SUBMITTED_CODE,
  MARKETING_EXPENSE_APPROVER_GROUP_KEY,
  MARKETING_EXPENSE_COST_LABELS,
  MARKETING_EXPENSE_EMAIL_JOB,
  isMarketingExpenseAttachmentKind,
  isMarketingExpensePaymentMethod,
  notificationRecipientGroupByKey,
  moneyTotalExceedsColumn,
  parseMoneyInput,
  type MarketingExpenseApprovalRow,
  type MarketingExpenseApproverDecision,
  type MarketingExpenseAttachmentKind,
  type MarketingExpenseEmailKind,
  type MarketingExpenseEmailPayload,
  type MarketingExpenseEmailSnapshot,
  type MarketingExpensePaymentMethod,
  type MarketingExpenseRequestDetail,
  type MarketingExpenseRequestSummary,
  type MarketingExpenseStatus,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { isPostgresCalendarDate } from "../../lib/pg-timestamp.js";
import { getNotificationRecipients } from "../leads/due-diligence-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * The marketing & advertising expense request service.
 *
 * THE LIFECYCLE IS THE POINT. `POST` writes a `draft`, the client uploads attachments against the returned
 * id, and `POST /:id/submit` flips it to `pending` and enqueues the mail. Any other ordering is broken:
 * `files.marketing_expense_request_id` needs an id that does not exist before the row does, and emailing
 * the approver at create time sends them a request whose supporting documents have not been uploaded yet.
 *
 * MONEY IS NEVER ADDED IN JAVASCRIPT. `total_requested` is a SQL expression inside the INSERT. The eight
 * cost values are validated as STRINGS on the way in (shape only, no arithmetic) and handed to Postgres to
 * sum. There is no decimal library in this repo, and `numeric` round-trips as a string precisely so nobody
 * is tempted to use `+`.
 */

/** MER- plus four digits. 9999 requests per office; the allocator raises rather than wrapping. */
const REQUEST_NUMBER_PREFIX = "MER-";
const REQUEST_NUMBER_DIGITS = 4;
const MAX_REQUEST_NUMBER = 10 ** REQUEST_NUMBER_DIGITS - 1;

/**
 * How many times a create will re-allocate after losing a race for a number.
 *
 * Three, not one: a retry only happens when another transaction committed the same number between this
 * one's SELECT ... FOR UPDATE and its INSERT, and each retry re-reads the counter, so the loop makes
 * progress. Unbounded would turn a genuinely exhausted range into a spin.
 */
const REQUEST_NUMBER_ATTEMPTS = 3;

const COST_COLUMNS = [
  ["costAdvertising", "cost_advertising"],
  ["costRegistration", "cost_registration"],
  ["costTravel", "cost_travel"],
  ["costLodging", "cost_lodging"],
  ["costMeals", "cost_meals"],
  ["costMaterials", "cost_materials"],
  ["costOther1", "cost_other_1"],
  ["costOther2", "cost_other_2"],
] as const;

export interface MarketingExpenseRequestInput {
  requestedByName?: unknown;
  department?: unknown;
  neededBy?: unknown;
  vendorEvent?: unknown;
  locationDates?: unknown;
  purpose?: unknown;
  expectedReturn?: unknown;
  costAdvertising?: unknown;
  costRegistration?: unknown;
  costTravel?: unknown;
  costLodging?: unknown;
  costMeals?: unknown;
  costMaterials?: unknown;
  costOther1?: unknown;
  costOther1Label?: unknown;
  costOther2?: unknown;
  costOther2Label?: unknown;
  budgetJobCode?: unknown;
  travelRequired?: unknown;
  attendees?: unknown;
  businessMeetings?: unknown;
  paymentMethod?: unknown;
  attachmentKinds?: unknown;
}

interface ActingUser {
  id: string;
  role: string;
}

// ─── input normalisation ─────────────────────────────────────────────────────

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requiredText(value: unknown, label: string): string {
  const trimmed = optionalText(value);
  if (!trimmed) throw new AppError(400, `${label} is required.`);
  return trimmed;
}

/**
 * `YYYY-MM-DD` only, and a REAL calendar date.
 *
 * A `date` column takes no time, and a full ISO string would silently shift by zone. The shape check alone
 * is not enough: "2026-02-31" matches the regex, Postgres rejects the cast, and the generic error handler
 * renders that as a 500 with no field named — the same failure the money validators exist to prevent, on a
 * different column. `isPostgresCalendarDate` is the repo's existing validator and catches what no regex
 * can, because `Date.parse` rolls calendar overflow forward and reports success.
 */
function optionalDate(value: unknown, label: string): string | null {
  const trimmed = optionalText(value);
  if (!trimmed) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match || !isPostgresCalendarDate(match[1]!, match[2]!, match[3]!)) {
    throw new AppError(400, `${label} must be a real calendar date (YYYY-MM-DD).`);
  }
  return trimmed;
}

/**
 * Validate one cost box and return the digits.
 *
 * A blank box is the form's cleared state and means zero. A negative or an exponent is a 400 that names
 * the field — left to reach Postgres it would come back as a 23514 CHECK violation, which the error
 * handler renders as a 500 with no indication of which of eight boxes is wrong.
 */
function normalizeCost(value: unknown, label: string): string {
  const parsed = parseMoneyInput(value);
  if (parsed.ok) return parsed.value;
  throw new AppError(
    400,
    parsed.reason === "negative"
      ? `${label} cannot be negative.`
      : `${label} must be a dollar amount (up to two decimal places).`,
  );
}

function normalizePaymentMethod(value: unknown): MarketingExpensePaymentMethod | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isMarketingExpensePaymentMethod(value)) {
    throw new AppError(400, "Payment method must be invoice_ap, company_card or reimbursement.");
  }
  return value;
}

function normalizeAttachmentKinds(value: unknown): MarketingExpenseAttachmentKind[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AppError(400, "Attachment kinds must be a list.");
  const kinds: MarketingExpenseAttachmentKind[] = [];
  for (const entry of value) {
    if (!isMarketingExpenseAttachmentKind(entry)) {
      throw new AppError(400, `"${String(entry)}" is not a supported attachment kind.`);
    }
    if (!kinds.includes(entry)) kinds.push(entry);
  }
  return kinds;
}

// ─── request number ──────────────────────────────────────────────────────────

/**
 * Allocate the next `MER-nnnn` for this office.
 *
 * Three statements, in this order and for these reasons — the house pattern from
 * `services/projectNumber.ts` against migration 0068, and NOT a `CREATE SEQUENCE`, of which there is not
 * one anywhere in `migrations/`:
 *   1. INSERT ... ON CONFLICT DO NOTHING so the counter row exists on an office's first ever request.
 *   2. SELECT ... FOR UPDATE, which is what actually serialises concurrent callers. The request already
 *      runs inside the tenant transaction (middleware/tenant.ts), so the lock is held to commit.
 *   3. UPDATE the counter.
 * Swapping (2) and (3) — bumping before locking — is the mistake that hands two requests the same number,
 * and it is invisible to any test that runs its cases one after another. Hence the order is asserted
 * directly, and the UNIQUE constraint backstops it in the database.
 */
export async function allocateRequestNumber(tenantDb: TenantDb, tenantSchema: string): Promise<string> {
  await tenantDb.execute(sql`
    INSERT INTO public.marketing_expense_request_sequences (tenant_schema, last_number)
    VALUES (${tenantSchema}, 0)
    ON CONFLICT (tenant_schema) DO NOTHING
  `);

  const locked = await tenantDb.execute(sql`
    SELECT last_number
      FROM public.marketing_expense_request_sequences
     WHERE tenant_schema = ${tenantSchema}
     FOR UPDATE
  `);
  const lockedRows = (Array.isArray(locked) ? locked : locked.rows ?? []) as Array<{
    last_number?: number | string | null;
  }>;
  const next = Number(lockedRows[0]?.last_number ?? 0) + 1;
  if (!Number.isFinite(next) || next > MAX_REQUEST_NUMBER) {
    throw new AppError(
      500,
      `This office has used every ${REQUEST_NUMBER_PREFIX} number (max ${MAX_REQUEST_NUMBER}).`,
    );
  }

  await tenantDb.execute(sql`
    UPDATE public.marketing_expense_request_sequences
       SET last_number = ${next}, updated_at = NOW()
     WHERE tenant_schema = ${tenantSchema}
  `);

  return `${REQUEST_NUMBER_PREFIX}${String(next).padStart(REQUEST_NUMBER_DIGITS, "0")}`;
}

// ─── create ──────────────────────────────────────────────────────────────────

export async function createMarketingExpenseRequest(
  tenantDb: TenantDb,
  args: { tenantSchema: string; userId: string; input: MarketingExpenseRequestInput },
): Promise<MarketingExpenseRequestDetail> {
  const { tenantSchema, userId, input } = args;

  const requestedByName = requiredText(input.requestedByName, "Requested by (name)");
  const vendorEvent = requiredText(input.vendorEvent, "Vendor / event");
  const purpose = requiredText(input.purpose, "What is the request for?");
  const expectedReturn = requiredText(input.expectedReturn, "What will TRC receive in return?");

  const costs = Object.fromEntries(
    COST_COLUMNS.map(([field]) => [field, normalizeCost(input[field], MARKETING_EXPENSE_COST_LABELS[field])]),
  ) as Record<(typeof COST_COLUMNS)[number][0], string>;

  // Each field may hold the column maximum on its own, so eight VALID inputs can still sum to an invalid
  // total. Postgres would report that as an overflow during the INSERT, which reaches the client as a 500
  // naming nothing. Checked in exact integer cents; the stored total is still summed in SQL.
  if (moneyTotalExceedsColumn(COST_COLUMNS.map(([field]) => costs[field]))) {
    throw new AppError(
      400,
      "The total requested is larger than this form can record. Check the estimated cost lines.",
    );
  }

  const values = {
    status: "draft" as const,
    submittedBy: userId,
    requestedByName,
    department: optionalText(input.department),
    neededBy: optionalDate(input.neededBy, "Needed by"),
    vendorEvent,
    locationDates: optionalText(input.locationDates),
    purpose,
    expectedReturn,
    ...costs,
    costOther1Label: optionalText(input.costOther1Label),
    costOther2Label: optionalText(input.costOther2Label),
    // THE TOTAL IS A SQL EXPRESSION. Postgres adds the eight validated amounts; JavaScript never sees a
    // sum. A client-supplied `totalRequested` is not read at all — it is not in MarketingExpenseRequestInput.
    totalRequested: sql`(${sql.join(
      COST_COLUMNS.map(([field]) => sql`${costs[field]}::numeric(14,2)`),
      sql` + `,
    )})`,
    budgetJobCode: optionalText(input.budgetJobCode),
    travelRequired: input.travelRequired === true,
    attendees: optionalText(input.attendees),
    businessMeetings: optionalText(input.businessMeetings),
    paymentMethod: normalizePaymentMethod(input.paymentMethod),
    attachmentKinds: normalizeAttachmentKinds(input.attachmentKinds),
  };

  for (let attempt = 0; attempt < REQUEST_NUMBER_ATTEMPTS; attempt += 1) {
    const requestNumber = await allocateRequestNumber(tenantDb, tenantSchema);
    // ON CONFLICT DO NOTHING rather than catching a 23505: inside the tenant transaction a thrown unique
    // violation poisons every subsequent statement (25P02), so the retry could not run. An empty RETURNING
    // is the collision signal, and it leaves the transaction usable.
    const [row] = await tenantDb
      .insert(marketingExpenseRequests)
      .values({ ...values, requestNumber })
      .onConflictDoNothing({ target: marketingExpenseRequests.requestNumber })
      .returning({ id: marketingExpenseRequests.id });
    if (row) {
      return loadDetail(tenantDb, row.id);
    }
  }

  throw new AppError(
    409,
    "Could not allocate a request number. Please try submitting the form again.",
  );
}

// ─── submit ──────────────────────────────────────────────────────────────────

export async function submitMarketingExpenseRequest(
  tenantDb: TenantDb,
  args: { tenantSchema: string; officeId: string | null; userId: string; requestId: string },
): Promise<MarketingExpenseRequestDetail> {
  const { tenantSchema, officeId, userId, requestId } = args;

  // lockRow, not loadRow: submit writes the parent and then inserts an approval row, so it takes the same
  // two tables as decide and withdraw and has to take them in the same order — parent first.
  const request = await lockRow(tenantDb, requestId);
  if (request.submittedBy !== userId) {
    throw new AppError(403, "You can only submit your own expense request.");
  }
  if (request.status !== "draft") {
    // CODED, because the client has to tell this apart from the other 409 this endpoint can return
    // ("no approver configured"). If a submit commits and its RESPONSE is lost, the retry lands here and
    // the honest answer is "it worked" — without the code the client can only show a failure for an
    // operation that succeeded, and the user creates a duplicate request.
    throw new AppError(409, "This request has already been submitted.", MARKETING_EXPENSE_ALREADY_SUBMITTED_CODE);
  }
  // A $0.00 request is a form somebody abandoned halfway, not an expense. The React form already refuses
  // it, which is exactly the problem: that made the client the ONLY validation, so any direct API caller
  // could put an empty request in front of the approver. Checked at SUBMIT rather than at create, because a
  // draft is a work in progress and the gate that matters is the one into the approver's queue.
  if (Number(request.totalRequested) <= 0) {
    throw new AppError(
      400,
      "Enter at least one estimated cost — a request for $0.00 cannot be submitted.",
    );
  }

  // A draft that DECLARED supporting documents and has none is a half-finished upload.
  //
  // Reachable when the page is reloaded mid-upload and the draft is resumed from the status page, which
  // has no way to know which files never landed. Now that attachments freeze at submit, letting it through
  // means the evidence can never be supplied — so the request would go to an approver permanently missing
  // the documents its own author said it needed. Their declaration is the check.
  if (request.attachmentKinds.length > 0) {
    const [attached] = await tenantDb
      .select({ count: sql<number>`count(*)::int` })
      .from(files)
      .where(and(eq(files.marketingExpenseRequestId, requestId), eq(files.isActive, true)));
    if (Number(attached?.count ?? 0) === 0) {
      throw new AppError(
        400,
        "This request lists supporting documents but none were uploaded. Attach them before submitting — they cannot be added afterwards.",
      );
    }
  }

  // Resolve the approver BEFORE the write. An empty group is not a warning to log past: the whole point of
  // the feature is that somebody is asked to approve, and the submitter's own confirmation would otherwise
  // arrive as evidence that something happened when nothing did. Throwing here rolls the transaction back,
  // so the row stays a draft and the submit is retryable the moment an admin fixes the group.
  const approverEmails = await resolveApproverEmails(tenantDb);
  const submitterEmail = await resolveUserEmail(tenantDb, userId);

  const now = new Date();
  const [updated] = await tenantDb
    .update(marketingExpenseRequests)
    .set({ status: "pending", submittedAt: now, updatedAt: now })
    // The status guard is in the WHERE, not only in the read above: two clicks on Submit arrive as two
    // requests, and the second must find nothing to update rather than re-enqueue the mail.
    .where(and(eq(marketingExpenseRequests.id, requestId), eq(marketingExpenseRequests.status, "draft")))
    .returning({ id: marketingExpenseRequests.id });
  if (!updated) {
    throw new AppError(409, "This request has already been submitted.", MARKETING_EXPENSE_ALREADY_SUBMITTED_CODE);
  }

  // `stepsRequired` is the parent-side contract for this request's approval workflow. Creating only
  // step 1 when it is greater than one leaves the parent pending after step 1 but with no remaining row
  // that can be decided. Materialize every configured step atomically with the draft -> pending transition.
  await tenantDb.insert(marketingExpenseRequestApprovals).values(
    Array.from({ length: request.stepsRequired }, (_, index) => ({
      requestId,
      stepOrder: index + 1,
      approverGroupKey: MARKETING_EXPENSE_APPROVER_GROUP_KEY,
    })),
  );

  const detail = await loadDetail(tenantDb, requestId);
  const snapshot = buildSnapshot(detail, { decision: null, decisionReason: null });

  await enqueueEmail(tenantDb, {
    tenantSchema,
    requestId,
    emailKind: "submitted_approver",
    stepOrder: 0,
    officeId,
    recipientEmails: approverEmails,
    snapshot,
  });
  if (submitterEmail) {
    await enqueueEmail(tenantDb, {
      tenantSchema,
      requestId,
      emailKind: "submitted_submitter",
      stepOrder: 0,
      officeId,
      recipientEmails: [submitterEmail],
      snapshot,
    });
  }

  return detail;
}

// ─── decide ──────────────────────────────────────────────────────────────────

export async function decideMarketingExpenseRequest(
  tenantDb: TenantDb,
  args: {
    tenantSchema: string;
    officeId: string | null;
    requestId: string;
    userId: string;
    decision: MarketingExpenseApproverDecision;
    reason: string | null;
  },
): Promise<MarketingExpenseRequestDetail> {
  const { tenantSchema, officeId, requestId, userId, decision } = args;

  const reason = optionalText(args.reason);
  if (decision === "denied" && !reason) {
    throw new AppError(400, "A reason is required when denying a request.");
  }

  const request = await lockRow(tenantDb, requestId);
  if (request.status !== "pending") {
    throw new AppError(409, "This request is no longer awaiting a decision.");
  }

  const approvals = await loadApprovals(tenantDb, requestId);
  const nextStep = nextActionableStep(approvals);
  if (nextStep === null) {
    throw new AppError(409, "This request has already been decided.");
  }

  const now = new Date();
  const [decided] = await tenantDb
    .update(marketingExpenseRequestApprovals)
    .set({ decision, decidedBy: userId, decidedAt: now, reason, updatedAt: now })
    .where(undecidedStepWhere(requestId, nextStep))
    .returning({ id: marketingExpenseRequestApprovals.id });
  if (!decided) {
    throw new AppError(409, "This request has already been decided.");
  }

  const approvedSteps = approvals.filter((row) => row.decision === "approved").length + (decision === "approved" ? 1 : 0);
  let nextStatus: MarketingExpenseStatus = "pending";
  if (decision === "denied") {
    nextStatus = "denied";
    // Close out every later step. Without this a denial at step 1 leaves step 2 sitting in the queue with
    // `decision IS NULL` forever, and no screen would ever show why.
    await skipOpenSteps(tenantDb, requestId, nextStep);
  } else if (approvedSteps >= request.stepsRequired) {
    nextStatus = "approved";
  }

  // Write the parent status CONDITIONED on the status this decision was authorised against.
  //
  // `loadRow` above observed `pending`, but that was a READ, and a read cannot exclude a write that commits
  // after it. Between it and here the submitter can withdraw — and an id-only UPDATE would then overwrite a
  // successfully committed `withdrawn` with `approved`, and go on to email them a decision on a request
  // they had already pulled. Zero rows means the precondition no longer holds, and the correct answer is
  // the same 409 the approval row gives: somebody else got here first.
  //
  // Run unconditionally, including on the not-yet-final multi-step path where `nextStatus` is still
  // `pending`. That case writes nothing new, but it still has to VERIFY the request is the thing it was
  // authorised against before the decision email goes out.
  const [finalized] = await tenantDb
    .update(marketingExpenseRequests)
    .set({ status: nextStatus, updatedAt: now })
    .where(
      and(eq(marketingExpenseRequests.id, requestId), eq(marketingExpenseRequests.status, "pending")),
    )
    .returning({ id: marketingExpenseRequests.id });
  if (!finalized) {
    throw new AppError(409, "This request is no longer awaiting a decision.");
  }

  const detail = await loadDetail(tenantDb, requestId);
  const submitterEmail = await resolveUserEmail(tenantDb, request.submittedBy);
  if (submitterEmail) {
    await enqueueEmail(tenantDb, {
      tenantSchema,
      requestId,
      emailKind: "decided_submitter",
      stepOrder: nextStep,
      officeId,
      recipientEmails: [submitterEmail],
      snapshot: buildSnapshot(detail, { decision, decisionReason: reason }),
    });
  }

  return detail;
}

// ─── withdraw ────────────────────────────────────────────────────────────────

export async function withdrawMarketingExpenseRequest(
  tenantDb: TenantDb,
  args: { requestId: string; userId: string },
): Promise<MarketingExpenseRequestDetail> {
  const request = await lockRow(tenantDb, args.requestId);
  if (request.submittedBy !== args.userId) {
    throw new AppError(403, "You can only withdraw your own expense request.");
  }
  if (request.status !== "pending") {
    throw new AppError(409, "Only a pending request can be withdrawn.");
  }

  const now = new Date();
  const [updated] = await tenantDb
    .update(marketingExpenseRequests)
    .set({ status: "withdrawn", updatedAt: now })
    .where(
      and(eq(marketingExpenseRequests.id, args.requestId), eq(marketingExpenseRequests.status, "pending")),
    )
    .returning({ id: marketingExpenseRequests.id });
  if (!updated) {
    throw new AppError(409, "Only a pending request can be withdrawn.");
  }

  // Same reasoning as the denial path: an open step on a withdrawn request is a queue entry nobody can
  // action and nobody can clear.
  await skipOpenSteps(tenantDb, args.requestId, 0);

  // No email. The submitter is the person who just did this; telling them about it is noise, and the
  // approver's inbox already holds a request that the queue no longer lists.
  return loadDetail(tenantDb, args.requestId);
}

// ─── reads ───────────────────────────────────────────────────────────────────

export async function listMyMarketingExpenseRequests(
  tenantDb: TenantDb,
  userId: string,
): Promise<MarketingExpenseRequestSummary[]> {
  return listSummaries(tenantDb, eq(marketingExpenseRequests.submittedBy, userId));
}

export async function listMarketingExpenseQueue(
  tenantDb: TenantDb,
  status: Exclude<MarketingExpenseStatus, "draft">,
): Promise<MarketingExpenseRequestSummary[]> {
  // `draft` is unreachable by construction: it is excluded from the parameter type AND a draft has no
  // approval row, so it could not be actioned even if it were listed.
  return listSummaries(tenantDb, eq(marketingExpenseRequests.status, status));
}

export async function getMarketingExpenseRequest(
  tenantDb: TenantDb,
  args: { requestId: string; user: ActingUser },
): Promise<MarketingExpenseRequestDetail> {
  await assertMarketingExpenseRequestReadAccess(tenantDb, args.requestId, args.user);
  return loadDetail(tenantDb, args.requestId);
}

/**
 * May this user SEE this request — and therefore anything filed against it?
 *
 * Submitter or approver, and it does NOT close on a decision: an approver has to be able to re-open the
 * evidence they approved, and the submitter keeps their own record.
 *
 * Extracted because `files` needs it. That module authorizes per association — deal files through the deal
 * check, lead files through the lead check — and an expense-request attachment matched no branch, so it
 * fell through to "office-shared" and any same-office CRM user holding the UUID could pull a presigned
 * download URL for a request this very function would refuse them. An attachment here is a quote, a
 * contract, or pricing.
 *
 * Deliberately NOT the same rule as `assertMarketingExpenseAttachmentAccess`. That one is submitter-only
 * and closes on decision, because it governs WRITING evidence. Wiring it into the read paths would lock
 * approvers out of the documents they are being asked to approve.
 *
 * A DRAFT is the submitter's alone, approver or not. Under the create-as-draft flow every request passes
 * through that state, so "approvers can read drafts" means approvers can read everyone's half-filled forms,
 * placeholder numbers and mid-upload attachments — none of which the submitter has decided to show anyone.
 * Approvers see a request when it is submitted, which is also the moment the queue starts listing it.
 */
export async function assertMarketingExpenseRequestReadAccess(
  tenantDb: TenantDb,
  requestId: string,
  user: ActingUser,
): Promise<void> {
  const request = await loadRow(tenantDb, requestId);
  if (request.submittedBy === user.id) return;
  if (!isApprover(user) || request.status === "draft") {
    throw new AppError(403, "You do not have access to this expense request.");
  }
}

/**
 * Who may see the queue and decide.
 *
 * Role, not group membership — see the module's PR notes. The recipient group is an EMAIL ROUTING list;
 * approver-group AUTHORIZATION does not exist anywhere in this codebase, and the admin page that manages
 * the group can only assign users who are already admin or director, so a membership branch could not
 * admit anybody this does not.
 */
export function isApprover(user: ActingUser): boolean {
  return user.role === "admin" || user.role === "director";
}

/**
 * May this user attach a supporting document to this request?
 *
 * The SUBMITTER only, and only while the request is still a DRAFT.
 *
 * Not the approver: a supporting document is part of the case being made, and an approver quietly adding
 * one to somebody's request changes what the record says was submitted. Not after a decision either — the
 * attachments are the evidence the approver saw, and appending to them afterwards makes the trail a lie.
 *
 * CALLED TWICE, ON PURPOSE — once when the upload grant is issued and again inside `confirmUpload`, on the
 * association that is about to be persisted. Once was not enough: an upload is two round trips with an
 * arbitrarily long gap, so a grant taken against a draft could be confirmed after the request had been
 * approved, denied or withdrawn, and the evidence would land on a decided request. The second call re-reads
 * the request ROW; nothing carried in the grant is trusted, because the grant is exactly the thing that
 * went stale.
 *
 * Takes a user ID, not a role-bearing user: this rule has no approver branch and never had one, and a
 * `role` parameter it does not read invites a caller to believe otherwise.
 *
 * READS UNDER A LOCK (`lockRow`), which is the difference between a guard and a snapshot. Unlocked, a
 * finalization can commit between this check and the caller's write — the file insert in `confirmUpload`,
 * the metadata UPDATE in PATCH — and the evidence still lands on a decided request. The lock is taken in
 * the caller's transaction (the tenant middleware wraps the whole request), so it is held through the write
 * to commit and the two cannot straddle a status change.
 */
export async function assertMarketingExpenseAttachmentAccess(
  tenantDb: TenantDb,
  requestId: string,
  userId: string,
): Promise<void> {
  const request = await lockRow(tenantDb, requestId);
  if (request.submittedBy !== userId) {
    throw new AppError(403, "You can only attach files to your own expense request.");
  }
  // DRAFT ONLY. The window closes at SUBMIT, not at the decision.
  //
  // Submitting is the moment the approver is notified, and the create-upload-submit ordering exists so the
  // evidence is complete before that happens. Leaving the window open until a decision meant the approver
  // could read one set of documents and decide against another, with nothing recording which they saw.
  //
  // The cost is real and accepted: a submitter who forgot a document cannot add it, because withdrawing is
  // terminal here. That is a worse day for one person than a record nobody can trust is for everyone, and
  // making a withdrawn request editable again is a product decision this PR should not make quietly.
  if (request.status !== "draft") {
    throw new AppError(
      409,
      "This request has already been submitted — its attachments are final.",
    );
  }
}

// ─── internals ───────────────────────────────────────────────────────────────

async function loadRow(tenantDb: TenantDb, requestId: string) {
  const [row] = await tenantDb
    .select({
      id: marketingExpenseRequests.id,
      status: marketingExpenseRequests.status,
      submittedBy: marketingExpenseRequests.submittedBy,
      stepsRequired: marketingExpenseRequests.stepsRequired,
    })
    .from(marketingExpenseRequests)
    .where(eq(marketingExpenseRequests.id, requestId))
    .limit(1);
  if (!row) throw new AppError(404, "Expense request not found.");
  return row;
}

/**
 * Read the request AND take its row lock, for the two flows that go on to write both tables.
 *
 * ONE LOCK ORDER, PARENT FIRST. Deciding used to lock the approval row (its first UPDATE) and reach the
 * parent second; withdrawing locks the parent first and the approval rows second. Two request-scoped
 * transactions taking the same two rows in opposite orders is a deadlock cycle, and the loser dies with a
 * Postgres error instead of the 409 this module works to produce. Locking the parent up front in BOTH puts
 * them in the same order, so one simply waits.
 *
 * It also sharpens the conflict: `FOR UPDATE` re-reads the newest committed row once the lock is granted,
 * so the waiter observes `withdrawn` and refuses at the status check rather than at the guarded write.
 */
async function lockRow(tenantDb: TenantDb, requestId: string) {
  const [row] = await tenantDb
    .select({
      id: marketingExpenseRequests.id,
      status: marketingExpenseRequests.status,
      submittedBy: marketingExpenseRequests.submittedBy,
      stepsRequired: marketingExpenseRequests.stepsRequired,
      totalRequested: marketingExpenseRequests.totalRequested,
      attachmentKinds: marketingExpenseRequests.attachmentKinds,
    })
    .from(marketingExpenseRequests)
    .where(eq(marketingExpenseRequests.id, requestId))
    .limit(1)
    .for("update");
  if (!row) throw new AppError(404, "Expense request not found.");
  return row;
}

async function loadApprovals(tenantDb: TenantDb, requestId: string) {
  return tenantDb
    .select({
      stepOrder: marketingExpenseRequestApprovals.stepOrder,
      decision: marketingExpenseRequestApprovals.decision,
    })
    .from(marketingExpenseRequestApprovals)
    .where(eq(marketingExpenseRequestApprovals.requestId, requestId))
    .orderBy(asc(marketingExpenseRequestApprovals.stepOrder));
}

/**
 * The decide UPDATE's WHERE: this request, this step, and STILL UNDECIDED.
 *
 * Keyed on (requestId, stepOrder) and NOT on the approval row's own id, because the route's `:id` is the
 * REQUEST — filtering by the approval id would 404 every decision.
 *
 * `isNull(decision)` is the RACE guard, and it is the one thing in this module that this repo's test
 * harness cannot exercise. Every server suite here runs on PGlite, which is a single in-process connection,
 * so two overlapping transactions are not expressible; the `nextActionableStep` pre-check above therefore
 * answers every sequential case before this clause is reached, and deleting the clause leaves a full green
 * suite. That is exactly why it is extracted: what CAN be proven is that the predicate the database
 * receives still contains it, and `service-decide-guard.test.ts` asserts on the rendered SQL. Under real
 * concurrency it is the only thing standing between two approvers and two accepted decisions — the
 * pre-check reads, and a read cannot exclude a write that commits after it.
 */
export function undecidedStepWhere(requestId: string, stepOrder: number) {
  return and(
    eq(marketingExpenseRequestApprovals.requestId, requestId),
    eq(marketingExpenseRequestApprovals.stepOrder, stepOrder),
    isNull(marketingExpenseRequestApprovals.decision),
  )!;
}

/**
 * The single step a decision may land on: the lowest undecided step whose every predecessor is approved.
 *
 * Sequencing lives here rather than in a `WHERE`, because "step 2 is decidable" is a statement about step
 * 1. Both rows are `decision IS NULL` before anything happens, so a per-row guard alone would happily let
 * step 2 be decided first.
 */
function nextActionableStep(
  approvals: Array<{ stepOrder: number; decision: string | null }>,
): number | null {
  for (const approval of approvals) {
    if (approval.decision === null) return approval.stepOrder;
    if (approval.decision !== "approved") return null;
  }
  return null;
}

async function skipOpenSteps(tenantDb: TenantDb, requestId: string, afterStep: number) {
  const now = new Date();
  await tenantDb
    .update(marketingExpenseRequestApprovals)
    .set({ decision: "skipped", decidedAt: now, updatedAt: now })
    .where(
      and(
        eq(marketingExpenseRequestApprovals.requestId, requestId),
        isNull(marketingExpenseRequestApprovals.decision),
        sql`${marketingExpenseRequestApprovals.stepOrder} > ${afterStep}`,
      ),
    );
}

async function listSummaries(
  tenantDb: TenantDb,
  where: ReturnType<typeof eq>,
): Promise<MarketingExpenseRequestSummary[]> {
  const submitter = alias(users, "marketing_expense_submitter");
  const rows = await tenantDb
    .select({
      id: marketingExpenseRequests.id,
      requestNumber: marketingExpenseRequests.requestNumber,
      status: marketingExpenseRequests.status,
      vendorEvent: marketingExpenseRequests.vendorEvent,
      neededBy: marketingExpenseRequests.neededBy,
      totalRequested: marketingExpenseRequests.totalRequested,
      submittedAt: marketingExpenseRequests.submittedAt,
      createdAt: marketingExpenseRequests.createdAt,
      submittedByName: submitter.displayName,
    })
    .from(marketingExpenseRequests)
    .leftJoin(submitter, eq(submitter.id, marketingExpenseRequests.submittedBy))
    .where(where)
    .orderBy(desc(marketingExpenseRequests.createdAt));

  if (rows.length === 0) return [];
  const latest = await latestDecisions(
    tenantDb,
    rows.map((row) => row.id),
  );

  return rows.map((row) => ({
    ...row,
    status: row.status as MarketingExpenseStatus,
    submittedAt: toIso(row.submittedAt),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    ...(latest.get(row.id) ?? {
      latestDecision: null,
      latestDecisionReason: null,
      latestDecidedByName: null,
      latestDecidedAt: null,
    }),
  }));
}

async function latestDecisions(tenantDb: TenantDb, requestIds: string[]) {
  const decider = alias(users, "marketing_expense_decider");
  const rows = await tenantDb
    .select({
      requestId: marketingExpenseRequestApprovals.requestId,
      stepOrder: marketingExpenseRequestApprovals.stepOrder,
      decision: marketingExpenseRequestApprovals.decision,
      reason: marketingExpenseRequestApprovals.reason,
      decidedAt: marketingExpenseRequestApprovals.decidedAt,
      decidedByName: decider.displayName,
    })
    .from(marketingExpenseRequestApprovals)
    .leftJoin(decider, eq(decider.id, marketingExpenseRequestApprovals.decidedBy))
    .where(inArray(marketingExpenseRequestApprovals.requestId, requestIds))
    .orderBy(asc(marketingExpenseRequestApprovals.stepOrder));

  const map = new Map<string, Pick<MarketingExpenseRequestSummary,
    "latestDecision" | "latestDecisionReason" | "latestDecidedByName" | "latestDecidedAt">>();
  for (const row of rows) {
    // A person's decision, not a system `skipped`: a skipped step is bookkeeping and would otherwise
    // overwrite the denial that caused it in the "Decision" column.
    if (row.decision !== "approved" && row.decision !== "denied") continue;
    map.set(row.requestId, {
      latestDecision: row.decision,
      latestDecisionReason: row.reason,
      latestDecidedByName: row.decidedByName,
      latestDecidedAt: toIso(row.decidedAt),
    });
  }
  return map;
}

async function loadDetail(tenantDb: TenantDb, requestId: string): Promise<MarketingExpenseRequestDetail> {
  const submitter = alias(users, "marketing_expense_submitter");
  const [row] = await tenantDb
    .select({
      request: marketingExpenseRequests,
      submittedByName: submitter.displayName,
    })
    .from(marketingExpenseRequests)
    .leftJoin(submitter, eq(submitter.id, marketingExpenseRequests.submittedBy))
    .where(eq(marketingExpenseRequests.id, requestId))
    .limit(1);
  if (!row) throw new AppError(404, "Expense request not found.");

  const decider = alias(users, "marketing_expense_decider");
  const approvalRows = await tenantDb
    .select({
      id: marketingExpenseRequestApprovals.id,
      stepOrder: marketingExpenseRequestApprovals.stepOrder,
      approverGroupKey: marketingExpenseRequestApprovals.approverGroupKey,
      decision: marketingExpenseRequestApprovals.decision,
      decidedAt: marketingExpenseRequestApprovals.decidedAt,
      reason: marketingExpenseRequestApprovals.reason,
      decidedByName: decider.displayName,
    })
    .from(marketingExpenseRequestApprovals)
    .leftJoin(decider, eq(decider.id, marketingExpenseRequestApprovals.decidedBy))
    .where(eq(marketingExpenseRequestApprovals.requestId, requestId))
    .orderBy(asc(marketingExpenseRequestApprovals.stepOrder));

  const attachmentRows = await tenantDb
    .select({
      id: files.id,
      displayName: files.displayName,
      fileSizeBytes: files.fileSizeBytes,
      createdAt: files.createdAt,
    })
    .from(files)
    .where(and(eq(files.marketingExpenseRequestId, requestId), eq(files.isActive, true)))
    .orderBy(asc(files.createdAt));

  const approvals: MarketingExpenseApprovalRow[] = approvalRows.map((approval) => ({
    id: approval.id,
    stepOrder: approval.stepOrder,
    approverGroupKey: approval.approverGroupKey,
    decision: approval.decision as MarketingExpenseApprovalRow["decision"],
    decidedByName: approval.decidedByName,
    decidedAt: toIso(approval.decidedAt),
    reason: approval.reason,
  }));
  const person = approvals.filter((a) => a.decision === "approved" || a.decision === "denied").at(-1) ?? null;
  const request = row.request;

  return {
    id: request.id,
    requestNumber: request.requestNumber,
    status: request.status as MarketingExpenseStatus,
    vendorEvent: request.vendorEvent,
    neededBy: request.neededBy,
    totalRequested: request.totalRequested,
    submittedAt: toIso(request.submittedAt),
    createdAt: toIso(request.createdAt) ?? new Date(0).toISOString(),
    submittedByName: row.submittedByName,
    latestDecision: person?.decision ?? null,
    latestDecisionReason: person?.reason ?? null,
    latestDecidedByName: person?.decidedByName ?? null,
    latestDecidedAt: person?.decidedAt ?? null,
    submittedBy: request.submittedBy,
    requestedByName: request.requestedByName,
    department: request.department,
    locationDates: request.locationDates,
    purpose: request.purpose,
    expectedReturn: request.expectedReturn,
    costAdvertising: request.costAdvertising,
    costRegistration: request.costRegistration,
    costTravel: request.costTravel,
    costLodging: request.costLodging,
    costMeals: request.costMeals,
    costMaterials: request.costMaterials,
    costOther1: request.costOther1,
    costOther1Label: request.costOther1Label,
    costOther2: request.costOther2,
    costOther2Label: request.costOther2Label,
    budgetJobCode: request.budgetJobCode,
    travelRequired: request.travelRequired,
    attendees: request.attendees,
    businessMeetings: request.businessMeetings,
    paymentMethod: request.paymentMethod as MarketingExpensePaymentMethod | null,
    attachmentKinds: request.attachmentKinds as MarketingExpenseAttachmentKind[],
    stepsRequired: request.stepsRequired,
    approvals,
    attachments: attachmentRows.map((file) => ({
      id: file.id,
      displayName: file.displayName,
      fileSizeBytes: Number(file.fileSizeBytes),
      createdAt: toIso(file.createdAt) ?? new Date(0).toISOString(),
    })),
  };
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function resolveApproverEmails(tenantDb: TenantDb): Promise<string[]> {
  const definition = notificationRecipientGroupByKey(MARKETING_EXPENSE_APPROVER_GROUP_KEY);
  const recipients = await getNotificationRecipients(tenantDb, MARKETING_EXPENSE_APPROVER_GROUP_KEY, {
    fallbackToAdminsAndDirectors: definition?.fallbackToAdminsAndDirectors ?? false,
  });
  // Only recipients who can actually DECIDE.
  //
  // The Notification Recipients page lets an admin assign any active user to any group, but the queue and
  // the decide endpoint are role-gated. A rep assigned as the marketing approver would receive the mail,
  // follow the link and be refused — while the submitter was told it went through and the request sat
  // pending with nobody able to act. Mailing someone an approval request they cannot action is worse than
  // not mailing them, because it looks handled.
  //
  // Filtering here rather than authorizing group membership keeps ONE source of truth for who may approve
  // (`isApprover`) — see this module's note on why approver-group authorization is not a thing this
  // codebase has.
  const emails = recipients
    .filter((recipient) => isApprover({ id: recipient.userId, role: recipient.role }))
    .map((recipient) => recipient.email?.trim())
    .filter((email): email is string => Boolean(email));
  if (emails.length === 0) {
    throw new AppError(
      409,
      "No marketing expense approver who can act on this request is configured. An admin needs to assign an admin or director under Admin → Notification Recipients before requests can be submitted.",
    );
  }
  return emails;
}

async function resolveUserEmail(tenantDb: TenantDb, userId: string): Promise<string | null> {
  const [row] = await tenantDb
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email?.trim() || null;
}

function buildSnapshot(
  detail: MarketingExpenseRequestDetail,
  decision: { decision: MarketingExpenseApproverDecision | null; decisionReason: string | null },
): MarketingExpenseEmailSnapshot {
  return {
    requestNumber: detail.requestNumber,
    requestedByName: detail.requestedByName,
    vendorEvent: detail.vendorEvent,
    neededBy: detail.neededBy,
    totalRequested: detail.totalRequested,
    purpose: detail.purpose,
    decision: decision.decision,
    decisionReason: decision.decisionReason,
    requestStatus: detail.status,
  };
}

/**
 * Enqueue, never send inline.
 *
 * A `setImmediate` send after commit — which the lead-DD analogue does — is lost if the container restarts
 * between the commit and the send, and gets no retries and no dead letter. The queue survives both.
 */
async function enqueueEmail(
  tenantDb: TenantDb,
  payload: MarketingExpenseEmailPayload & { emailKind: MarketingExpenseEmailKind },
) {
  await tenantDb.insert(jobQueue).values({
    jobType: MARKETING_EXPENSE_EMAIL_JOB,
    payload,
    officeId: payload.officeId,
    status: "pending",
    runAfter: new Date(),
  });
}
