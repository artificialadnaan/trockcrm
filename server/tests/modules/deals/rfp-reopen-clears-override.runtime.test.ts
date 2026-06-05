import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/**
 * REAL-SQL (PGlite) proof that a RE-OPEN (worker updateDealPending) clears the override-review state, so a deal
 * re-confirmed (or override-approved) in a PRIOR cycle does not carry stale rfp_override_* into the next cycle.
 *
 * Without the clear, a stale 'denial_reconfirmed' makes reconfirmRfpDecline's guarded UPDATE match 0 rows -> it
 * silently SUPPRESSES the new cycle's re-confirm + the #651 email. This installs the REAL migration-0154
 * reconfirm-email trigger so the test also proves the new cycle's re-confirm actually FIRES the email once the
 * override state is cleared. The `reopen`/`reconfirm` helpers mirror worker/src/jobs/rfp-request-delivery.ts
 * (updateDealPending) and server/src/modules/deals/rfp-override-service.ts (reconfirmRfpDecline) respectively.
 */

const MIGRATION_0154 = readFileSync(
  new URL("../../../../migrations/0154_rfp_reconfirm_denial_email.sql", import.meta.url),
  "utf8",
);
const RECONFIRM_FN = extractFn(MIGRATION_0154, "enqueue_rfp_reconfirm_denial_email");

function extractFn(sql: string, name: string): string {
  const match = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`));
  if (!match) throw new Error(`could not extract ${name}`);
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
      id bigserial PRIMARY KEY, job_type text NOT NULL, payload jsonb NOT NULL, office_id uuid,
      status text NOT NULL, run_after timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.deals (
      id uuid PRIMARY KEY, name text NOT NULL, deal_number text NOT NULL,
      rfp_approval_status text, rfp_approval_request_id integer, rfp_approval_token text,
      rfp_approval_requested_by uuid, rfp_declined_reason text,
      rfp_conflict_reason text, rfp_conflict_with jsonb, rfp_last_attempt_error text,
      rfp_override_decision text, rfp_override_reviewed_at timestamptz, rfp_override_reviewed_by uuid,
      rfp_override_note text, rfp_override_state text, rfp_override_error text, updated_at timestamptz
    );
  `);
  await db.exec(RECONFIRM_FN);
  await db.exec(`
    CREATE TRIGGER deals_rfp_reconfirm_denial_email_trg
      AFTER UPDATE OF rfp_override_decision ON ${SCHEMA}.deals
      FOR EACH ROW EXECUTE FUNCTION public.enqueue_rfp_reconfirm_denial_email();
  `);
  return db;
}

/** A deal that was already RE-CONFIRMED in a prior cycle (cycle 1's terminal denial). */
async function insertReconfirmedDeal(db: PGlite, requestId: number): Promise<void> {
  await db.query(
    `INSERT INTO ${SCHEMA}.deals
       (id, name, deal_number, rfp_approval_status, rfp_approval_request_id, rfp_declined_reason, rfp_approval_requested_by, rfp_override_decision, rfp_override_reviewed_by)
     VALUES ($1, 'jasonn ranches', 'TR-1001', 'declined', $2, 'Margins too thin', $3, 'denial_reconfirmed', $4)`,
    [DEAL, requestId, REQUESTER, REVIEWER],
  );
}

/** updateDealPending's UPDATE (the re-open): new request id + status 'pending' + CLEARS the override fields. */
async function reopen(db: PGlite, id: string, requestId: number): Promise<void> {
  await db.query(
    `UPDATE ${SCHEMA}.deals
        SET rfp_approval_request_id = $1, rfp_approval_token = 'tok', rfp_approval_status = 'pending',
            rfp_conflict_reason = NULL, rfp_conflict_with = NULL, rfp_last_attempt_error = NULL,
            rfp_override_decision = NULL, rfp_override_reviewed_at = NULL, rfp_override_reviewed_by = NULL,
            rfp_override_note = NULL, rfp_override_state = NULL, rfp_override_error = NULL, updated_at = now()
      WHERE id = $2`,
    [requestId, id],
  );
}

async function decline(db: PGlite, id: string, requestId: number): Promise<void> {
  await db.query(
    `UPDATE ${SCHEMA}.deals SET rfp_approval_status = 'declined', rfp_approval_request_id = $2, rfp_declined_reason = 'no-go again' WHERE id = $1`,
    [id, requestId],
  );
}

/** reconfirmRfpDecline's guarded UPDATE. */
async function reconfirm(db: PGlite, id: string): Promise<number> {
  const res = await db.query(
    `UPDATE ${SCHEMA}.deals
        SET rfp_override_reviewed_at = now(), rfp_override_reviewed_by = $2, rfp_override_decision = 'denial_reconfirmed',
            rfp_override_note = NULL, rfp_override_state = NULL, rfp_override_error = NULL, updated_at = now()
      WHERE id = $1
        AND rfp_approval_status = 'declined'
        AND (rfp_override_state IS NULL OR rfp_override_state = 'failed' OR rfp_override_state = 'approving')
        AND (rfp_override_decision IS NULL OR rfp_override_decision <> 'denial_reconfirmed')`,
    [id, REVIEWER],
  );
  return res.affectedRows ?? 0;
}

async function reconfirmJobs(db: PGlite): Promise<Array<{ payload: any }>> {
  const res = await db.query<{ payload: any }>(
    `SELECT payload FROM public.job_queue WHERE job_type = 'rfp_reconfirm_denial_email' ORDER BY id`,
  );
  return res.rows;
}

describe("re-open clears override state so the new cycle can re-confirm + fire its email (real SQL)", () => {
  it("THE BUG: without clearing, a stale 'denial_reconfirmed' suppresses the new cycle's re-confirm (0 rows, no email)", async () => {
    pg = await setup();
    // cycle 1 was reconfirmed; a re-open that does NOT clear leaves decision='denial_reconfirmed' while the new
    // cycle (request id 56) is declined
    await insertReconfirmedDeal(pg, 55);
    await pg.query(`UPDATE ${SCHEMA}.deals SET rfp_approval_request_id = 56, rfp_approval_status = 'declined' WHERE id = $1`, [DEAL]);
    // the stale decision makes the guard match 0 rows -> the legitimate new-cycle re-confirm is silently dropped
    expect(await reconfirm(pg, DEAL)).toBe(0);
    expect(await reconfirmJobs(pg)).toHaveLength(0);
  });

  it("THE FIX: the re-opened deal clears override state, then re-confirms in its new cycle and FIRES the email", async () => {
    pg = await setup();
    await insertReconfirmedDeal(pg, 55);

    // re-open: new request id 56, status 'pending', override fields CLEARED (updateDealPending)
    await reopen(pg, DEAL, 56);
    const cleared = (await pg.query<{ decision: string | null; state: string | null; reviewedBy: string | null }>(
      `SELECT rfp_override_decision AS decision, rfp_override_state AS state, rfp_override_reviewed_by AS "reviewedBy" FROM ${SCHEMA}.deals WHERE id = $1`,
      [DEAL],
    )).rows[0];
    expect(cleared.decision).toBeNull();
    expect(cleared.state).toBeNull();
    expect(cleared.reviewedBy).toBeNull();

    // the new cycle gets declined, then a reviewer re-confirms its denial — NOT suppressed
    await decline(pg, DEAL, 56);
    expect(await reconfirm(pg, DEAL)).toBe(1);

    // and the #651 re-confirm-denial email fires for the NEW cycle
    const jobs = await reconfirmJobs(pg);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({
      tenantSchema: SCHEMA,
      dealId: DEAL,
      rfpApprovalRequestId: 56,
      requestedByUserId: REQUESTER,
    });
  });
});
