import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/**
 * REAL-SQL (PGlite) proof for migration 0154 — email the requesting rep + leadership when a reviewer
 * RE-CONFIRMS a declined RFP (rfp_override_decision -> 'denial_reconfirmed') on the override-review page.
 * Installs the ACTUAL trigger function (extracted from the migration file) on a throwaway tenant schema,
 * attaches it AFTER UPDATE OF rfp_override_decision (exactly as the migration does), and drives it with
 * real DML to lock the invariants:
 *   - reconfirm (NULL -> 'denial_reconfirmed')        -> exactly one rfp_reconfirm_denial_email job;
 *   - approve  (NULL -> 'override_approved')          -> NO job (re-confirm-only; approve emails elsewhere);
 *   - a second reconfirm (reconfirmed -> reconfirmed) -> NO new job (no fresh transition / no spam);
 *   - an edit that doesn't touch rfp_override_decision -> NO job (the UPDATE OF rfp_override_decision filter);
 *   - reconfirm with NULL rfp_approval_request_id     -> NO job (no cycle key to dedup on).
 *
 * All gating lives in the function (no WHEN clause), so this exercises the real gating and inverting any
 * guard breaks these assertions (load-bearing).
 */

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0154_rfp_reconfirm_denial_email.sql", import.meta.url),
  "utf8",
);

const FN = extractFunction(MIGRATION_SQL);

function extractFunction(sql: string): string {
  const match = sql.match(/CREATE OR REPLACE FUNCTION public\.enqueue_rfp_reconfirm_denial_email[\s\S]*?\$\$;/);
  if (!match) throw new Error("could not extract enqueue_rfp_reconfirm_denial_email function body");
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
      id uuid PRIMARY KEY,
      name text NOT NULL,
      deal_number text NOT NULL,
      rfp_approval_status text,
      rfp_approval_request_id integer,
      rfp_declined_reason text,
      rfp_approval_requested_by uuid,
      rfp_override_decision text
    );
  `);
  await db.exec(FN);
  await db.exec(`
    CREATE TRIGGER deals_rfp_reconfirm_denial_email_trg
      AFTER UPDATE OF rfp_override_decision ON ${SCHEMA}.deals
      FOR EACH ROW EXECUTE FUNCTION public.enqueue_rfp_reconfirm_denial_email();
  `);
  return db;
}

async function insertDeclinedDeal(
  db: PGlite,
  opts: { requestId: number | null; requestedBy?: string | null } = { requestId: 55 },
): Promise<void> {
  await db.query(
    `INSERT INTO ${SCHEMA}.deals
       (id, name, deal_number, rfp_approval_status, rfp_approval_request_id, rfp_declined_reason, rfp_approval_requested_by, rfp_override_decision)
     VALUES ($1, 'jasonn ranches', 'TR-1001', 'declined', $2, 'Margins too thin', $3, NULL)`,
    [DEAL, opts.requestId, opts.requestedBy ?? REQUESTER],
  );
}

/** reconfirmRfpDecline's decision write (the override-review "re-confirm denial" action). */
async function reconfirm(db: PGlite, id: string): Promise<void> {
  await db.query(
    `UPDATE ${SCHEMA}.deals SET rfp_override_decision = 'denial_reconfirmed' WHERE id = $1`,
    [id],
  );
}

/** requestOverrideApproval's decision write (the override-review "approve override" action). */
async function approve(db: PGlite, id: string): Promise<void> {
  await db.query(
    `UPDATE ${SCHEMA}.deals SET rfp_override_decision = 'override_approved' WHERE id = $1`,
    [id],
  );
}

async function reconfirmJobs(db: PGlite): Promise<Array<{ payload: any }>> {
  const res = await db.query<{ payload: any }>(
    `SELECT payload FROM public.job_queue WHERE job_type = 'rfp_reconfirm_denial_email' ORDER BY id`,
  );
  return res.rows;
}

describe("migration 0154 — rfp_reconfirm_denial_email trigger (real SQL)", () => {
  it("enqueues exactly one job with the full payload on re-confirm (NULL -> denial_reconfirmed)", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, { requestId: 55 });
    await reconfirm(pg, DEAL);

    const jobs = await reconfirmJobs(pg);
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

  it("does NOT enqueue on approve (override_approved) — re-confirm only", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, { requestId: 55 });
    await approve(pg, DEAL);
    expect(await reconfirmJobs(pg)).toHaveLength(0);
  });

  it("does NOT enqueue twice on a repeated re-confirm (denial_reconfirmed -> denial_reconfirmed)", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, { requestId: 55 });
    await reconfirm(pg, DEAL);
    await reconfirm(pg, DEAL); // repeated action / re-fire — already reconfirmed, no fresh transition
    expect(await reconfirmJobs(pg)).toHaveLength(1);
  });

  it("does NOT enqueue on an edit that leaves rfp_override_decision untouched (e.g. a callback/read)", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, { requestId: 55 });
    // a bid-board-created callback or any other write that doesn't target rfp_override_decision
    await pg.query(`UPDATE ${SCHEMA}.deals SET name = 'renamed', rfp_declined_reason = 'edited' WHERE id = $1`, [DEAL]);
    expect(await reconfirmJobs(pg)).toHaveLength(0);
  });

  it("does NOT enqueue a re-confirm with a NULL rfp_approval_request_id (no cycle key)", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, { requestId: null });
    await reconfirm(pg, DEAL);
    expect(await reconfirmJobs(pg)).toHaveLength(0);
  });
});
