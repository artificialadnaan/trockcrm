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
  MARKETING_EXPENSE_APPROVER_GROUP_KEY,
  MARKETING_EXPENSE_COST_LABELS,
  MARKETING_EXPENSE_EMAIL_JOB,
  isMarketingExpenseAttachmentKind,
  isMarketingExpensePaymentMethod,
  notificationRecipientGroupByKey,
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

/** `YYYY-MM-DD` only. A `date` column takes no time, and a full ISO string would silently shift by zone. */
function optionalDate(value: unknown, label: string): string | null {
  const trimmed = optionalText(value);
  if (!trimmed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new AppError(400, `${label} must be a date (YYYY-MM-DD).`);
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

  const request = await loadRow(tenantDb, requestId);
  if (request.submittedBy !== userId) {
    throw new AppError(403, "You can only submit your own expense request.");
  }
  if (request.status !== "draft") {
    throw new AppError(409, "This request has already been submitted.");
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
    throw new AppError(409, "This request has already been submitted.");
  }

  await tenantDb.insert(marketingExpenseRequestApprovals).values({
    requestId,
    stepOrder: 1,
    approverGroupKey: MARKETING_EXPENSE_APPROVER_GROUP_KEY,
  });

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

  const request = await loadRow(tenantDb, requestId);
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

  if (nextStatus !== "pending") {
    await tenantDb
      .update(marketingExpenseRequests)
      .set({ status: nextStatus, updatedAt: now })
      .where(eq(marketingExpenseRequests.id, requestId));
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
  const request = await loadRow(tenantDb, args.requestId);
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
  const request = await loadRow(tenantDb, args.requestId);
  if (request.submittedBy !== args.user.id && !isApprover(args.user)) {
    throw new AppError(403, "You do not have access to this expense request.");
  }
  return loadDetail(tenantDb, args.requestId);
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
 * The SUBMITTER only, and only while the decision is still outstanding.
 *
 * Not the approver: a supporting document is part of the case being made, and an approver quietly adding
 * one to somebody's request changes what the record says was submitted. Not after a decision either — the
 * attachments are the evidence the approver saw, and appending to them afterwards makes the trail a lie.
 * Called from the files upload route, which has no idea about any of that.
 */
export async function assertMarketingExpenseAttachmentAccess(
  tenantDb: TenantDb,
  requestId: string,
  user: ActingUser,
): Promise<void> {
  const request = await loadRow(tenantDb, requestId);
  if (request.submittedBy !== user.id) {
    throw new AppError(403, "You can only attach files to your own expense request.");
  }
  if (request.status !== "draft" && request.status !== "pending") {
    throw new AppError(409, "This request has already been decided — its attachments are final.");
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
  const emails = recipients
    .map((recipient) => recipient.email?.trim())
    .filter((email): email is string => Boolean(email));
  if (emails.length === 0) {
    throw new AppError(
      409,
      "No marketing expense approver is configured. An admin needs to add one under Admin → Notification Recipients before requests can be submitted.",
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
