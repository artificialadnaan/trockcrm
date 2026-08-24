// REAL-SQL (PGlite) coverage for the marketing expense request service.
//
// PGlite over hand-rolled fakes because the two claims most worth proving are SQL claims: that
// `total_requested` is summed by Postgres and not by JavaScript, and that the request-number allocator
// serialises through a real row lock and a real UNIQUE constraint.
//
// ON CONCURRENCY — deliberately NOT tested here, and this is a statement about the harness, not an
// omission. All 264 PGlite suites in this repo share ONE in-process connection; a real `pg.Pool` appears in
// none of them. Two overlapping transactions are therefore not expressible, so a "concurrent submits" test
// would be a sequential loop that passes whether or not the lock exists — the worst kind of green. What IS
// tested: the allocator issues its three statements in the documented order, the DB UNIQUE rejects a
// duplicate number, and a collision surfaces as a RETRY rather than a 500.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AppError } from "../../../src/middleware/error-handler.js";
import {
  allocateRequestNumber,
  createMarketingExpenseRequest,
  decideMarketingExpenseRequest,
  getMarketingExpenseRequest,
  listMarketingExpenseQueue,
  listMyMarketingExpenseRequests,
  submitMarketingExpenseRequest,
  withdrawMarketingExpenseRequest,
} from "../../../src/modules/marketing-expense/service.js";

const MIGRATION_0232 = readFileSync(
  fileURLToPath(new URL("../../../../migrations/0232_marketing_expense_requests.sql", import.meta.url)),
  "utf8",
);

const SCHEMA = "office_dallas";
const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const SUBMITTER = U("1");
const OTHER_REP = U("2");
const APPROVER = U("3");
const OFFICE_ID = U("9");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;

const VALID_INPUT = {
  requestedByName: "Reggie Rep",
  department: "Sales",
  neededBy: "2026-10-01",
  vendorEvent: "Multifamily Expo",
  locationDates: "Dallas, Oct 12-14",
  purpose: "Booth at the regional expo",
  expectedReturn: "Qualified leads from property managers",
  costAdvertising: "1000.00",
  costRegistration: "2500.50",
  costTravel: "500",
  costLodging: "249.50",
  costMeals: "",
  costMaterials: "0",
  costOther1: "",
  costOther1Label: null,
  costOther2: "",
  costOther2Label: null,
  budgetJobCode: "MKT-2026",
  travelRequired: true,
  attendees: "Reggie Rep, Takashi Yamashita",
  businessMeetings: "Meeting with Greystar",
  paymentMethod: "company_card" as const,
  attachmentKinds: ["quote_proposal" as const],
};

beforeAll(async () => {
  pg = new PGlite();

  await pg.exec(`
    CREATE TABLE public.users (
      id uuid PRIMARY KEY,
      email text NOT NULL,
      display_name text,
      role text NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.notification_recipient_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL,
      name text NOT NULL,
      description text,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX notification_recipient_groups_key_uidx
      ON public.notification_recipient_groups (key);
    CREATE TABLE public.notification_recipient_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id uuid NOT NULL REFERENCES public.notification_recipient_groups(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX notification_recipient_assignments_group_user_uidx
      ON public.notification_recipient_assignments (group_id, user_id);
    CREATE TYPE job_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'dead');
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY,
      job_type varchar(100) NOT NULL,
      payload jsonb NOT NULL,
      office_id uuid,
      status job_status NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      last_error text,
      started_processing_at timestamptz,
      run_after timestamptz NOT NULL DEFAULT NOW(),
      created_at timestamptz NOT NULL DEFAULT NOW(),
      completed_at timestamptz
    );

    INSERT INTO public.users (id, email, display_name, role) VALUES
      ('${SUBMITTER}', 'reggie@trockgc.com', 'Reggie Rep', 'rep'),
      ('${OTHER_REP}', 'rita@trockgc.com', 'Rita Rep', 'rep'),
      ('${APPROVER}', 'tyamashita@trockgc.com', 'Takashi Yamashita', 'director');

    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.deals (id uuid PRIMARY KEY);
    CREATE TABLE ${SCHEMA}.files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid,
      lead_id uuid,
      contact_id uuid,
      procore_project_id bigint,
      change_order_id uuid,
      display_name varchar(500) NOT NULL DEFAULT 'doc.pdf',
      file_size_bytes bigint NOT NULL DEFAULT 1,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ${SCHEMA}.files ADD CONSTRAINT files_association_check
      CHECK (deal_id IS NOT NULL OR lead_id IS NOT NULL OR contact_id IS NOT NULL
             OR procore_project_id IS NOT NULL OR change_order_id IS NOT NULL);
  `);

  await pg.exec(MIGRATION_0232);

  // Migration 0232 seeds Takashi by email, which the fixture above satisfies — assert it rather than
  // assume it, because everything below depends on the group resolving to somebody.
  const seeded = await pg.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM public.notification_recipient_assignments a
      JOIN public.notification_recipient_groups g ON g.id = a.group_id
     WHERE g.key = 'marketing_expense_approver'
  `);
  if (seeded.rows[0]?.count !== 1) throw new Error("fixture: approver group did not seed");

  await pg.exec(`SET search_path TO ${SCHEMA}, public`);
  tenantDb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM ${SCHEMA}.files;
    DELETE FROM ${SCHEMA}.marketing_expense_request_approvals;
    DELETE FROM ${SCHEMA}.marketing_expense_requests;
    DELETE FROM public.job_queue;
    UPDATE public.marketing_expense_request_sequences SET last_number = 0;
    -- Restored per test rather than per file: one case below empties the approver group on purpose, and a
    -- failed assertion inside it would otherwise leave every later case submitting into an unconfigured
    -- group and failing for a reason that has nothing to do with what it tests.
    DELETE FROM public.notification_recipient_assignments;
    INSERT INTO public.notification_recipient_assignments (group_id, user_id)
    SELECT g.id, '${APPROVER}' FROM public.notification_recipient_groups g
     WHERE g.key = 'marketing_expense_approver';
  `);
});

const ctx = { tenantDb: () => tenantDb, tenantSchema: SCHEMA, officeId: OFFICE_ID };

async function createDraft(input: Partial<typeof VALID_INPUT> = {}) {
  return createMarketingExpenseRequest(ctx.tenantDb(), {
    tenantSchema: SCHEMA,
    userId: SUBMITTER,
    input: { ...VALID_INPUT, ...input },
  });
}

async function createAndSubmit(input: Partial<typeof VALID_INPUT> = {}) {
  const draft = await createDraft(input);
  await submitMarketingExpenseRequest(ctx.tenantDb(), {
    tenantSchema: SCHEMA,
    officeId: OFFICE_ID,
    userId: SUBMITTER,
    requestId: draft.id,
  });
  return draft;
}

async function jobRows() {
  const result = await pg.query<{ job_type: string; payload: Record<string, unknown> }>(
    `SELECT job_type, payload FROM public.job_queue ORDER BY id`,
  );
  return result.rows;
}

describe("total_requested", () => {
  it("is summed by Postgres, not by JavaScript", async () => {
    const draft = await createDraft();
    // 1000.00 + 2500.50 + 500 + 249.50 = 4250.00
    expect(draft.totalRequested).toBe("4250.00");
  });

  it("adds cents that a float would round wrong", async () => {
    const draft = await createDraft({
      costAdvertising: "0.10",
      costRegistration: "0.20",
      costTravel: "0",
      costLodging: "0",
      costMeals: "0",
      costMaterials: "0",
      costOther1: "0",
      costOther2: "0",
    });
    expect(draft.totalRequested).toBe("0.30");
  });

  it("IGNORES a client-supplied total entirely", async () => {
    const draft = await createMarketingExpenseRequest(ctx.tenantDb(), {
      tenantSchema: SCHEMA,
      userId: SUBMITTER,
      input: { ...VALID_INPUT, totalRequested: "999999.99" } as never,
    });
    expect(draft.totalRequested).toBe("4250.00");
  });

  // Every column, each a DIFFERENT amount, so dropping any one of the eight from the SQL expression
  // changes the answer. VALID_INPUT leaves three of them blank, which meant a sum over only seven columns
  // produced the identical total and every other case here stayed green. (Found by mutation.)
  it("sums all EIGHT cost columns, and can tell which one went missing", async () => {
    const draft = await createDraft({
      costAdvertising: "1",
      costRegistration: "2",
      costTravel: "4",
      costLodging: "8",
      costMeals: "16",
      costMaterials: "32",
      costOther1: "64",
      costOther2: "128",
    });
    expect(draft.totalRequested).toBe("255.00");
  });

  it("treats a blank cost box as zero rather than refusing the form", async () => {
    const draft = await createDraft({ costAdvertising: "", costRegistration: "", costTravel: "" });
    expect(draft.totalRequested).toBe("249.50");
  });

  it("rejects a negative cost with a 400 that names the field, not a CHECK-violation 500", async () => {
    await expect(createDraft({ costTravel: "-5" })).rejects.toMatchObject({ statusCode: 400,
      message: expect.stringContaining("Travel"),
    });
  });

  it("rejects exponent notation with a 400", async () => {
    await expect(createDraft({ costTravel: "1e6" })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("required fields", () => {
  it.each([
    ["requestedByName", "Requested by"],
    ["vendorEvent", "Vendor"],
    ["purpose", "What is the request for"],
    ["expectedReturn", "receive in return"],
  ])("rejects a blank %s with a 400 naming it", async (field, fragment) => {
    await expect(createDraft({ [field]: "   " } as never)).rejects.toMatchObject({ statusCode: 400,
      message: expect.stringContaining(fragment),
    });
  });

  it("rejects an unknown payment method", async () => {
    await expect(createDraft({ paymentMethod: "crypto" as never })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an unknown attachment kind", async () => {
    await expect(createDraft({ attachmentKinds: ["receipts"] as never })).rejects.toMatchObject({ statusCode: 400,
    });
  });
});

describe("request_number allocation", () => {
  it("issues MER- numbers in sequence, per office", async () => {
    const first = await createDraft();
    const second = await createDraft();
    expect(first.requestNumber).toBe("MER-0001");
    expect(second.requestNumber).toBe("MER-0002");
  });

  it("issues its three statements in the documented order: seed row, lock it, then bump it", async () => {
    const statements: string[] = [];
    const spy = {
      execute: vi.fn(async (query: unknown) => {
        // `tenantDb.execute` is the only path the allocator writes through; capture the rendered SQL so the
        // ORDER is asserted rather than assumed. A reordering (bump before lock) is the exact mistake that
        // makes two requests take the same number, and it cannot be caught by a sequential loop.
        const rendered = (tenantDb as { dialect: { sqlToQuery: (q: unknown) => { sql: string } } }).dialect
          .sqlToQuery(query).sql;
        statements.push(rendered.replace(/\s+/g, " ").trim());
        return tenantDb.execute(query);
      }),
    };
    const number = await allocateRequestNumber(spy as never, SCHEMA);
    expect(number).toBe("MER-0001");
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^INSERT INTO public\.marketing_expense_request_sequences/);
    expect(statements[0]).toMatch(/ON CONFLICT \(tenant_schema\) DO NOTHING/);
    expect(statements[1]).toMatch(/^SELECT last_number/);
    // The lock. Deleting `FOR UPDATE` leaves every other assertion in this file green.
    expect(statements[1]).toMatch(/FOR UPDATE/);
    expect(statements[2]).toMatch(/^UPDATE public\.marketing_expense_request_sequences/);
  });

  it("is rejected by the DB when the same number is inserted twice", async () => {
    await createDraft();
    await expect(
      pg.exec(`
        INSERT INTO ${SCHEMA}.marketing_expense_requests
          (request_number, submitted_by, requested_by_name, vendor_event, purpose, expected_return, total_requested)
        VALUES ('MER-0001', '${SUBMITTER}', 'x', 'y', 'z', 'w', 0)
      `),
    ).rejects.toThrow();
  });

  it("surfaces a collision as a RETRY with the next number, not as a 500", async () => {
    // Rewind the counter so the next allocation collides with the row that already exists. Inside one
    // transaction a thrown 23505 would poison every later statement, so the insert is
    // ON CONFLICT DO NOTHING and an empty RETURNING is what drives the retry.
    await createDraft();
    await pg.exec(`UPDATE public.marketing_expense_request_sequences SET last_number = 0`);
    const retried = await createDraft();
    expect(retried.requestNumber).toBe("MER-0002");
  });
});

describe("draft -> submit ordering", () => {
  it("is born a draft with no submitted_at, so nothing is emailed before attachments exist", async () => {
    const draft = await createDraft();
    expect(draft.status).toBe("draft");
    expect(draft.submittedAt).toBeNull();
    expect(await jobRows()).toHaveLength(0);
  });

  it("creates NO approval row until submit — a draft must never appear in the queue", async () => {
    await createDraft();
    expect(await listMarketingExpenseQueue(tenantDb, "pending")).toHaveLength(0);
  });

  it("flips to pending, stamps submitted_at and opens step 1 on submit", async () => {
    const draft = await createDraft();
    const submitted = await submitMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: OFFICE_ID,
      userId: SUBMITTER,
      requestId: draft.id,
    });
    expect(submitted.status).toBe("pending");
    expect(submitted.submittedAt).not.toBeNull();
    const queue = await listMarketingExpenseQueue(tenantDb, "pending");
    expect(queue.map((row) => row.id)).toEqual([draft.id]);
  });

  it("refuses to submit somebody else's draft", async () => {
    const draft = await createDraft();
    await expect(
      submitMarketingExpenseRequest(tenantDb, {
        tenantSchema: SCHEMA,
        officeId: OFFICE_ID,
        userId: OTHER_REP,
        requestId: draft.id,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses a second submit of the same request", async () => {
    const draft = await createAndSubmit();
    await expect(
      submitMarketingExpenseRequest(tenantDb, {
        tenantSchema: SCHEMA,
        officeId: OFFICE_ID,
        userId: SUBMITTER,
        requestId: draft.id,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("REFUSES a submit of a $0.00 request — the form says so and the server must agree", async () => {
    // The React form blocks a zero total, which makes the client the ONLY validation: any direct API
    // caller, or a second client, could push an empty request through approval.
    const draft = await createDraft({
      costAdvertising: "",
      costRegistration: "",
      costTravel: "",
      costLodging: "",
      costMeals: "",
      costMaterials: "",
      costOther1: "",
      costOther2: "",
    });
    expect(draft.totalRequested).toBe("0.00");
    await expect(
      submitMarketingExpenseRequest(tenantDb, {
        tenantSchema: SCHEMA,
        officeId: OFFICE_ID,
        userId: SUBMITTER,
        requestId: draft.id,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("leaves a $0.00 row as a DRAFT so it can be corrected rather than lost", async () => {
    const draft = await createDraft({
      costAdvertising: "", costRegistration: "", costTravel: "", costLodging: "",
      costMeals: "", costMaterials: "", costOther1: "", costOther2: "",
    });
    await submitMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA, officeId: OFFICE_ID, userId: SUBMITTER, requestId: draft.id,
    }).catch(() => undefined);
    const row = await pg.query<{ status: string }>(
      `SELECT status FROM ${SCHEMA}.marketing_expense_requests WHERE id = '${draft.id}'`,
    );
    expect(row.rows[0]?.status).toBe("draft");
  });

  it("REFUSES the submit when the approver group resolves to nobody, instead of mailing into the void", async () => {
    await pg.exec(`DELETE FROM public.notification_recipient_assignments`);
    const draft = await createDraft();
    await expect(
      submitMarketingExpenseRequest(tenantDb, {
        tenantSchema: SCHEMA,
        officeId: OFFICE_ID,
        userId: SUBMITTER,
        requestId: draft.id,
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("Notification Recipients") });
    // ...and leaves the row a draft, so the submit is retryable once an admin fixes the group.
    const row = await pg.query<{ status: string }>(
      `SELECT status FROM ${SCHEMA}.marketing_expense_requests WHERE id = '${draft.id}'`,
    );
    expect(row.rows[0]?.status).toBe("draft");
  });
});

describe("emails", () => {
  it("enqueues exactly one approver mail and one submitter mail on submit", async () => {
    await createAndSubmit();
    const jobs = await jobRows();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.job_type)).toEqual(["marketing_expense_email", "marketing_expense_email"]);
    expect(jobs.map((job) => job.payload.emailKind)).toEqual([
      "submitted_approver",
      "submitted_submitter",
    ]);
  });

  it("carries tenantSchema on the payload — job_queue.office_id is a UUID, not a schema name", async () => {
    await createAndSubmit();
    for (const job of await jobRows()) {
      expect(job.payload.tenantSchema).toBe(SCHEMA);
      expect(job.payload.officeId).toBe(OFFICE_ID);
    }
  });

  it("freezes the fields the body renders, so a later edit cannot change a retry's payload", async () => {
    await createAndSubmit();
    const [approverJob] = await jobRows();
    expect(approverJob?.payload.snapshot).toMatchObject({
      requestNumber: "MER-0001",
      requestedByName: "Reggie Rep",
      vendorEvent: "Multifamily Expo",
      totalRequested: "4250.00",
      purpose: "Booth at the regional expo",
    });
  });

  it("addresses the approver mail to the resolved group and the confirmation to the submitter", async () => {
    await createAndSubmit();
    const [approverJob, submitterJob] = await jobRows();
    expect(approverJob?.payload.recipientEmails).toEqual(["tyamashita@trockgc.com"]);
    expect(submitterJob?.payload.recipientEmails).toEqual(["reggie@trockgc.com"]);
  });

  it("enqueues one decision mail to the submitter, carrying the deciding step", async () => {
    const draft = await createAndSubmit();
    await pg.exec(`DELETE FROM public.job_queue`);
    await decideMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: OFFICE_ID,
      requestId: draft.id,
      userId: APPROVER,
      decision: "approved",
      reason: null,
    });
    const jobs = await jobRows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload.emailKind).toBe("decided_submitter");
    expect(jobs[0]?.payload.stepOrder).toBe(1);
    expect(jobs[0]?.payload.recipientEmails).toEqual(["reggie@trockgc.com"]);
    expect(jobs[0]?.payload.snapshot).toMatchObject({ decision: "approved", requestStatus: "approved" });
  });

  it("sends nothing on a withdrawal — the submitter is the one who did it", async () => {
    const draft = await createAndSubmit();
    await pg.exec(`DELETE FROM public.job_queue`);
    await withdrawMarketingExpenseRequest(tenantDb, { requestId: draft.id, userId: SUBMITTER });
    expect(await jobRows()).toHaveLength(0);
  });
});

describe("decisions", () => {
  it("denies with a reason and finalises the parent", async () => {
    const draft = await createAndSubmit();
    const decided = await decideMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: OFFICE_ID,
      requestId: draft.id,
      userId: APPROVER,
      decision: "denied",
      reason: "Over budget for the quarter",
    });
    expect(decided.status).toBe("denied");
    expect(decided.approvals[0]).toMatchObject({ decision: "denied", reason: "Over budget for the quarter" });
  });

  it("rejects a denial with no reason", async () => {
    const draft = await createAndSubmit();
    await expect(
      decideMarketingExpenseRequest(tenantDb, {
        tenantSchema: SCHEMA,
        officeId: OFFICE_ID,
        requestId: draft.id,
        userId: APPROVER,
        decision: "denied",
        reason: "   ",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("approves and finalises when every required step is approved", async () => {
    const draft = await createAndSubmit();
    const decided = await decideMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: OFFICE_ID,
      requestId: draft.id,
      userId: APPROVER,
      decision: "approved",
      reason: null,
    });
    expect(decided.status).toBe("approved");
  });

  it("409s on a second decision — two approvers clicking at once is the normal case", async () => {
    const draft = await createAndSubmit();
    await decideMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: OFFICE_ID,
      requestId: draft.id,
      userId: APPROVER,
      decision: "approved",
      reason: null,
    });
    await expect(
      decideMarketingExpenseRequest(tenantDb, {
        tenantSchema: SCHEMA,
        officeId: OFFICE_ID,
        requestId: draft.id,
        userId: APPROVER,
        decision: "denied",
        reason: "changed my mind",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses to decide a draft that was never submitted", async () => {
    const draft = await createDraft();
    await expect(
      decideMarketingExpenseRequest(tenantDb, {
        tenantSchema: SCHEMA,
        officeId: OFFICE_ID,
        requestId: draft.id,
        userId: APPROVER,
        decision: "approved",
        reason: null,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("two-stage sequencing", () => {
  async function makeTwoStage() {
    const draft = await createAndSubmit();
    await pg.exec(`
      UPDATE ${SCHEMA}.marketing_expense_requests SET steps_required = 2 WHERE id = '${draft.id}';
      INSERT INTO ${SCHEMA}.marketing_expense_request_approvals (request_id, step_order, approver_group_key)
      VALUES ('${draft.id}', 2, 'marketing_expense_approver');
    `);
    return draft;
  }

  it("does not finalise at step 1 when two steps are required", async () => {
    const draft = await makeTwoStage();
    const decided = await decideMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: OFFICE_ID,
      requestId: draft.id,
      userId: APPROVER,
      decision: "approved",
      reason: null,
    });
    expect(decided.status).toBe("pending");
    expect(decided.approvals.map((row) => row.decision)).toEqual(["approved", null]);
  });

  it("finalises once step 2 is approved as well", async () => {
    const draft = await makeTwoStage();
    for (let i = 0; i < 2; i += 1) {
      await decideMarketingExpenseRequest(tenantDb, {
        tenantSchema: SCHEMA,
        officeId: OFFICE_ID,
        requestId: draft.id,
        userId: APPROVER,
        decision: "approved",
        reason: null,
      });
    }
    const detail = await getMarketingExpenseRequest(tenantDb, {
      requestId: draft.id,
      user: { id: APPROVER, role: "director" },
    });
    expect(detail.status).toBe("approved");
  });

  it("decides step 1 FIRST — a decision can never land on step 2 while step 1 is open", async () => {
    const draft = await makeTwoStage();
    const decided = await decideMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: OFFICE_ID,
      requestId: draft.id,
      userId: APPROVER,
      decision: "approved",
      reason: null,
    });
    const step1 = decided.approvals.find((row) => row.stepOrder === 1);
    const step2 = decided.approvals.find((row) => row.stepOrder === 2);
    expect(step1?.decision).toBe("approved");
    expect(step2?.decision).toBeNull();
  });

  it("marks every later step skipped on a denial, so nothing is left open in the queue forever", async () => {
    const draft = await makeTwoStage();
    const decided = await decideMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: OFFICE_ID,
      requestId: draft.id,
      userId: APPROVER,
      decision: "denied",
      reason: "No budget",
    });
    expect(decided.status).toBe("denied");
    expect(decided.approvals.map((row) => row.decision)).toEqual(["denied", "skipped"]);
    expect(await listMarketingExpenseQueue(tenantDb, "pending")).toHaveLength(0);
  });

  it("marks every open step skipped on a withdrawal too", async () => {
    const draft = await makeTwoStage();
    const withdrawn = await withdrawMarketingExpenseRequest(tenantDb, {
      requestId: draft.id,
      userId: SUBMITTER,
    });
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.approvals.map((row) => row.decision)).toEqual(["skipped", "skipped"]);
  });
});

describe("withdrawal", () => {
  it("lets the submitter withdraw while pending", async () => {
    const draft = await createAndSubmit();
    const withdrawn = await withdrawMarketingExpenseRequest(tenantDb, {
      requestId: draft.id,
      userId: SUBMITTER,
    });
    expect(withdrawn.status).toBe("withdrawn");
  });

  it("refuses a withdrawal by anyone but the submitter", async () => {
    const draft = await createAndSubmit();
    await expect(
      withdrawMarketingExpenseRequest(tenantDb, { requestId: draft.id, userId: OTHER_REP }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses to withdraw something already decided", async () => {
    const draft = await createAndSubmit();
    await decideMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: OFFICE_ID,
      requestId: draft.id,
      userId: APPROVER,
      decision: "approved",
      reason: null,
    });
    await expect(
      withdrawMarketingExpenseRequest(tenantDb, { requestId: draft.id, userId: SUBMITTER }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("visibility", () => {
  it("shows a submitter only their own rows", async () => {
    await createAndSubmit();
    await createMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      userId: OTHER_REP,
      input: { ...VALID_INPUT, vendorEvent: "Somebody else's expo" },
    });
    const mine = await listMyMarketingExpenseRequests(tenantDb, SUBMITTER);
    expect(mine.map((row) => row.vendorEvent)).toEqual(["Multifamily Expo"]);
  });

  it("includes the submitter's own DRAFTS so a failed submit is never invisible", async () => {
    await createDraft();
    const mine = await listMyMarketingExpenseRequests(tenantDb, SUBMITTER);
    expect(mine.map((row) => row.status)).toEqual(["draft"]);
  });

  it("lets the submitter read their own request", async () => {
    const draft = await createAndSubmit();
    const detail = await getMarketingExpenseRequest(tenantDb, {
      requestId: draft.id,
      user: { id: SUBMITTER, role: "rep" },
    });
    expect(detail.requestNumber).toBe("MER-0001");
  });

  it("403s a different rep reading someone else's request", async () => {
    const draft = await createAndSubmit();
    await expect(
      getMarketingExpenseRequest(tenantDb, { requestId: draft.id, user: { id: OTHER_REP, role: "rep" } }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("lets a director read anyone's request", async () => {
    const draft = await createAndSubmit();
    const detail = await getMarketingExpenseRequest(tenantDb, {
      requestId: draft.id,
      user: { id: APPROVER, role: "director" },
    });
    expect(detail.requestNumber).toBe("MER-0001");
  });

  it("404s an id that does not exist", async () => {
    await expect(
      getMarketingExpenseRequest(tenantDb, { requestId: U("dead"), user: { id: APPROVER, role: "admin" } }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns attachments on the detail payload", async () => {
    const draft = await createAndSubmit();
    await pg.exec(`
      INSERT INTO ${SCHEMA}.files (marketing_expense_request_id, display_name, file_size_bytes)
      VALUES ('${draft.id}', 'expo-quote.pdf', 4096)
    `);
    const detail = await getMarketingExpenseRequest(tenantDb, {
      requestId: draft.id,
      user: { id: SUBMITTER, role: "rep" },
    });
    expect(detail.attachments).toEqual([
      expect.objectContaining({ displayName: "expo-quote.pdf", fileSizeBytes: 4096 }),
    ]);
  });

  it("hides soft-deleted attachments", async () => {
    const draft = await createAndSubmit();
    await pg.exec(`
      INSERT INTO ${SCHEMA}.files (marketing_expense_request_id, display_name, is_active)
      VALUES ('${draft.id}', 'gone.pdf', false)
    `);
    const detail = await getMarketingExpenseRequest(tenantDb, {
      requestId: draft.id,
      user: { id: SUBMITTER, role: "rep" },
    });
    expect(detail.attachments).toEqual([]);
  });
});

describe("queue", () => {
  it("filters by status and returns newest first", async () => {
    const first = await createAndSubmit({ vendorEvent: "First expo" });
    const second = await createAndSubmit({ vendorEvent: "Second expo" });
    await pg.exec(`
      UPDATE ${SCHEMA}.marketing_expense_requests SET created_at = NOW() - interval '1 day'
       WHERE id = '${first.id}'
    `);
    const pending = await listMarketingExpenseQueue(tenantDb, "pending");
    expect(pending.map((row) => row.id)).toEqual([second.id, first.id]);

    await decideMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: OFFICE_ID,
      requestId: first.id,
      userId: APPROVER,
      decision: "approved",
      reason: null,
    });
    expect((await listMarketingExpenseQueue(tenantDb, "pending")).map((row) => row.id)).toEqual([second.id]);
    expect((await listMarketingExpenseQueue(tenantDb, "approved")).map((row) => row.id)).toEqual([first.id]);
  });

  it("never shows a draft in any queue tab", async () => {
    await createDraft();
    for (const status of ["pending", "approved", "denied"] as const) {
      expect(await listMarketingExpenseQueue(tenantDb, status)).toHaveLength(0);
    }
  });

  it("names the submitter so the queue does not render a bare uuid", async () => {
    await createAndSubmit();
    const [row] = await listMarketingExpenseQueue(tenantDb, "pending");
    expect(row?.submittedByName).toBe("Reggie Rep");
  });
});

describe("AppError contract", () => {
  it("throws AppError instances, so the express error handler renders a status and not a 500", async () => {
    await expect(createDraft({ vendorEvent: "" })).rejects.toBeInstanceOf(AppError);
  });

  it("keeps the sequence table addressable by schema name only", async () => {
    await createDraft();
    const row = await tenantDb.execute(
      sql`SELECT last_number FROM public.marketing_expense_request_sequences WHERE tenant_schema = ${SCHEMA}`,
    );
    const rows = Array.isArray(row) ? row : row.rows ?? [];
    expect(Number(rows[0]?.last_number)).toBe(1);
  });
});
