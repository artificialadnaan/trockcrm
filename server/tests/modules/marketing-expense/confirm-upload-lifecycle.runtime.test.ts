// A stale upload grant must not be able to file evidence on a request that has moved on.
//
// THE HOLE THIS PINS. The lifecycle rule — attachments are the SUBMITTER's, and only while the decision is
// still outstanding — was enforced at grant time (`POST /files/upload-url`) and nowhere else. `confirmUpload`
// then persisted the association carried in the token. Between those two calls a request can be submitted,
// approved, denied or withdrawn, so the window was: take a grant while the request is a draft, wait for the
// approver to decide, confirm. New evidence lands on a decided request and the trail says it was there all
// along.
//
// The window is not narrow, either: the grant lives in an in-process Map, so it survives for the token's
// full lifetime on that replica and nothing invalidates it when the request changes state.
//
// These cases drive the REAL confirmUpload against a real `files` table built from the Drizzle definitions,
// and mutate the request row between grant and confirm — which is exactly the attacker's sequence, and is
// perfectly expressible sequentially.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  files,
  marketingExpenseRequestApprovals,
  marketingExpenseRequests,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  confirmUpload,
  getPendingUploadMetadata,
  requestUploadUrl,
  uploadNewVersion,
} from "../../../src/modules/files/service.js";
import {
  createMarketingExpenseRequest,
  submitMarketingExpenseRequest,
  decideMarketingExpenseRequest,
  withdrawMarketingExpenseRequest,
} from "../../../src/modules/marketing-expense/service.js";

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
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type varchar(100) NOT NULL, payload jsonb NOT NULL,
      office_id uuid, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3, last_error text, started_processing_at timestamptz,
      run_after timestamptz NOT NULL DEFAULT NOW(), created_at timestamptz NOT NULL DEFAULT NOW(),
      completed_at timestamptz
    );
    CREATE TABLE public.marketing_expense_request_sequences (
      tenant_schema text PRIMARY KEY, last_number integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );
    INSERT INTO public.users (id, email, display_name, role) VALUES
      ('${SUBMITTER}', 'reggie@trockgc.com', 'Reggie Rep', 'rep'),
      ('${OTHER_REP}', 'rita@trockgc.com', 'Rita Rep', 'rep'),
      ('${APPROVER}', 'tyamashita@trockgc.com', 'Takashi Yamashita', 'director');
    INSERT INTO public.notification_recipient_groups (key, name)
      VALUES ('marketing_expense_approver', 'Marketing Expense Approver');
    INSERT INTO public.notification_recipient_assignments (group_id, user_id)
      SELECT id, '${APPROVER}' FROM public.notification_recipient_groups
       WHERE key = 'marketing_expense_approver';
  `);

  // The REAL files table, derived from the Drizzle definitions rather than hand-rolled, so the insert
  // confirmUpload performs is the insert prod performs.
  await pg.exec(
    tenantSchemaSql("public", [files, marketingExpenseRequests, marketingExpenseRequestApprovals]),
  );
  await pg.exec(`
    ALTER TABLE public.marketing_expense_requests
      ADD CONSTRAINT marketing_expense_requests_number_uq UNIQUE (request_number);
    -- tenantSchemaSql omits indexes by design, but confirmUpload's insert uses
    -- ON CONFLICT (client_upload_id) WHERE client_upload_id IS NOT NULL, and Postgres cannot infer an
    -- arbiter index that does not exist (42P10). This is the partial unique index migration 0170 creates.
    CREATE UNIQUE INDEX files_client_upload_id_uidx
      ON public.files (client_upload_id) WHERE client_upload_id IS NOT NULL;
    -- Supplying a clientUploadId sends confirmUpload through the scorecard edit-evidence lookup
    -- (migration 0185). Nothing here is a scorecard, so the table just has to exist for the read.
    CREATE TABLE public.field_scorecard_edit_uploads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scorecard_id uuid, deal_id uuid, client_upload_id text, uploaded_by uuid, file_id uuid,
      state text, created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );
  `);
  tenantDb = drizzle(pg);
}, 30_000);

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM public.files;
    DELETE FROM public.marketing_expense_request_approvals;
    DELETE FROM public.marketing_expense_requests;
    DELETE FROM public.job_queue;
    UPDATE public.marketing_expense_request_sequences SET last_number = 0;
  `);
});

async function draft() {
  return createMarketingExpenseRequest(tenantDb, {
    tenantSchema: "office_dallas",
    userId: SUBMITTER,
    input: INPUT,
  });
}

/** Mint a real upload grant, exactly as POST /files/upload-url does. */
async function grantFor(requestId: string, userId = SUBMITTER) {
  const grant = await requestUploadUrl(tenantDb, "dallas", userId, {
    originalFilename: "quote.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 4096,
    category: "proposal",
    marketingExpenseRequestId: requestId,
  });
  return grant.uploadToken;
}

async function fileCount() {
  const result = await pg.query<{ count: number }>(`SELECT count(*)::int AS count FROM public.files`);
  return result.rows[0]?.count ?? 0;
}

async function submit(requestId: string) {
  await submitMarketingExpenseRequest(tenantDb, {
    tenantSchema: "office_dallas",
    officeId: null,
    userId: SUBMITTER,
    requestId,
  });
}

describe("confirmUpload re-asserts the expense-request lifecycle", () => {
  it("still lets the submitter confirm while the request is a draft", async () => {
    const request = await draft();
    const token = await grantFor(request.id);
    const result = await confirmUpload(tenantDb, SUBMITTER, { uploadToken: token });
    expect(result.file.marketingExpenseRequestId).toBe(request.id);
  });

  it("preserves request ownership when a draft attachment is replaced with a new version", async () => {
    // The caller cannot name the request in a version-upload body. The parent is the authoritative owner;
    // dropping that association makes request-only attachments fail validateAssociations before they can be
    // corrected, while accepting caller input would let a version escape to another request.
    const request = await draft();
    const original = await confirmUpload(tenantDb, SUBMITTER, {
      uploadToken: await grantFor(request.id),
    });

    const replacement = await uploadNewVersion(tenantDb, "dallas", SUBMITTER, original.file.id, {
      originalFilename: "revised-quote.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 4096,
      category: "proposal",
    });
    expect(getPendingUploadMetadata(replacement.uploadToken)?.marketingExpenseRequestId).toBe(request.id);

    const confirmed = await confirmUpload(tenantDb, SUBMITTER, {
      uploadToken: replacement.uploadToken,
    });
    expect(confirmed.file.marketingExpenseRequestId).toBe(request.id);
    expect(confirmed.file.parentFileId).toBe(original.file.id);
  });

  it("REFUSES a grant confirmed after the request was submitted", async () => {
    // The submit is the moment the approver is told. A grant taken before it and confirmed after adds a
    // document to a request somebody has already been asked to review.
    const request = await draft();
    const token = await grantFor(request.id);
    await submit(request.id);
    await expect(confirmUpload(tenantDb, SUBMITTER, { uploadToken: token })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await fileCount()).toBe(0);
  });

  it("REFUSES a grant taken while the request was a draft and confirmed after it was APPROVED", async () => {
    const request = await draft();
    const token = await grantFor(request.id);
    await submit(request.id);
    await decideMarketingExpenseRequest(tenantDb, {
      tenantSchema: "office_dallas",
      officeId: null,
      requestId: request.id,
      userId: APPROVER,
      decision: "approved",
      reason: null,
    });

    await expect(confirmUpload(tenantDb, SUBMITTER, { uploadToken: token })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await fileCount()).toBe(0);
  });

  it("REFUSES the same stale grant after a DENIAL", async () => {
    const request = await draft();
    const token = await grantFor(request.id);
    await submit(request.id);
    await decideMarketingExpenseRequest(tenantDb, {
      tenantSchema: "office_dallas",
      officeId: null,
      requestId: request.id,
      userId: APPROVER,
      decision: "denied",
      reason: "Over budget for the quarter",
    });

    await expect(confirmUpload(tenantDb, SUBMITTER, { uploadToken: token })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await fileCount()).toBe(0);
  });

  it("REFUSES the same stale grant after a WITHDRAWAL", async () => {
    const request = await draft();
    const token = await grantFor(request.id);
    await submit(request.id);
    await withdrawMarketingExpenseRequest(tenantDb, { requestId: request.id, userId: SUBMITTER });

    await expect(confirmUpload(tenantDb, SUBMITTER, { uploadToken: token })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await fileCount()).toBe(0);
  });

  it("re-asserts OWNERSHIP at confirm time, not just at grant time", async () => {
    // The grant was minted for the submitter; a different user presenting the same token must not have
    // the token's stored association trusted on their behalf.
    const request = await draft();
    const token = await grantFor(request.id);

    await expect(confirmUpload(tenantDb, OTHER_REP, { uploadToken: token })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await fileCount()).toBe(0);
  });

  it("reads the request ROW at confirm time rather than trusting the token", async () => {
    // Nothing about the token changes here — only the database does. If the check were satisfied by
    // anything cached in the grant, this would still succeed.
    const request = await draft();
    const token = await grantFor(request.id);
    await pg.exec(
      `UPDATE public.marketing_expense_requests SET submitted_by = '${OTHER_REP}' WHERE id = '${request.id}'`,
    );

    await expect(confirmUpload(tenantDb, SUBMITTER, { uploadToken: token })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await fileCount()).toBe(0);
  });

  // ASSERT THE ARTIFACT. The route test next door proves the key is forwarded; this proves what forwarding
  // it BUYS — the column is populated and the server-side dedup actually fires. A lost confirm-upload
  // response is retried by the form with the same key, and must not produce a second row or a second R2
  // object for one supporting document.
  it("persists the idempotency key on the row", async () => {
    const request = await draft();
    const token = await grantFor(request.id);
    const result = await confirmUpload(tenantDb, SUBMITTER, {
      uploadToken: token,
      clientUploadId: "attachment-key-1",
    });
    expect(result.file.clientUploadId).toBe("attachment-key-1");
  });

  it("DEDUPES a retry that reuses the key, instead of filing the document twice", async () => {
    const request = await draft();
    const first = await confirmUpload(tenantDb, SUBMITTER, {
      uploadToken: await grantFor(request.id),
      clientUploadId: "attachment-key-2",
    });
    expect(first.created).toBe(true);

    // The form retries the same file after a lost response: a fresh grant, the SAME key.
    const retry = await confirmUpload(tenantDb, SUBMITTER, {
      uploadToken: await grantFor(request.id),
      clientUploadId: "attachment-key-2",
    });
    expect(retry.created).toBe(false);
    expect(retry.file.id).toBe(first.file.id);
    expect(await fileCount()).toBe(1);
  });

  it("still files two DIFFERENT documents separately", async () => {
    const request = await draft();
    await confirmUpload(tenantDb, SUBMITTER, {
      uploadToken: await grantFor(request.id),
      clientUploadId: "key-a",
    });
    await confirmUpload(tenantDb, SUBMITTER, {
      uploadToken: await grantFor(request.id),
      clientUploadId: "key-b",
    });
    expect(await fileCount()).toBe(2);
  });

  it("leaves uploads with no expense request completely alone", async () => {
    const grant = await requestUploadUrl(tenantDb, "dallas", SUBMITTER, {
      originalFilename: "site.jpg",
      mimeType: "image/jpeg",
      fileSizeBytes: 2048,
      category: "photo",
      // A contact rather than a deal: confirmUpload looks a deal number up for the R2 key, and this
      // fixture has no deals table. The association is irrelevant to what this case asserts.
      contactId: U("c1"),
    });
    await expect(
      confirmUpload(tenantDb, SUBMITTER, { uploadToken: grant.uploadToken }),
    ).resolves.toBeDefined();
  });
});
