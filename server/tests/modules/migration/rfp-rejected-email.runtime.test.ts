import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/**
 * REAL-SQL (PGlite) proof for migration 0148 — email the requesting rep + leadership when a deal's RFP
 * is DECLINED. Installs the ACTUAL trigger function (extracted from the migration file) on a throwaway
 * tenant schema, attaches it AFTER UPDATE OF rfp_approval_status (exactly as the migration does), and
 * drives it with real DML to lock the invariants:
 *   - pending -> declined                      -> exactly one rfp_rejected_email job (full payload);
 *   - pending -> approved                       -> NO job (decline-only);
 *   - an RFP edit (name changes, status stays)  -> NO job (the UPDATE OF rfp_approval_status filter);
 *   - declined -> declined (re-delivered)       -> NO job (no fresh transition);
 *   - re-open (declined -> pending) then a NEW request id pending -> declined -> a NEW job (new cycle);
 *   - declined with NULL rfp_approval_request_id -> NO job (no cycle key to dedup on).
 *
 * All gating lives in the function (no WHEN clause), so this exercises the real gating and inverting any
 * guard breaks these assertions (load-bearing — verified in R3 by inverting the OLD-distinct check).
 */

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0148_rfp_rejected_email.sql", import.meta.url),
  "utf8",
);

const FN = extractFunction(MIGRATION_SQL);

function extractFunction(sql: string): string {
  const match = sql.match(/CREATE OR REPLACE FUNCTION public\.enqueue_rfp_rejected_email[\s\S]*?\$\$;/);
  if (!match) throw new Error("could not extract enqueue_rfp_rejected_email function body");
  return match[0];
}

const SCHEMA = "office_test";
const DEAL = "00000000-0000-0000-0000-0000000000d1";
const REQUESTER = "00000000-0000-0000-0000-000000000099";

let pg: PGlite | null = null;

afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function setup(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY,
      job_type text NOT NULL,
      payload jsonb NOT NULL,
      office_id uuid,
      status text NOT NULL,
      run_after timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid,
      name text NOT NULL,
      deal_number text NOT NULL,
      rfp_approval_status text,
      rfp_approval_request_id integer,
      rfp_declined_reason text,
      rfp_approval_requested_by uuid
    );
  `);
  await db.exec(FN);
  await db.exec(`
    CREATE TRIGGER deals_rfp_rejected_email_trg
      AFTER UPDATE OF rfp_approval_status ON ${SCHEMA}.deals
      FOR EACH ROW EXECUTE FUNCTION public.enqueue_rfp_rejected_email();
  `);
  return db;
}

async function insertPendingDeal(
  db: PGlite,
  opts: { id?: string; name?: string; dealNumber?: string; requestId: number | null; requestedBy?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO ${SCHEMA}.deals (id, name, deal_number, rfp_approval_status, rfp_approval_request_id, rfp_approval_requested_by)
     VALUES ($1, $2, $3, 'pending', $4, $5)`,
    [opts.id ?? DEAL, opts.name ?? "jasonn ranches", opts.dealNumber ?? "TR-1001", opts.requestId, opts.requestedBy ?? REQUESTER],
  );
}

async function setStatus(db: PGlite, id: string, status: string, reason?: string | null): Promise<void> {
  await db.query(
    `UPDATE ${SCHEMA}.deals SET rfp_approval_status = $2, rfp_declined_reason = COALESCE($3, rfp_declined_reason) WHERE id = $1`,
    [id, status, reason ?? null],
  );
}

async function emailJobs(db: PGlite): Promise<Array<{ payload: any }>> {
  const res = await db.query<{ payload: any }>(
    `SELECT payload FROM public.job_queue WHERE job_type = 'rfp_rejected_email' ORDER BY id`,
  );
  return res.rows;
}

describe("migration 0148 — rfp_rejected_email trigger (real SQL)", () => {
  it("enqueues exactly one job with the full payload on pending -> declined", async () => {
    pg = await setup();
    await insertPendingDeal(pg, { requestId: 55 });
    await setStatus(pg, DEAL, "declined", "Margins too thin");

    const jobs = await emailJobs(pg);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({
      tenantSchema: SCHEMA,
      dealId: DEAL,
      dealNumber: "TR-1001",
      dealName: "jasonn ranches",
      declinedReason: "Margins too thin",
      rfpApprovalRequestId: 55,
      requestedByUserId: REQUESTER,
    });
  });

  it("does NOT enqueue on approval", async () => {
    pg = await setup();
    await insertPendingDeal(pg, { requestId: 55 });
    await setStatus(pg, DEAL, "approved");
    expect(await emailJobs(pg)).toHaveLength(0);
  });

  it("does NOT enqueue on an RFP edit (name changes, status untouched)", async () => {
    pg = await setup();
    await insertPendingDeal(pg, { requestId: 55 });
    await pg.query(`UPDATE ${SCHEMA}.deals SET name = 'renamed by edit' WHERE id = $1`, [DEAL]);
    expect(await emailJobs(pg)).toHaveLength(0);
  });

  it("does NOT enqueue twice on a re-delivered/duplicate decline (declined -> declined)", async () => {
    pg = await setup();
    await insertPendingDeal(pg, { requestId: 55 });
    await setStatus(pg, DEAL, "declined", "Margins too thin");
    await setStatus(pg, DEAL, "declined", "Margins too thin"); // re-delivery: already declined
    expect(await emailJobs(pg)).toHaveLength(1);
  });

  it("enqueues again on a genuine re-open + re-decline under a NEW request id", async () => {
    pg = await setup();
    await insertPendingDeal(pg, { requestId: 55 });
    await setStatus(pg, DEAL, "declined", "First cycle");
    // re-open: SyncHub issues a new approval request, status goes back to pending with a new request id
    await pg.query(
      `UPDATE ${SCHEMA}.deals SET rfp_approval_status = 'pending', rfp_approval_request_id = 56 WHERE id = $1`,
      [DEAL],
    );
    await setStatus(pg, DEAL, "declined", "Second cycle");

    const jobs = await emailJobs(pg);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].payload.rfpApprovalRequestId).toBe(55);
    expect(jobs[1].payload.rfpApprovalRequestId).toBe(56);
  });

  it("does NOT enqueue a decline with a NULL rfp_approval_request_id (no cycle key)", async () => {
    pg = await setup();
    await insertPendingDeal(pg, { requestId: null });
    await setStatus(pg, DEAL, "declined", "no request id");
    expect(await emailJobs(pg)).toHaveLength(0);
  });
});
