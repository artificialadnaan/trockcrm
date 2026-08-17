import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  enqueueRfpBidBoardCreate,
  enqueueRfpVoteInvitation,
  insertOpportunityRfpRequestJob,
} from "../../../src/modules/deals/rfp-enqueue.js";

/**
 * REAL-SQL (PGlite) proof that a deal's CRM activity history reaches the enqueued RFP payload.
 *
 * The estimator who opens a CRM-created Bid Board project in Procore sees none of the sales history —
 * every call, site visit and note the rep logged stays in the CRM. loadRfpPayloadDeal renders it into
 * `deal.crmActivityLog`, which SyncHub posts as a NOTE on the project's Overview tab.
 *
 * This is deliberately tested against a real engine rather than a string mock: the load joins
 * `activities` to `users` through a COALESCE over two actor columns, orders by occurred_at DESC, and
 * runs inside a SAVEPOINT — none of which a captured-SQL assertion would actually exercise.
 *
 * Table layout mirrors rfp-bidboard-create-payload.runtime.test.ts: everything lives in the default
 * (public) schema so the bare pgTable Drizzle mappings resolve unqualified.
 */
const DEAL = "00000000-0000-0000-0000-0000000000d1";
const EMPTY_DEAL = "00000000-0000-0000-0000-0000000000d2";
const REP = "00000000-0000-0000-0000-0000000000a1";
const ESTIMATOR = "00000000-0000-0000-0000-0000000000a2";
const EVENT = "00000000-0000-0000-0000-0000000000f1";

let pg: PGlite | null = null;
afterEach(async () => {
  await pg?.close();
  pg = null;
  vi.restoreAllMocks();
});

async function setup() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS public.project_type_config (id uuid PRIMARY KEY, name text NOT NULL, code text);
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type text NOT NULL, payload jsonb NOT NULL, office_id uuid,
      status text NOT NULL, attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3,
      last_error text, started_processing_at timestamptz,
      run_after timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    CREATE TABLE users (
      id uuid PRIMARY KEY, email text, display_name text, first_name text, last_name text
    );
    CREATE TABLE companies (id uuid PRIMARY KEY, name text);
    CREATE TABLE contacts (id uuid PRIMARY KEY, first_name text, last_name text, email text, phone text);
    CREATE TABLE leads (id uuid PRIMARY KEY, bid_due_date timestamptz);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text NOT NULL, deal_number text NOT NULL, project_number text,
      project_type text, project_type_id uuid, workflow_route text NOT NULL DEFAULT 'normal',
      awarded_amount numeric, bid_estimate numeric, dd_estimate numeric, forecast_revenue numeric,
      estimator text, bid_board_estimator text,
      property_address text, property_city text, property_state text, property_zip text, property_country text,
      description text, bid_due_date timestamptz, bid_board_due_date date, created_at timestamptz DEFAULT now(),
      rfp_approval_request_event_id uuid, rfp_approval_request_id integer,
      assigned_rep_id uuid, hubspot_owner_email text, created_by_user_id uuid,
      company_id uuid, primary_contact_id uuid, source_lead_id uuid
    );
    CREATE TABLE files (
      id uuid PRIMARY KEY, deal_id uuid, lead_id uuid, is_active boolean NOT NULL DEFAULT true,
      parent_file_id uuid, display_name text, file_extension text, mime_type text, r2_key text, category text,
      file_size_bytes bigint, created_at timestamptz NOT NULL DEFAULT now()
    );
    -- Only the columns loadDealActivityNoteEntries reads. responsible_user_id is NOT NULL in the real
    -- tenant schema, and performed_by_user_id is the optional override — the actor COALESCEs the two.
    CREATE TABLE activities (
      id uuid PRIMARY KEY, type text NOT NULL, deal_id uuid,
      responsible_user_id uuid NOT NULL, performed_by_user_id uuid,
      subject text, body text, outcome text, duration_minutes integer,
      occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await db.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name)
     VALUES ($1, 'jane@trockgc.com', 'Jane Rep', 'Jane', 'Rep')`,
    [REP],
  );
  // display_name deliberately NULL: exercises the first+last fallback that mirrors resolveDealOwner.
  await db.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name)
     VALUES ($1, 'bob@trockgc.com', NULL, 'Bob', 'Estimator')`,
    [ESTIMATOR],
  );

  for (const [id, number] of [
    [DEAL, "TR-2001"],
    [EMPTY_DEAL, "TR-2002"],
  ] as const) {
    await db.query(
      `INSERT INTO deals (id, name, deal_number, project_number, project_type, workflow_route,
                          awarded_amount, description, rfp_approval_request_event_id, assigned_rep_id)
       VALUES ($1, 'Jason Ranches', $2, $2, 'roofing', 'normal', '125000.00', 'Full roof replacement', $3, $4)`,
      [id, number, EVENT, REP],
    );
  }

  // Inserted OUT of chronological order on purpose: the note's newest-first ordering must come from
  // the query's ORDER BY, never from insertion order.
  const activity = (
    id: string,
    type: string,
    occurredAt: string,
    body: string | null,
    extra: {
      actor?: string;
      responsible?: string;
      subject?: string | null;
      outcome?: string | null;
      duration?: number | null;
    } = {},
  ) =>
    db.query(
      `INSERT INTO activities (id, type, deal_id, responsible_user_id, performed_by_user_id,
                               subject, body, outcome, duration_minutes, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        type,
        DEAL,
        extra.responsible ?? REP,
        extra.actor ?? null,
        extra.subject ?? null,
        body,
        extra.outcome ?? null,
        extra.duration ?? null,
        occurredAt,
      ],
    );

  await activity("00000000-0000-0000-0000-00000000ac02", "site_visit", "2026-08-12T16:00:00Z", "Roof access via north stair only.", {
    actor: ESTIMATOR,
  });
  await activity("00000000-0000-0000-0000-00000000ac01", "call", "2026-08-14T16:00:00Z", "Owner confirmed scope; wants alternates priced.", {
    actor: REP,
    outcome: "connected",
    duration: 15,
  });
  await activity("00000000-0000-0000-0000-00000000ac03", "note", "2026-08-08T16:00:00Z", "Referred by the GC on the Maple job.", {
    // No performed_by_user_id: the actor must fall back to responsible_user_id.
    responsible: REP,
  });

  return db;
}

function activityLogFor(job: any): string | null {
  return job.payload.body.deal.crmActivityLog;
}

describe("RFP payload carries the CRM activity log (real SQL)", () => {
  it("renders the deal's real activities into the create-from-rfp job payload", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);

    await enqueueRfpBidBoardCreate({ tenantDb: tdb, officeId: null, deal: { id: DEAL } });

    const jobs = (await pg.query(`SELECT job_type, payload FROM public.job_queue`)).rows as any[];
    expect(jobs).toHaveLength(1);
    const note = activityLogFor(jobs[0])!;

    // Heading = SyncHub's idempotency marker, carrying the FORMATTED project number.
    expect(note.startsWith("CRM Activity Log — TR-2001 (as of ")).toBe(true);

    // Newest-first, from the query's ORDER BY — not the insertion order used in the fixture.
    expect(note.indexOf("Owner confirmed scope")).toBeLessThan(note.indexOf("Roof access"));
    expect(note.indexOf("Roof access")).toBeLessThan(note.indexOf("Referred by the GC"));

    // Actor names resolved through the users join: display_name first…
    expect(note).toContain("Aug 14, 2026 · Call (connected, 15 min) · Jane Rep");
    // …then first+last when display_name is null (mirrors resolveDealOwner).
    expect(note).toContain("Aug 12, 2026 · Site Visit · Bob Estimator");
    // …and performed_by_user_id falling back to responsible_user_id.
    expect(note).toContain("Aug 08, 2026 · Note · Jane Rep");

    expect(note).toContain("  Owner confirmed scope; wants alternates priced.");
    // The whole history fitted, so there is no trailing "older entries" line.
    expect(note).not.toContain("older entries not shown");

    // It must NOT leak into the description — Procore renders that as Project Description.
    expect(jobs[0].payload.body.deal.description).toBe("Full roof replacement");
  });

  it("enqueues crmActivityLog: null for a deal with no activity at all", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);

    await enqueueRfpBidBoardCreate({ tenantDb: tdb, officeId: null, deal: { id: EMPTY_DEAL } });

    const jobs = (await pg.query(`SELECT payload FROM public.job_queue`)).rows as any[];
    expect(activityLogFor(jobs[0])).toBeNull();
    // Explicitly null rather than an empty heading, so SyncHub posts no note at all.
    expect(jobs[0].payload.body.deal).toHaveProperty("crmActivityLog", null);
  });

  it("carries it on the LIVE email-approval path too (both create paths share the loader)", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);

    await insertOpportunityRfpRequestJob({
      tenantDb: tdb,
      deal: { id: DEAL } as any,
      officeId: null,
      eventId: "evt-live",
    });

    const jobs = (await pg.query(`SELECT job_type, payload FROM public.job_queue`)).rows as any[];
    expect(jobs[0].job_type).toBe("rfp_request_delivery");
    expect(activityLogFor(jobs[0])).toContain("Owner confirmed scope");
  });

  it("works inside a transaction, where the SAVEPOINT guard is live", async () => {
    // The prod callers all run inside an explicit tenant transaction (req.commitTransaction), so the
    // SAVEPOINT/RELEASE pair actually executes there. Prove it does not swallow the note.
    pg = await setup();
    const tdb: any = drizzle(pg as any);

    await pg.exec("BEGIN");
    await enqueueRfpBidBoardCreate({ tenantDb: tdb, officeId: null, deal: { id: DEAL } });
    await pg.exec("COMMIT");

    const jobs = (await pg.query(`SELECT payload FROM public.job_queue`)).rows as any[];
    expect(activityLogFor(jobs[0])).toContain("Owner confirmed scope");
  });

  it("still enqueues the RFP when the activity load fails mid-transaction", async () => {
    // The failure mode this guards: the load runs inside the caller's tenant transaction, so an error
    // (an older tenant schema with no `activities` table, column drift) would leave that transaction
    // ABORTED and take the job_queue insert down with it — losing the entire RFP for the sake of a
    // display extra. The SAVEPOINT bounds the damage.
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await pg.exec("DROP TABLE activities");

    await pg.exec("BEGIN");
    await enqueueRfpBidBoardCreate({ tenantDb: tdb, officeId: null, deal: { id: DEAL } });
    await pg.exec("COMMIT");

    const jobs = (await pg.query(`SELECT payload FROM public.job_queue`)).rows as any[];
    expect(jobs).toHaveLength(1); // the RFP survived
    expect(activityLogFor(jobs[0])).toBeNull(); // degraded, not thrown
    // Silent degradation is how selector/schema rot goes unnoticed, so it must be logged.
    expect(logged).toHaveBeenCalled();
  });

  it("never reaches the voter invitation EMAIL", async () => {
    // enqueueRfpVoteInvitation copies a FIXED field list into dealSummary. That is deliberate and must
    // stay true: an 8 KB activity dump in the invitation would bury the decision the voter is there to
    // make. This test is the guard against someone "helpfully" spreading the payload deal in.
    pg = await setup();
    const tdb: any = drizzle(pg as any);

    await enqueueRfpVoteInvitation({
      tenantDb: tdb,
      officeId: null,
      deal: { id: DEAL, dealNumber: "TR-2001", name: "Jason Ranches", rfpApprovalRequestEventId: EVENT },
      recipients: ["voter@trockgc.com"],
    });

    const jobs = (await pg.query(`SELECT job_type, payload FROM public.job_queue`)).rows as any[];
    expect(jobs[0].job_type).toBe("rfp_vote_invitation");
    expect(JSON.stringify(jobs[0].payload)).not.toContain("crmActivityLog");
    expect(JSON.stringify(jobs[0].payload)).not.toContain("CRM Activity Log");
  });
});
