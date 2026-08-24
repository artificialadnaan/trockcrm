// The three marketing-expense emails and the ledger that makes them exactly-once.
//
// Lives in `worker/tests/jobs/` and is named `.runtime.test.ts` on purpose: worker/vitest.config.ts includes
// only `tests/**`, so anything under `worker/src/jobs/*.test.ts` never executes, and the CI gate runs
// `vitest run runtime.test`, so a plain `.test.ts` here would run locally and nowhere else.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MARKETING_EXPENSE_EMAIL_JOB,
  buildMarketingExpenseApproverEmail,
  buildMarketingExpenseDecisionEmail,
  buildMarketingExpenseSubmitterEmail,
  handleMarketingExpenseEmail,
} from "../../src/jobs/marketing-expense-email.js";

const MIGRATION_0232 = readFileSync(
  fileURLToPath(new URL("../../../migrations/0232_marketing_expense_requests.sql", import.meta.url)),
  "utf8",
);

const SCHEMA = "office_dallas";
const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const ANOTHER_REQUEST = "00000000-0000-4000-8000-000000000002";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any;

const SNAPSHOT = {
  requestNumber: "MER-0007",
  requestedByName: "Reggie <Rep>",
  vendorEvent: "Multifamily Expo",
  neededBy: "2026-10-01",
  totalRequested: "4250.00",
  purpose: "Booth at the regional expo to meet property managers",
  decision: null,
  decisionReason: null,
  requestStatus: "pending" as const,
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    tenantSchema: SCHEMA,
    requestId: REQUEST_ID,
    emailKind: "submitted_approver" as const,
    stepOrder: 0,
    officeId: "office-uuid",
    recipientEmails: ["tyamashita@trockgc.com"],
    snapshot: SNAPSHOT,
    ...overrides,
  };
}

function deps(sendEmail = vi.fn(async () => ({ success: true, messageId: "msg-1" }))) {
  return {
    query,
    sendEmail,
    env: { FRONTEND_URL: "https://trockcrm.com" } as NodeJS.ProcessEnv,
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.users (id uuid PRIMARY KEY, email text NOT NULL, display_name text);
    CREATE TABLE public.notification_recipient_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL, name text NOT NULL,
      description text, created_at timestamptz NOT NULL DEFAULT NOW()
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
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.deals (id uuid PRIMARY KEY);
    -- 0232's marked block is written literally against office_dallas and ALTERs its files table, so a
    -- fixture schema of that name has to have one. Nothing below reads it.
    CREATE TABLE ${SCHEMA}.files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid, contact_id uuid, procore_project_id bigint, change_order_id uuid,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ${SCHEMA}.files ADD CONSTRAINT files_association_check
      CHECK (deal_id IS NOT NULL OR contact_id IS NOT NULL
             OR procore_project_id IS NOT NULL OR change_order_id IS NOT NULL);
  `);
  await pg.exec(MIGRATION_0232);
  query = (sql: string, params?: unknown[]) => pg.query(sql, params as never[]);
}, 30_000);

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM public.marketing_expense_request_email_receipts`);
});

async function receipts() {
  const result = await pg.query<{
    email_kind: string;
    step_order: number;
    sent_at: string | null;
    request_number: string | null;
    recipient_emails: string | null;
    resend_message_id: string | null;
  }>(`SELECT email_kind, step_order, sent_at, request_number, recipient_emails, resend_message_id
        FROM public.marketing_expense_request_email_receipts
       ORDER BY email_kind, step_order`);
  return result.rows;
}

describe("job registration contract", () => {
  it("uses the job type the server enqueues under", () => {
    expect(MARKETING_EXPENSE_EMAIL_JOB).toBe("marketing_expense_email");
  });
});

describe("payload validation", () => {
  it("refuses a payload with no tenantSchema — office_id is a UUID and cannot stand in for one", async () => {
    const send = vi.fn();
    await handleMarketingExpenseEmail(payload({ tenantSchema: undefined }) as never, "office-uuid", deps(send));
    expect(send).not.toHaveBeenCalled();
    expect(await receipts()).toHaveLength(0);
  });

  it("refuses a tenantSchema that is not an office_ schema", async () => {
    const send = vi.fn();
    await handleMarketingExpenseEmail(
      payload({ tenantSchema: "public; DROP TABLE users" }) as never,
      null,
      deps(send),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses an unknown email kind rather than sending something unrecognised", async () => {
    const send = vi.fn();
    await handleMarketingExpenseEmail(payload({ emailKind: "gossip" }) as never, null, deps(send));
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a payload with no recipients rather than completing as if it had sent", async () => {
    const send = vi.fn();
    const handlerDeps = deps(send);
    await expect(
      handleMarketingExpenseEmail(payload({ recipientEmails: [] }) as never, null, handlerDeps),
    ).rejects.toThrow(/recipient/i);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the receipt ledger", () => {
  it("claims BEFORE sending and stamps sent_at only after a durable send", async () => {
    const send = vi.fn(async () => {
      // Mid-send, the claim must already exist with sent_at still NULL. A ledger written after the send
      // cannot survive a crash between the two.
      const midFlight = await receipts();
      expect(midFlight).toHaveLength(1);
      expect(midFlight[0]?.sent_at).toBeNull();
      return { success: true, messageId: "msg-1" };
    });
    await handleMarketingExpenseEmail(payload() as never, null, deps(send));
    const after = await receipts();
    expect(after[0]?.sent_at).not.toBeNull();
    expect(after[0]?.resend_message_id).toBe("msg-1");
  });

  it("does not send twice for the same (request, kind, step)", async () => {
    const send = vi.fn(async () => ({ success: true, messageId: "msg-1" }));
    const handlerDeps = deps(send);
    await handleMarketingExpenseEmail(payload() as never, null, handlerDeps);
    await handleMarketingExpenseEmail(payload() as never, null, handlerDeps);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("leaves sent_at NULL when the provider fails, so the retry goes again", async () => {
    const failing = vi.fn(async () => ({ success: false, messageId: null }));
    await expect(
      handleMarketingExpenseEmail(payload() as never, null, deps(failing) as never),
    ).rejects.toThrow();
    expect((await receipts())[0]?.sent_at).toBeNull();

    const succeeding = vi.fn(async () => ({ success: true, messageId: "msg-2" }));
    await handleMarketingExpenseEmail(payload() as never, null, deps(succeeding));
    expect(succeeding).toHaveBeenCalledTimes(1);
    expect((await receipts())[0]?.sent_at).not.toBeNull();
  });

  it("renders a retry from the STORED snapshot, not from the retry's own payload", async () => {
    const failing = vi.fn(async () => ({ success: false, messageId: null }));
    await expect(handleMarketingExpenseEmail(payload() as never, null, deps(failing))).rejects.toThrow();

    // The request is renumbered and re-addressed between attempts. The retry must still send exactly what
    // the first attempt claimed, or the Resend idempotency key is rejected as a payload mismatch.
    const send = vi.fn(async () => ({ success: true, messageId: "msg-3" }));
    await handleMarketingExpenseEmail(
      payload({
        recipientEmails: ["someone.else@trockgc.com"],
        snapshot: { ...SNAPSHOT, requestNumber: "MER-9999", vendorEvent: "Renamed Event" },
      }) as never,
      null,
      deps(send),
    );
    const [to, subject, html] = send.mock.calls[0] as unknown as [string[], string, string];
    expect(to).toEqual(["tyamashita@trockgc.com"]);
    expect(subject).toContain("MER-0007");
    expect(html).toContain("Multifamily Expo");
    expect(html).not.toContain("Renamed Event");
  });

  it("keys by step_order, so a two-stage request can send more than one decision email", async () => {
    const send = vi.fn(async () => ({ success: true, messageId: "msg-1" }));
    const handlerDeps = deps(send);
    const decision = {
      emailKind: "decided_submitter" as const,
      recipientEmails: ["reggie@trockgc.com"],
      snapshot: { ...SNAPSHOT, decision: "approved" as const, requestStatus: "pending" as const },
    };
    await handleMarketingExpenseEmail(payload({ ...decision, stepOrder: 1 }) as never, null, handlerDeps);
    await handleMarketingExpenseEmail(payload({ ...decision, stepOrder: 2 }) as never, null, handlerDeps);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await receipts()).map((row) => row.step_order)).toEqual([1, 2]);
  });

  it("keys by request, so two requests do not suppress each other", async () => {
    const send = vi.fn(async () => ({ success: true, messageId: "msg-1" }));
    const handlerDeps = deps(send);
    await handleMarketingExpenseEmail(payload() as never, null, handlerDeps);
    await handleMarketingExpenseEmail(payload({ requestId: ANOTHER_REQUEST }) as never, null, handlerDeps);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("uses a stable idempotency key that includes the kind and the step", async () => {
    const send = vi.fn(async () => ({ success: true, messageId: "msg-1" }));
    await handleMarketingExpenseEmail(payload() as never, null, deps(send));
    const options = send.mock.calls[0]?.[3] as { idempotencyKey: string };
    expect(options.idempotencyKey).toBe(
      `marketing-expense-submitted_approver-${SCHEMA}-${REQUEST_ID}-0`,
    );
  });
});

describe("buildMarketingExpenseApproverEmail", () => {
  const built = () =>
    buildMarketingExpenseApproverEmail({
      requestId: REQUEST_ID,
      snapshot: SNAPSHOT,
      officeId: "office-uuid",
      frontendUrl: "https://trockcrm.com",
    });

  it("names the request number and the amount in the subject", () => {
    const email = built();
    expect(email.subject).toContain("MER-0007");
    expect(email.subject).toContain("$4,250.00");
    expect(email.subject.toLowerCase()).toContain("approval");
  });

  it("links to the approver queue carrying the office, so a cross-office approver does not land empty", () => {
    expect(built().html).toContain(
      "https://trockcrm.com/admin/marketing-expense-requests?officeId=office-uuid",
    );
  });

  it("escapes the requester's name rather than injecting it as markup", () => {
    const email = built();
    expect(email.html).toContain("Reggie &lt;Rep&gt;");
    expect(email.html).not.toContain("Reggie <Rep>");
  });

  it("carries a plain-text alternative", () => {
    expect(built().text).toContain("MER-0007");
  });
});

describe("buildMarketingExpenseSubmitterEmail", () => {
  it("confirms receipt and says what happens next", () => {
    const email = buildMarketingExpenseSubmitterEmail({
      requestId: REQUEST_ID,
      snapshot: SNAPSHOT,
      officeId: null,
      frontendUrl: "https://trockcrm.com",
    });
    expect(email.subject).toContain("MER-0007");
    expect(email.html.toLowerCase()).toContain("approver");
    // The submitter's own status page, not the admin queue they cannot open.
    expect(email.html).toContain("https://trockcrm.com/marketing-expense-requests");
    expect(email.html).not.toContain("/admin/marketing-expense-requests");
  });
});

describe("buildMarketingExpenseDecisionEmail", () => {
  it("is green and says approved on an approval", () => {
    const email = buildMarketingExpenseDecisionEmail({
      requestId: REQUEST_ID,
      snapshot: { ...SNAPSHOT, decision: "approved", requestStatus: "approved" },
      officeId: null,
      frontendUrl: "https://trockcrm.com",
    });
    expect(email.subject.toLowerCase()).toContain("approved");
    expect(email.html).toContain("#059669");
  });

  it("is red, says denied and QUOTES THE REASON on a denial", () => {
    const email = buildMarketingExpenseDecisionEmail({
      requestId: REQUEST_ID,
      snapshot: {
        ...SNAPSHOT,
        decision: "denied",
        decisionReason: "Over budget for Q4",
        requestStatus: "denied",
      },
      officeId: null,
      frontendUrl: "https://trockcrm.com",
    });
    expect(email.subject.toLowerCase()).toContain("denied");
    expect(email.html).toContain("#CC0000");
    // Without the reason the mail tells somebody "no" and nothing else, which is the one thing they need.
    expect(email.html).toContain("Over budget for Q4");
    expect(email.text).toContain("Over budget for Q4");
  });

  it("does NOT say 'approved' in the SUBJECT when a later step is still outstanding", () => {
    // Submitters act on subject lines. At step 1 of 2, "was approved" reads as authorization to spend.
    const email = buildMarketingExpenseDecisionEmail({
      requestId: REQUEST_ID,
      snapshot: { ...SNAPSHOT, decision: "approved", requestStatus: "pending" },
      officeId: null,
      frontendUrl: "https://trockcrm.com",
    });
    expect(email.subject).not.toMatch(/was approved/i);
    expect(email.subject.toLowerCase()).toContain("still");
    expect(email.subject).toContain("MER-0007");
  });

  it("still says 'approved' plainly once the request is actually approved", () => {
    const email = buildMarketingExpenseDecisionEmail({
      requestId: REQUEST_ID,
      snapshot: { ...SNAPSHOT, decision: "approved", requestStatus: "approved" },
      officeId: null,
      frontendUrl: "https://trockcrm.com",
    });
    expect(email.subject).toMatch(/was approved/i);
  });

  it("says the request is still moving when an earlier step approved but the parent is still pending", () => {
    const email = buildMarketingExpenseDecisionEmail({
      requestId: REQUEST_ID,
      snapshot: { ...SNAPSHOT, decision: "approved", requestStatus: "pending" },
      officeId: null,
      frontendUrl: "https://trockcrm.com",
    });
    expect(email.html.toLowerCase()).toContain("still");
  });
});
