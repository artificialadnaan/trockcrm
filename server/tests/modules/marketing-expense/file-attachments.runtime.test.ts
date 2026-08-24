// The blocker this feature was built around: `files` refuses a row that attaches to nothing, at the DB AND
// in the service layer, so an expense request could not have had attachments at all until 0232 gave `files`
// a `marketing_expense_request_id`. Both halves of that refusal are proven here — the service guard with a
// real call, the DB constraint in the migration suite next door.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AppError } from "../../../src/middleware/error-handler.js";
import { assertMarketingExpenseAttachmentAccess } from "../../../src/modules/marketing-expense/service.js";
import {
  createMarketingExpenseRequest,
  submitMarketingExpenseRequest,
  decideMarketingExpenseRequest,
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

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;

const INPUT = {
  requestedByName: "Reggie Rep",
  vendorEvent: "Multifamily Expo",
  purpose: "Booth",
  expectedReturn: "Leads",
  costAdvertising: "100",
};

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.users (
      id uuid PRIMARY KEY, email text NOT NULL, display_name text, role text NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );
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
    CREATE TYPE job_status AS ENUM ('pending','processing','completed','failed','dead');
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type varchar(100) NOT NULL, payload jsonb NOT NULL,
      office_id uuid, status job_status NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3, last_error text, started_processing_at timestamptz,
      run_after timestamptz NOT NULL DEFAULT NOW(), created_at timestamptz NOT NULL DEFAULT NOW(),
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
      deal_id uuid, lead_id uuid, contact_id uuid, procore_project_id bigint, change_order_id uuid,
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
    DELETE FROM public.notification_recipient_assignments;
    INSERT INTO public.notification_recipient_assignments (group_id, user_id)
    SELECT g.id, '${APPROVER}' FROM public.notification_recipient_groups g
     WHERE g.key = 'marketing_expense_approver';
  `);
});

async function draft() {
  return createMarketingExpenseRequest(tenantDb, {
    tenantSchema: SCHEMA,
    userId: SUBMITTER,
    input: INPUT,
  });
}

describe("assertMarketingExpenseAttachmentAccess", () => {
  it("lets the submitter attach to their own draft", async () => {
    const request = await draft();
    await expect(
      assertMarketingExpenseAttachmentAccess(tenantDb, request.id, { id: SUBMITTER, role: "rep" }),
    ).resolves.toBeUndefined();
  });

  it("still lets the submitter attach after submitting, while the approver is deciding", async () => {
    const request = await draft();
    await submitMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: null,
      userId: SUBMITTER,
      requestId: request.id,
    });
    await expect(
      assertMarketingExpenseAttachmentAccess(tenantDb, request.id, { id: SUBMITTER, role: "rep" }),
    ).resolves.toBeUndefined();
  });

  it("refuses another rep attaching to somebody else's request", async () => {
    const request = await draft();
    await expect(
      assertMarketingExpenseAttachmentAccess(tenantDb, request.id, { id: OTHER_REP, role: "rep" }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses an APPROVER too — a supporting document is the requester's to file", async () => {
    const request = await draft();
    await expect(
      assertMarketingExpenseAttachmentAccess(tenantDb, request.id, { id: APPROVER, role: "director" }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses an attachment once the request has been decided", async () => {
    const request = await draft();
    await submitMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: null,
      userId: SUBMITTER,
      requestId: request.id,
    });
    await decideMarketingExpenseRequest(tenantDb, {
      tenantSchema: SCHEMA,
      officeId: null,
      requestId: request.id,
      userId: APPROVER,
      decision: "approved",
      reason: null,
    });
    await expect(
      assertMarketingExpenseAttachmentAccess(tenantDb, request.id, { id: SUBMITTER, role: "rep" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("404s an id that does not exist", async () => {
    await expect(
      assertMarketingExpenseAttachmentAccess(tenantDb, U("dead"), { id: SUBMITTER, role: "rep" }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
