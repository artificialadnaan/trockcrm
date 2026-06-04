import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/**
 * REAL-SQL (PGlite) proof that the RFP override-review actions interact safely with migration 0148's
 * `deals_rfp_rejected_email_trg` (which emails the rep + leadership on pending -> declined).
 *
 * The override page exposes two actions on a DECLINED deal:
 *   - APPROVE (override)  -> re-submit: the deal's RFP fields reset to 'pending_outbox' for a fresh cycle;
 *   - RE-CONFIRM denial   -> only the rfp_override_* columns are written; rfp_approval_status stays 'declined'.
 *
 * This installs the ACTUAL 0148 trigger function (extracted from the migration) on a throwaway tenant schema
 * whose deals table carries the migration-0151 override columns, then drives the two override transitions with
 * the SAME column writes the service performs, locking these invariants:
 *   - approve/override (declined -> pending_outbox)         -> NO rfp_rejected_email job (not a fresh decline);
 *   - re-confirm denial (status untouched, override cols)    -> NO job (the UPDATE OF rfp_approval_status filter);
 *   - a genuine re-open (override) then a NEW-cycle decline   -> a NEW job, proving the rescue still flows through
 *                                                               the real SyncHub decline pipeline on a re-decline.
 *
 * Inverting any guard (e.g. firing the email when leadership re-opens a deal) breaks these assertions.
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
const REVIEWER = "00000000-0000-0000-0000-0000000000a1";

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
      rfp_approval_request_event_id uuid,
      rfp_approval_requested_at timestamptz,
      rfp_approval_requested_by uuid,
      rfp_declined_reason text,
      rfp_declined_at timestamptz,
      rfp_last_attempt_error text,
      rfp_override_reviewed_at timestamptz,
      rfp_override_reviewed_by uuid,
      rfp_override_decision text,
      rfp_override_note text
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

async function insertDeclinedDeal(db: PGlite, requestId: number | null): Promise<void> {
  await db.query(
    `INSERT INTO ${SCHEMA}.deals
       (id, name, deal_number, rfp_approval_status, rfp_approval_request_id, rfp_declined_reason, rfp_declined_at, rfp_approval_requested_by)
     VALUES ($1, 'jasonn ranches', 'TR-1001', 'declined', $2, 'Margins too thin', now(), $3)`,
    [DEAL, requestId, REQUESTER],
  );
}

/** The exact column writes the override-approve (re-submit) service performs. */
async function overrideApproveResubmit(db: PGlite, id: string): Promise<number> {
  const res = await db.query(
    `UPDATE ${SCHEMA}.deals
        SET rfp_approval_status = 'pending_outbox',
            rfp_approval_request_id = NULL,
            rfp_approval_request_event_id = gen_random_uuid(),
            rfp_approval_requested_at = now(),
            rfp_declined_reason = NULL,
            rfp_declined_at = NULL,
            rfp_last_attempt_error = NULL,
            rfp_override_reviewed_at = NULL,
            rfp_override_reviewed_by = NULL,
            rfp_override_decision = NULL,
            rfp_override_note = NULL
      WHERE id = $1
        AND rfp_approval_status = 'declined'
        AND rfp_override_reviewed_at IS NULL`,
    [id],
  );
  return res.affectedRows ?? 0;
}

/** The exact column writes the re-confirm-denial service performs (status column NOT in the SET list). */
async function reconfirmDenial(db: PGlite, id: string): Promise<number> {
  const res = await db.query(
    `UPDATE ${SCHEMA}.deals
        SET rfp_override_reviewed_at = now(),
            rfp_override_reviewed_by = $2,
            rfp_override_decision = 'denial_reconfirmed',
            rfp_override_note = 'Confirmed no-go'
      WHERE id = $1
        AND rfp_approval_status = 'declined'
        AND rfp_override_reviewed_at IS NULL`,
    [id, REVIEWER],
  );
  return res.affectedRows ?? 0;
}

async function emailJobs(db: PGlite): Promise<Array<{ payload: any }>> {
  const res = await db.query<{ payload: any }>(
    `SELECT payload FROM public.job_queue WHERE job_type = 'rfp_rejected_email' ORDER BY id`,
  );
  return res.rows;
}

describe("RFP override-review actions vs migration 0148 decline-email trigger (real SQL)", () => {
  it("approve/override (declined -> pending_outbox) does NOT enqueue a decline email", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, 55);

    const affected = await overrideApproveResubmit(pg, DEAL);

    expect(affected).toBe(1);
    expect(await emailJobs(pg)).toHaveLength(0);
    const [{ status }] = (
      await pg.query<{ status: string }>(`SELECT rfp_approval_status AS status FROM ${SCHEMA}.deals WHERE id = $1`, [DEAL])
    ).rows;
    expect(status).toBe("pending_outbox");
  });

  it("re-confirm denial (override columns only, status stays 'declined') does NOT enqueue a decline email", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, 55);

    const affected = await reconfirmDenial(pg, DEAL);

    expect(affected).toBe(1);
    expect(await emailJobs(pg)).toHaveLength(0);
    const [row] = (
      await pg.query<{ status: string; decision: string; reviewed_at: string | null }>(
        `SELECT rfp_approval_status AS status, rfp_override_decision AS decision, rfp_override_reviewed_at AS reviewed_at
           FROM ${SCHEMA}.deals WHERE id = $1`,
        [DEAL],
      )
    ).rows;
    expect(row.status).toBe("declined");
    expect(row.decision).toBe("denial_reconfirmed");
    expect(row.reviewed_at).not.toBeNull();
  });

  it("a re-confirmed deal is not actionable twice (the WHERE guard blocks a second review)", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, 55);
    await reconfirmDenial(pg, DEAL);

    // Second attempts (either action) must no-op: already reviewed.
    expect(await reconfirmDenial(pg, DEAL)).toBe(0);
    expect(await overrideApproveResubmit(pg, DEAL)).toBe(0);
    expect(await emailJobs(pg)).toHaveLength(0);
  });

  it("a genuine re-open (override) then a NEW-cycle decline still emails (rescue flows through the real pipeline)", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, 55);

    // Leadership approves the override -> re-submit (declined -> pending_outbox), no email.
    await overrideApproveResubmit(pg, DEAL);
    expect(await emailJobs(pg)).toHaveLength(0);

    // Worker delivers to SyncHub -> pending with a NEW request id.
    await pg.query(
      `UPDATE ${SCHEMA}.deals SET rfp_approval_status = 'pending', rfp_approval_request_id = 56 WHERE id = $1`,
      [DEAL],
    );
    // SyncHub declines the new cycle -> a fresh decline email for request id 56.
    await pg.query(
      `UPDATE ${SCHEMA}.deals SET rfp_approval_status = 'declined', rfp_declined_reason = 'Still no' WHERE id = $1`,
      [DEAL],
    );

    const jobs = await emailJobs(pg);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.rfpApprovalRequestId).toBe(56);
    // the original requester was preserved through the rescue, so the re-decline still notifies them
    expect(jobs[0].payload.requestedByUserId).toBe(REQUESTER);
  });

  it("approve is a no-op once the deal is already re-submitted (status guard, not just the reviewed guard)", async () => {
    pg = await setup();
    await insertDeclinedDeal(pg, 55);
    expect(await overrideApproveResubmit(pg, DEAL)).toBe(1); // declined -> pending_outbox

    // Second approve: rfp_override_reviewed_at is back to NULL, so ONLY the status='declined' clause blocks it.
    expect(await overrideApproveResubmit(pg, DEAL)).toBe(0);
    expect(await emailJobs(pg)).toHaveLength(0);
    const [{ status }] = (
      await pg.query<{ status: string }>(`SELECT rfp_approval_status AS status FROM ${SCHEMA}.deals WHERE id = $1`, [DEAL])
    ).rows;
    expect(status).toBe("pending_outbox");
  });

  it("neither action touches a non-declined RFP (e.g. already approved) — no double-trigger", async () => {
    pg = await setup();
    await pg.query(
      `INSERT INTO ${SCHEMA}.deals (id, name, deal_number, rfp_approval_status, rfp_approval_request_id, rfp_approval_requested_by)
       VALUES ($1, 'approved deal', 'TR-2', 'approved', 55, $2)`,
      [DEAL, REQUESTER],
    );

    expect(await overrideApproveResubmit(pg, DEAL)).toBe(0);
    expect(await reconfirmDenial(pg, DEAL)).toBe(0);
    expect(await emailJobs(pg)).toHaveLength(0);
    const [{ status }] = (
      await pg.query<{ status: string }>(`SELECT rfp_approval_status AS status FROM ${SCHEMA}.deals WHERE id = $1`, [DEAL])
    ).rows;
    expect(status).toBe("approved");
  });
});
