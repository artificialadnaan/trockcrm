import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/**
 * REAL-SQL (PGlite) proof for migration 0155 — email the requesting rep + leadership when an OVERRIDE-approve
 * is CONFIRMED successful: the SyncHub `created` callback flips the deal rfp_approval_status -> 'approved'
 * (Bid Board project created + deal advanced) while rfp_override_decision is still 'override_approved'.
 * Installs the ACTUAL trigger function (extracted from the migration file) on a throwaway tenant schema,
 * attaches it AFTER UPDATE OF rfp_approval_status (exactly as the migration does), and drives it with real
 * DML to lock the invariants:
 *   - override created success (declined -> approved, decision='override_approved') -> exactly ONE job;
 *   - the approve CLICK (sets state='approving'/decision, status stays declined)   -> NO job (premature);
 *   - a FAILURE callback (state='failed', status stays declined)                    -> NO job;
 *   - an ORIGINAL (non-override) approval (decision NULL, requested -> approved)    -> NO job (override-only);
 *   - a repeated/duplicate created callback (approved -> approved)                  -> NO new job;
 *   - NULL rfp_approval_request_id                                                  -> NO job (no cycle key).
 *
 * All gating lives in the function (no WHEN clause), so this exercises the real gating and inverting any
 * guard breaks these assertions (load-bearing).
 */

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0155_rfp_override_approved_email.sql", import.meta.url),
  "utf8",
);

const FN = extractFunction(MIGRATION_SQL);

function extractFunction(sql: string): string {
  const match = sql.match(/CREATE OR REPLACE FUNCTION public\.enqueue_rfp_override_approved_email[\s\S]*?\$\$;/);
  if (!match) throw new Error("could not extract enqueue_rfp_override_approved_email function body");
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
      rfp_approval_requested_by uuid,
      rfp_override_decision text,
      rfp_override_state text
    );
  `);
  await db.exec(FN);
  await db.exec(`
    CREATE TRIGGER deals_rfp_override_approved_email_trg
      AFTER UPDATE OF rfp_approval_status ON ${SCHEMA}.deals
      FOR EACH ROW EXECUTE FUNCTION public.enqueue_rfp_override_approved_email();
  `);
  return db;
}

async function insertDeal(
  db: PGlite,
  opts: { status: string; decision: string | null; state?: string | null; requestId: number | null; requestedBy?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO ${SCHEMA}.deals
       (id, name, deal_number, rfp_approval_status, rfp_approval_request_id, rfp_approval_requested_by, rfp_override_decision, rfp_override_state)
     VALUES ($1, 'jasonn ranches', 'TR-1001', $2, $3, $4, $5, $6)`,
    [DEAL, opts.status, opts.requestId, opts.requestedBy ?? REQUESTER, opts.decision, opts.state ?? null],
  );
}

/** The SyncHub `created` callback's linkage UPDATE — flips status -> 'approved' + clears the override state. */
async function createdCallback(db: PGlite, id: string): Promise<void> {
  await db.query(
    `UPDATE ${SCHEMA}.deals SET rfp_approval_status = 'approved', rfp_override_state = NULL WHERE id = $1`,
    [id],
  );
}

async function approvedJobs(db: PGlite): Promise<Array<{ payload: any }>> {
  const res = await db.query<{ payload: any }>(
    `SELECT payload FROM public.job_queue WHERE job_type = 'rfp_override_approved_email' ORDER BY id`,
  );
  return res.rows;
}

describe("migration 0155 — rfp_override_approved_email trigger (real SQL)", () => {
  it("enqueues exactly one job on a CONFIRMED override-approve (declined -> approved, decision override_approved)", async () => {
    pg = await setup();
    await insertDeal(pg, { status: "declined", decision: "override_approved", state: "approving", requestId: 55 });
    await createdCallback(pg, DEAL);

    const jobs = await approvedJobs(pg);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({
      tenantSchema: SCHEMA,
      dealId: DEAL,
      dealNumber: "TR-1001",
      dealName: "jasonn ranches",
      rfpApprovalRequestId: 55,
      requestedByUserId: REQUESTER,
    });
  });

  it("does NOT enqueue on the approve CLICK (state -> approving, status stays declined) — fires only on confirmed success", async () => {
    pg = await setup();
    await insertDeal(pg, { status: "declined", decision: null, requestId: 55 });
    // the approve click: requestOverrideApproval sets decision + state, but NOT rfp_approval_status
    await pg.query(
      `UPDATE ${SCHEMA}.deals SET rfp_override_decision = 'override_approved', rfp_override_state = 'approving' WHERE id = $1`,
      [DEAL],
    );
    expect(await approvedJobs(pg)).toHaveLength(0);
  });

  it("does NOT enqueue on a FAILURE callback (state -> failed, status stays declined)", async () => {
    pg = await setup();
    await insertDeal(pg, { status: "declined", decision: "override_approved", state: "approving", requestId: 55 });
    await pg.query(`UPDATE ${SCHEMA}.deals SET rfp_override_state = 'failed' WHERE id = $1`, [DEAL]);
    expect(await approvedJobs(pg)).toHaveLength(0);
  });

  it("does NOT enqueue on an ORIGINAL (non-override) approval (decision NULL, requested -> approved)", async () => {
    pg = await setup();
    await insertDeal(pg, { status: "requested", decision: null, requestId: 55 });
    await createdCallback(pg, DEAL); // status -> approved, but no override decision
    expect(await approvedJobs(pg)).toHaveLength(0);
  });

  it("does NOT enqueue twice on a duplicate/replayed created callback (approved -> approved)", async () => {
    pg = await setup();
    await insertDeal(pg, { status: "declined", decision: "override_approved", state: "approving", requestId: 55 });
    await createdCallback(pg, DEAL);
    await createdCallback(pg, DEAL); // replay — already approved, no fresh transition
    expect(await approvedJobs(pg)).toHaveLength(1);
  });

  it("does NOT enqueue a success with a NULL rfp_approval_request_id (no cycle key)", async () => {
    pg = await setup();
    await insertDeal(pg, { status: "declined", decision: "override_approved", state: "approving", requestId: null });
    await createdCallback(pg, DEAL);
    expect(await approvedJobs(pg)).toHaveLength(0);
  });

  it("does NOT enqueue when a LATER cycle is approved NORMALLY carrying a STALE override_approved decision", async () => {
    pg = await setup();
    // a deal that succeeded via override in a PRIOR cycle, then re-opened: the re-open (rfp-request-delivery.ts)
    // set status back to 'pending' under a new request id but did NOT clear rfp_override_decision, so it carries
    // a stale 'override_approved'. The new cycle is then approved NORMALLY (pending -> approved, no override).
    await insertDeal(pg, { status: "pending", decision: "override_approved", requestId: 56 });
    await createdCallback(pg, DEAL); // pending -> approved (OLD <> 'declined') — NOT an override this cycle
    // gating on the cycle-current transition (OLD='declined') keeps the stale decision from firing a bogus email
    expect(await approvedJobs(pg)).toHaveLength(0);
  });
});
