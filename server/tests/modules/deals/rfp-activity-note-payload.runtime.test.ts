import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// Lets one test force a throw from the (pure) formatter, which is the ONLY thing that runs after the
// savepoint is released — the seam where a stale `savepointHeld` would issue `ROLLBACK TO` a savepoint
// that no longer exists and poison the tenant transaction. importActual keeps every other test real.
const ctl = vi.hoisted(() => ({ formatterThrows: false }));
vi.mock("../../../src/modules/deals/bid-board-activity-note.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/modules/deals/bid-board-activity-note.js")>();
  return {
    ...actual,
    formatBidBoardActivityNote: (input: Parameters<typeof actual.formatBidBoardActivityNote>[0]) => {
      if (ctl.formatterThrows) throw new Error("formatter blew up after RELEASE SAVEPOINT");
      return actual.formatBidBoardActivityNote(input);
    },
  };
});

import {
  enqueueRfpBidBoardCreate,
  enqueueRfpVoteInvitation,
  insertOpportunityRfpRequestJob,
} from "../../../src/modules/deals/rfp-enqueue.js";
// Through the partial mock above, which spreads the real module — these are the genuine constants.
import {
  ACTIVITY_BODY_SQL_CHAR_LIMIT,
  MAX_BODY_CHARS,
} from "../../../src/modules/deals/bid-board-activity-note.js";

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
const LEAD_DEAL = "00000000-0000-0000-0000-0000000000d3";
const REP = "00000000-0000-0000-0000-0000000000a1";
const ESTIMATOR = "00000000-0000-0000-0000-0000000000a2";
const EVENT = "00000000-0000-0000-0000-0000000000f1";
const LEAD = "00000000-0000-0000-0000-0000000000e1";

let pg: PGlite | null = null;
beforeEach(() => {
  // loadCrmActivityLog warns when it cannot take a savepoint, which is expected for the tests that run
  // outside a transaction. Silenced so the suite output stays readable; asserted where it matters.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await pg?.close();
  pg = null;
  ctl.formatterThrows = false;
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
      id uuid PRIMARY KEY, type text NOT NULL, deal_id uuid, lead_id uuid, email_id uuid,
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

  await db.query(`INSERT INTO leads (id, bid_due_date) VALUES ($1, NULL)`, [LEAD]);

  for (const [id, number, sourceLead] of [
    [DEAL, "TR-2001", null],
    [EMPTY_DEAL, "TR-2002", null],
    // A lead-converted deal. Nothing re-points activities.deal_id at conversion, so its prospecting
    // history is still lead-scoped — exactly the case the note used to drop on the floor.
    [LEAD_DEAL, "TR-2003", LEAD],
  ] as const) {
    await db.query(
      `INSERT INTO deals (id, name, deal_number, project_number, project_type, workflow_route,
                          awarded_amount, description, rfp_approval_request_event_id, assigned_rep_id,
                          source_lead_id)
       VALUES ($1, 'Jason Ranches', $2, $2, 'roofing', 'normal', '125000.00', 'Full roof replacement', $3, $4, $5)`,
      [id, number, EVENT, REP, sourceLead],
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
      dealId?: string | null;
      leadId?: string | null;
      emailId?: string | null;
    } = {},
  ) =>
    db.query(
      `INSERT INTO activities (id, type, deal_id, lead_id, email_id, responsible_user_id, performed_by_user_id,
                               subject, body, outcome, duration_minutes, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        type,
        extra.dealId === undefined ? DEAL : extra.dealId,
        extra.leadId ?? null,
        extra.emailId ?? null,
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

  // PRIVACY fixture. In the CRM this row is visible only to its mailbox owner, and the body is real
  // message text (email/service.ts stores up to 1000 chars of it). A Procore note has no viewer.
  await activity(
    "00000000-0000-0000-0000-00000000ac04",
    "email",
    "2026-08-15T16:00:00Z",
    "CONFIDENTIAL-EMAIL-BODY: our walk-away number on this is 89k, do not share.",
    { actor: REP, subject: "Re: pricing" },
  );

  // The type check alone is one careless caller away from leaking: the generic createActivity takes an
  // arbitrary emailId with ANY type, so a 'note' row can carry a message body. Belt-and-braces fixture.
  await activity(
    "00000000-0000-0000-0000-00000000ac08",
    "note",
    "2026-08-16T16:00:00Z",
    "CONFIDENTIAL-MISTYPED-EMAIL: forwarded thread pasted into a note",
    { actor: REP, emailId: "00000000-0000-0000-0000-0000000000ee" },
  );

  // Pre-conversion prospecting on the SOURCE LEAD, with no deal_id at all.
  await activity(
    "00000000-0000-0000-0000-00000000ac05",
    "call",
    "2026-07-02T16:00:00Z",
    "Cold call to the property manager; asked us to bid.",
    { dealId: null, leadId: LEAD, actor: REP },
  );
  // …and an email on the lead, which must be excluded on that path too.
  await activity(
    "00000000-0000-0000-0000-00000000ac06",
    "email",
    "2026-07-03T16:00:00Z",
    "CONFIDENTIAL-LEAD-EMAIL: internal thread",
    { dealId: null, leadId: LEAD, actor: REP },
  );
  // A deal-scoped entry on the lead-backed deal, so the note proves it MERGES both sources.
  await activity(
    "00000000-0000-0000-0000-00000000ac07",
    "site_visit",
    "2026-07-20T16:00:00Z",
    "Measured the north elevation.",
    { dealId: LEAD_DEAL, actor: ESTIMATOR },
  );
  // A lead-scoped entry NEWER than that deal-scoped one. Without this the two visible rows were deal
  // Jul 20 then lead Jul 2, an order a deal-first CONCATENATION reproduces exactly — so the "merged"
  // assertion proved nothing. This forces a genuine interleave: lead, deal, lead.
  await activity(
    "00000000-0000-0000-0000-00000000ac09",
    "note",
    "2026-07-25T16:00:00Z",
    "Lead follow-up after the walkthrough.",
    { dealId: null, leadId: LEAD, actor: REP },
  );

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

  it("NEVER exports email activities — they are mailbox-owner-only in the CRM", async () => {
    // The strongest assertion in this file. `activities` of type email carry up to 1000 characters of
    // real message body, and the CRM shows them only to the responsible user. A Procore Bid Board note
    // has no viewer — every Bid Board user in the company can read it — so the per-viewer rule cannot
    // be honoured and the type has to be dropped outright. If this test fails, private mail is being
    // published to an external system.
    pg = await setup();
    const tdb: any = drizzle(pg as any);

    await enqueueRfpBidBoardCreate({ tenantDb: tdb, officeId: null, deal: { id: DEAL } });

    const jobs = (await pg.query(`SELECT payload FROM public.job_queue`)).rows as any[];
    const serialized = JSON.stringify(jobs[0].payload);

    expect(serialized).not.toContain("CONFIDENTIAL-EMAIL-BODY");
    expect(serialized).not.toContain("Re: pricing");
    expect(serialized).not.toContain("· Email ·");
    // Belt and braces: a row that is NOT typed 'email' but carries an email_id is dropped too. The
    // generic createActivity accepts that combination, so the type check alone is one careless caller
    // away from publishing a message body.
    expect(serialized).not.toContain("CONFIDENTIAL-MISTYPED-EMAIL");
    // Both are the NEWEST activities on this deal, so a missing filter would have put them first.
    expect(activityLogFor(jobs[0])).toContain("Owner confirmed scope");
  });

  it("pulls in NO lead activity for a deal with a null source_lead_id", async () => {
    // The subquery yields NULL for a non-converted deal, so `a.lead_id = NULL` is null, i.e. false.
    // Nothing pinned that before, and a coalesce-to-something mistake here would cross-link deals.
    pg = await setup();
    const tdb: any = drizzle(pg as any);

    await enqueueRfpBidBoardCreate({ tenantDb: tdb, officeId: null, deal: { id: DEAL } });

    const jobs = (await pg.query(`SELECT payload FROM public.job_queue`)).rows as any[];
    const note = activityLogFor(jobs[0])!;
    expect(note).not.toContain("Cold call to the property manager");
    expect(note).not.toContain("Lead follow-up after the walkthrough");
    expect(note).toContain("Owner confirmed scope"); // its own rows are still there
  });

  it("includes the SOURCE LEAD's activities, like the CRM's own deal Activity tab", async () => {
    // Nothing re-points activities.deal_id at conversion, so a lead-converted deal's pre-conversion
    // prospecting stays lead-scoped — and that is exactly the history the estimator is asking for.
    // getActivities ORs in lead_id for the same reason, as does loadRfpAttachmentsForDeal for files.
    pg = await setup();
    const tdb: any = drizzle(pg as any);

    await enqueueRfpBidBoardCreate({ tenantDb: tdb, officeId: null, deal: { id: LEAD_DEAL } });

    const jobs = (await pg.query(`SELECT payload FROM public.job_queue`)).rows as any[];
    const note = activityLogFor(jobs[0])!;

    expect(note).toContain("Cold call to the property manager");   // lead-scoped, oldest
    expect(note).toContain("Measured the north elevation.");        // deal-scoped, middle
    expect(note).toContain("Lead follow-up after the walkthrough."); // lead-scoped, NEWEST
    // Merged into ONE newest-first sequence, not concatenated per source. The lead row is newer than
    // the deal row, so a deal-first concatenation produces a DIFFERENT order and fails here — which the
    // earlier version of this assertion could not detect.
    expect(note.indexOf("Lead follow-up after the walkthrough")).toBeLessThan(
      note.indexOf("Measured the north elevation"),
    );
    expect(note.indexOf("Measured the north elevation")).toBeLessThan(
      note.indexOf("Cold call to the property manager"),
    );
    // The exclusion applies on the lead path too.
    expect(JSON.stringify(jobs[0].payload)).not.toContain("CONFIDENTIAL-LEAD-EMAIL");
    // And a deal with no source lead must not pick up this lead's rows.
    expect(note).not.toContain("Owner confirmed scope");
  });

  describe("the SQL transfer bound cannot change what renders", () => {
    // `LEFT(body, N)` exists so an unbounded `text` body cannot make this query drag megabytes into
    // the caller's tenant transaction. It is defence in depth for the TRANSFER — if it ever alters a
    // rendered note, it has become a silent truncation bug instead.
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const EMOJI = "🚧";

    async function noteForBody(body: string): Promise<string> {
      pg = await setup();
      const tdb: any = drizzle(pg as any);
      await pg!.query(`DELETE FROM activities`);
      await pg!.query(
        `INSERT INTO activities (id, type, deal_id, responsible_user_id, body, occurred_at)
         VALUES ('00000000-0000-0000-0000-00000000ac10', 'note', $1, $2, $3, '2026-08-14T16:00:00Z')`,
        [DEAL, REP, body],
      );
      await enqueueRfpBidBoardCreate({ tenantDb: tdb, officeId: null, deal: { id: DEAL } });
      const jobs = (await pg!.query(`SELECT payload FROM public.job_queue`)).rows as any[];
      return activityLogFor(jobs[0])!;
    }

    it("renders a body at exactly MAX_BODY_CHARS in full, with no … marker", async () => {
      // The boundary the bound must not disturb. An off-by-one in the SQL limit shows up HERE first.
      const body = "B".repeat(MAX_BODY_CHARS);
      const note = await noteForBody(body);

      expect(note).toContain(`  ${body}`);
      expect(note).not.toContain("…\n");
      expect(note.endsWith("…")).toBe(false);
    });

    it("clamps a body one character over the limit, marker and all", async () => {
      // The other side of the same boundary: a SQL bound of exactly MAX_BODY_CHARS would deliver this
      // as 400 chars and render it as if complete — losing a character AND the … that says so.
      const note = await noteForBody("B".repeat(MAX_BODY_CHARS + 1));

      expect(note).toContain(`  ${"B".repeat(MAX_BODY_CHARS - 1)}…`);
      expect(note).not.toContain("B".repeat(MAX_BODY_CHARS));
    });

    it("renders a body far beyond the SQL bound exactly as a one-over body does", async () => {
      // Everything past the formatter's cut is unobservable, so a 50k body and a 401-char body must
      // produce byte-identical output. This is what proves the SQL bound is invisible.
      const huge = await noteForBody("B".repeat(50_000));
      const justOver = await noteForBody("B".repeat(MAX_BODY_CHARS + 1));

      expect(huge).toBe(justOver);
      expect(huge).toContain(`  ${"B".repeat(MAX_BODY_CHARS - 1)}…`);
    });

    it("survives an emoji straddling the SQL bound, where the two clamps compose", async () => {
      // Postgres LEFT() counts CHARACTERS and JS .length counts UTF-16 code UNITS, so the two clamps
      // measure differently. That mismatch is exactly where this class of bug hides, even though
      // LEFT() cannot itself split a pair.
      for (const offset of [-2, -1, 0, 1]) {
        const index = ACTIVITY_BODY_SQL_CHAR_LIMIT + offset;
        const note = await noteForBody("x".repeat(index) + EMOJI + "tail".repeat(500));

        expect(LONE_SURROGATE.test(note), `emoji at SQL-bound offset ${offset}`).toBe(false);
        expect(() => JSON.parse(JSON.stringify({ crmActivityLog: note }))).not.toThrow();
      }
    });

    it.each([
      ["newlines", "\n"],
      ["spaces", " "],
      ["tabs", "\t"],
      ["carriage returns", "\r"],
      ["form feeds", "\f"],
      ["vertical tabs", "\v"],
      ["non-breaking spaces", "\u00A0"],
    ])("renders content behind a long run of leading %s", async (_label, ws) => {
      // The regression the bound introduced. Bodies are stored verbatim by POST /api/activities, so a
      // body opening with more whitespace than the transfer bound came back as pure whitespace,
      // cleanText turned it into null, and the entry rendered with NO BODY. Trimming inside the bound
      // is what makes the transferred characters characters of content.
      //
      // Newlines are the case that matters most in practice and the one BTRIM's default set does NOT
      // cover — its default is a space only.
      const text = "Owner confirmed scope; wants alternates priced.";
      const note = await noteForBody(ws.repeat(ACTIVITY_BODY_SQL_CHAR_LIMIT + 100) + text);

      expect(note).toContain(`  ${text}`);
    });

    it("renders a whitespace-led body byte-identically to the same body without it", async () => {
      // The strongest form: leading whitespace must be entirely invisible in the output, not merely
      // survivable. cleanText trimmed the full body before the bound existed, so this is what pins
      // that behaviour as unchanged.
      const text = "Roof access via north stair only. " + "detail ".repeat(80);
      const led = await noteForBody("\n".repeat(ACTIVITY_BODY_SQL_CHAR_LIMIT + 100) + text);
      const plain = await noteForBody(text);

      expect(led).toBe(plain);
    });

    it("still renders nothing for a body that is only whitespace", async () => {
      // The trim must not invent content either: whitespace-only really is an empty body.
      const note = await noteForBody(" ".repeat(ACTIVITY_BODY_SQL_CHAR_LIMIT + 100));
      expect(note).toContain("Aug 14, 2026 · Note");
      expect(note.split("\n").filter((l) => l.startsWith("  "))).toHaveLength(0);
    });

    it("does not eat leading letters that appear in the trim-set escapes", async () => {
      // An unrecognised Postgres E'' escape is taken LITERALLY, so a set written with \v would have
      // put the letter "v" in it and truncated this body's first character.
      for (const text of ["very urgent — call back", "ux walkthrough booked", "0Bad access notes"]) {
        const note = await noteForBody(text);
        expect(note).toContain(`  ${text}`);
      }
    });

    it("survives an all-emoji body, where characters and code units diverge throughout", async () => {
      // 400 emojis = 400 characters but 800 code units: under the SQL bound, over the formatter's.
      // The formatter's cut at 399 units lands mid-pair, so the surrogate guard has to fire on data
      // that came back through the SQL clamp.
      const note = await noteForBody(EMOJI.repeat(MAX_BODY_CHARS));

      expect(LONE_SURROGATE.test(note)).toBe(false);
      expect(() => JSON.parse(JSON.stringify({ crmActivityLog: note }))).not.toThrow();
      expect(note).toContain("…");
    });
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

  it("does not poison the transaction when the formatter throws AFTER the savepoint is released", async () => {
    // Once RELEASE has run the savepoint no longer exists, so a later throw must NOT route into
    // `ROLLBACK TO` it: that raises "savepoint does not exist", aborts the tenant transaction, and
    // kills the job_queue INSERT — the precise failure the savepoint exists to prevent, inverted.
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    ctl.formatterThrows = true;

    await pg.exec("BEGIN");
    await enqueueRfpBidBoardCreate({ tenantDb: tdb, officeId: null, deal: { id: DEAL } });
    await pg.exec("COMMIT");

    const jobs = (await pg.query(`SELECT payload FROM public.job_queue`)).rows as any[];
    expect(jobs).toHaveLength(1); // the RFP survived a post-release throw
    expect(activityLogFor(jobs[0])).toBeNull();
    expect(logged).toHaveBeenCalled();
    // The rest of the payload is intact, i.e. the transaction was never aborted.
    expect(jobs[0].payload.body.deal.amount).toBe(125000);
  });

  it("never reaches the voter invitation EMAIL, which still gets its dealSummary", async () => {
    // enqueueRfpVoteInvitation copies a FIXED field list into dealSummary. That is deliberate and must
    // stay true: an 8 KB activity dump in the invitation would bury the decision the voter is there to
    // make. This test is the guard against someone "helpfully" spreading the payload deal in.
    //
    // It runs inside BEGIN/COMMIT on purpose. Without one, enqueueRfpVoteInvitation's own SAVEPOINT
    // throws, dealSummary comes out null, and a "does not contain crmActivityLog" assertion passes
    // because there is no summary AT ALL — it would still pass if someone spread the whole payload
    // deal in. Asserting a POPULATED summary is what makes the exclusion meaningful.
    pg = await setup();
    const tdb: any = drizzle(pg as any);

    await pg.exec("BEGIN");
    await enqueueRfpVoteInvitation({
      tenantDb: tdb,
      officeId: null,
      deal: { id: DEAL, dealNumber: "TR-2001", name: "Jason Ranches", rfpApprovalRequestEventId: EVENT },
      recipients: ["voter@trockgc.com"],
    });
    await pg.exec("COMMIT");

    const jobs = (await pg.query(`SELECT job_type, payload FROM public.job_queue`)).rows as any[];
    expect(jobs[0].job_type).toBe("rfp_vote_invitation");

    const summary = jobs[0].payload.dealSummary;
    expect(summary).not.toBeNull();
    expect(summary.projectNumber).toBe("TR-2001");
    expect(summary.amount).toBe(125000);
    expect(summary.description).toBe("Full roof replacement");

    // Now the exclusion means something: a fully-populated summary that still carries no activity log.
    expect(summary).not.toHaveProperty("crmActivityLog");
    expect(JSON.stringify(jobs[0].payload)).not.toContain("crmActivityLog");
    expect(JSON.stringify(jobs[0].payload)).not.toContain("CRM Activity Log");
    // And nothing from the deal's activity history leaked in by any other route.
    expect(JSON.stringify(jobs[0].payload)).not.toContain("Owner confirmed scope");
  });

  it("does not even QUERY activities for the vote invitation", async () => {
    // The invitation shares loadRfpPayloadDeal purely for dealSummary's fixed field list. Rendering a
    // note for it would mean fetching up to 200 rows with unbounded bodies and building an 8 KB string
    // inside the tenant transaction — on a pooled client, under a statement_timeout — to then discard
    // it.
    //
    // Dropping the table is NOT sufficient on its own: if the opt-out were ignored, loadCrmActivityLog
    // would take its nested savepoint, fail the SELECT, ROLLBACK TO, recover the transaction and return
    // null — and "dealSummary is populated" would STILL hold (the sibling test above demonstrates
    // exactly that degradation). The discriminator is that nothing was logged, because nothing failed,
    // because nothing ran.
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    const errored = vi.spyOn(console, "error").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await pg.exec("DROP TABLE activities");

    await pg.exec("BEGIN");
    await enqueueRfpVoteInvitation({
      tenantDb: tdb,
      officeId: null,
      deal: { id: DEAL, dealNumber: "TR-2001", name: "Jason Ranches", rfpApprovalRequestEventId: EVENT },
      recipients: ["voter@trockgc.com"],
    });
    await pg.exec("COMMIT");

    // No failed activity SELECT, and no savepoint taken for one.
    expect(errored).not.toHaveBeenCalled();
    expect(
      warned.mock.calls.some((call) => String(call[0]).includes("CRM activity note"))
    ).toBe(false);

    const jobs = (await pg.query(`SELECT payload FROM public.job_queue`)).rows as any[];
    expect(jobs[0].payload.dealSummary).not.toBeNull();
    expect(jobs[0].payload.dealSummary.projectNumber).toBe("TR-2001");
  });
});
