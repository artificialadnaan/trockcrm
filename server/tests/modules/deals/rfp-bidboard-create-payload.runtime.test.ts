import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { enqueueRfpBidBoardCreate } from "../../../src/modules/deals/rfp-enqueue.js";

/**
 * REAL-SQL (PGlite) proof that enqueueRfpBidBoardCreate builds a FULLY-POPULATED create-from-rfp payload from a
 * SPARSE `{ id }` deal. This is the fix for the voting-path override-approve bug: requestOverrideApproval passes a
 * narrow projected row (only id/rfpApprovalRequestId/name/projectNumber/dealNumber) — loadRfpPayloadDeal must
 * re-fetch every payload field (projectType, amount, address, description, estimator, owner email, round event id,
 * company/contact JOINs) authoritatively from the DB, NOT from the passed object. Before the fix, the deal's own
 * columns came from the (sparse) passed object, so the payload came out empty (projectType "9", amount null,
 * address null, ownerEmail null).
 *
 * deals + companies/contacts/leads/users/files + job_queue live in the default (public) schema so the bare
 * pgTable Drizzle mappings resolve unqualified (mirrors rfp-vote-service.runtime.test.ts).
 */
const DEAL = "00000000-0000-0000-0000-0000000000d1";
const OWNER = "00000000-0000-0000-0000-0000000000a1";
const COMPANY = "00000000-0000-0000-0000-0000000000c1";
const CONTACT = "00000000-0000-0000-0000-0000000000b1";
const LEAD = "00000000-0000-0000-0000-0000000000e1";
const EVENT = "00000000-0000-0000-0000-0000000000f1";

let pg: PGlite | null = null;
afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function setup() {
  const db = new PGlite();
  await db.exec(`
    -- The RFP service verdict reads the CONFIGURED project-type digit through this table, so a fixture
    -- exercising trigger/payload needs it present (an absent table is a 42P01, not a null code).
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
    -- deals: only the columns loadRfpPayloadDeal's SELECT d.* reads (plus JOIN keys).
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text NOT NULL, deal_number text NOT NULL, project_number text,
      project_type text, project_type_id uuid, workflow_route text NOT NULL DEFAULT 'normal',
      awarded_amount numeric, bid_estimate numeric, dd_estimate numeric, forecast_revenue numeric,
      estimator text, bid_board_estimator text,
      property_address text, property_city text, property_state text, property_zip text, property_country text,
      description text, bid_due_date timestamptz, bid_board_due_date date, bid_board_project_number text,
      -- migration 0225: the resolver requires this provenance stamp, not a coincidental day match.
      bid_due_date_from_bid_board_at timestamptz, bid_due_date_bid_board_project_number text,
      -- migration 0200: the resolver refuses the Bid Board override on a severed deal.
      bid_board_detached_at timestamptz, created_at timestamptz DEFAULT now(),
      rfp_approval_request_event_id uuid, rfp_approval_request_id integer,
      assigned_rep_id uuid, hubspot_owner_email text, created_by_user_id uuid,
      company_id uuid, primary_contact_id uuid, source_lead_id uuid
    );
    CREATE TABLE files (
      id uuid PRIMARY KEY, deal_id uuid, lead_id uuid, is_active boolean NOT NULL DEFAULT true,
      parent_file_id uuid, display_name text, file_extension text, mime_type text, r2_key text, category text,
      file_size_bytes bigint,
      -- Attachments are ordered newest-first so the RFP body-size cap, which drops from the tail,
      -- keeps the most recent documents (TRK-2607-H3X6).
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name) VALUES ($1, 'rep@trockgc.com', 'Rep One', 'Rep', 'One')`,
    [OWNER],
  );
  await db.query(`INSERT INTO companies (id, name) VALUES ($1, 'Acme Roofing Co')`, [COMPANY]);
  await db.query(
    `INSERT INTO contacts (id, first_name, last_name, email, phone) VALUES ($1, 'Pat', 'Client', 'pat@client.com', '555-1212')`,
    [CONTACT],
  );
  await db.query(`INSERT INTO leads (id, bid_due_date) VALUES ($1, '2026-09-15T00:00:00Z')`, [LEAD]);
  await db.query(
    `INSERT INTO deals (
       id, name, deal_number, project_number, bid_board_project_number, project_type, workflow_route,
       awarded_amount, description, estimator,
       property_address, property_city, property_state, property_zip, property_country,
       bid_due_date, rfp_approval_request_event_id, rfp_approval_request_id,
       assigned_rep_id, company_id, primary_contact_id, source_lead_id
     ) VALUES (
       $1, 'Jason Ranches', 'TR-2001', 'TR-2001', 'TR-2001', 'roofing', 'normal',
       '125000.00', 'Full roof replacement', 'Colby',
       '100 Main St', 'Dallas', 'TX', '75001', 'US',
       '2026-08-01T00:00:00Z', $2, NULL,
       $3, $4, $5, $6
     )`,
    [DEAL, EVENT, OWNER, COMPANY, CONTACT, LEAD],
  );
  return db;
}

describe("enqueueRfpBidBoardCreate — DB-authoritative payload from a sparse { id } deal", () => {
  it("populates every payload field from the DB (projectType, amount, address, owner, company/contact) — not defaults", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);

    // The override-approve voting path passes ONLY the id — the create must still resolve the full deal.
    await enqueueRfpBidBoardCreate({ tenantDb: tdb, officeId: null, deal: { id: DEAL } });

    const jobs = (await pg.query(`SELECT job_type, payload FROM public.job_queue`)).rows as any[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].job_type).toBe("rfp_bidboard_create");

    const body = jobs[0].payload.body;
    expect(body.decision).toBe("approved");
    // Round-precise sourceEventId comes from the DB row's event id (not the passed object, which had none).
    expect(body.sourceEventId).toBe(`crm:rfp-vote:approved:${EVENT}`);

    const deal = body.deal;
    // Deal's OWN columns — the ones the bug dropped when the passed row was sparse:
    expect(deal.projectType).toBe("3"); // roofing -> code 3, NOT the "9" default
    expect(deal.amount).toBe(125000); // awarded_amount, NOT null
    expect(deal.description).toBe("Full roof replacement");
    expect(deal.estimator).toBe("Colby");
    expect(deal.address).toEqual({ street: "100 Main St", city: "Dallas", state: "TX", zip: "75001", country: "US" });
    // The deal's OWN bid_due_date (2026-08-01), NOT the source lead's (2026-09-15) — with
    // BID_BOARD_DUE_DATE_READBACK off, which is the default this test runs under.
    //
    // ⚠️ This is DELIBERATE PARITY, not a stale expectation. The RFP payload's deal-column-first ordering
    // is backwards relative to the other two read sites (the lead owns the field), and the flag-ON branch
    // corrects it — see the describe block at the bottom of this file. The correction is gated because
    // this value leaves the CRM for SyncHub and is typed into the Procore Bid Board project's Due Date, so
    // it must not change before the census has been read. Do not "fix" this line to 2026-09-15.
    expect(deal.dueDate).toContain("2026-08-01");
    expect(deal.name).toBe("Jason Ranches");
    expect(deal.projectNumber).toBe("TR-2001");
    // Resolved owner (assigned rep -> users) — NOT null:
    expect(deal.ownerEmail).toBe("rep@trockgc.com");
    expect(deal.ownerName).toBe("Rep One");
    // JOIN-sourced fields:
    expect(deal.companyName).toBe("Acme Roofing Co");
    expect(deal.contactName).toBe("Pat Client");
    expect(deal.clientEmail).toBe("pat@client.com");
    expect(deal.clientPhone).toBe("555-1212");
  });

  it("[Z8] uses the well-formed 'not found' shell (not DB data) when the deal id doesn't exist", async () => {
    pg = await setup();
    const tdb: any = drizzle(pg as any);
    const MISSING = "00000000-0000-0000-0000-0000deadbeef";

    await enqueueRfpBidBoardCreate({ tenantDb: tdb, officeId: null, deal: { id: MISSING } });

    const jobs = (await pg.query(`SELECT payload FROM public.job_queue`)).rows as any[];
    expect(jobs).toHaveLength(1);
    const body = jobs[0].payload.body;
    expect(body.decision).toBe("approved");
    // No round event id on the shell -> sourceEventId falls back to the deal id, never throws.
    expect(body.sourceEventId).toBe(`crm:rfp-vote:approved:${MISSING}`);
    expect(body.sourceDealId).toBe(MISSING);
    // Empty-shell deal fields (no DB row): the builder normalizes the blank name to its "Untitled Deal" default
    // (a real deal would carry its own name), and there's no resolved owner/company/contact.
    expect(body.deal.name).toBe("Untitled Deal");
    expect(body.deal.ownerEmail ?? null).toBeNull();
    expect(body.deal.companyName ?? null).toBeNull();
  });

  /**
   * The RFP payload is the THIRD read site of the shared bid-due-date resolver, alongside the deal-detail
   * banner and getResolvedDeal — and the ONLY one whose flag-OFF branch is not the shared precedence.
   *
   * The fixture is lead-backed with a deal column of 2026-08-01 and a lead of 2026-09-15, so every case
   * identifies exactly which source won. `mirror` sets deals.bid_board_due_date; `landed` additionally
   * rewrites the deal column to that day, modelling the state AFTER the write-through has run — the only
   * state in which the Bid Board override fires at all (the mirror is a signal, never a value).
   */
  describe("Bid Board due-date read-back in the payload", () => {
    async function dueDateFor(options: {
      env?: string;
      mirror?: string;
      landed?: string;
      detached?: boolean;
      /** Stamp the provenance against a DIFFERENT project than the deal is on (the re-link shape). */
      stampedProject?: string;
    }): Promise<string> {
      pg = await setup();
      const boardDay = options.landed ?? options.mirror;
      if (boardDay) {
        await pg!.query(`UPDATE deals SET bid_board_due_date = $2 WHERE id = $1`, [DEAL, boardDay]);
      }
      if (options.landed) {
        // Both halves of the signal, exactly as writeBidDueDateIfNeeded writes them: the value AND the
        // provenance stamp. Setting only the value would model the COINCIDENCE case, not a landed write.
        await pg!.query(
          `UPDATE deals
              SET bid_due_date = $2::timestamptz,
                  bid_due_date_from_bid_board_at = now(),
                  bid_due_date_bid_board_project_number = COALESCE($3, bid_board_project_number)
            WHERE id = $1`,
          [DEAL, `${options.landed}T00:00:00.000Z`, options.stampedProject ?? null]
        );
      }
      if (options.detached) {
        await pg!.query(`UPDATE deals SET bid_board_detached_at = now() WHERE id = $1`, [DEAL]);
      }
      const tdb: any = drizzle(pg as any);
      if (options.env === undefined) delete process.env.BID_BOARD_DUE_DATE_READBACK;
      else process.env.BID_BOARD_DUE_DATE_READBACK = options.env;
      try {
        await enqueueRfpBidBoardCreate({ tenantDb: tdb, officeId: null, deal: { id: DEAL } });
      } finally {
        delete process.env.BID_BOARD_DUE_DATE_READBACK;
      }
      const jobs = (await pg!.query(`SELECT payload FROM public.job_queue`)).rows as any[];
      return jobs[0].payload.body.deal.dueDate;
    }

    it("flag OFF: the DEAL column wins over the lead — the legacy ordering, unchanged", async () => {
      expect(await dueDateFor({})).toContain("2026-08-01");
    });

    it("flag OFF: a LANDED Bid Board date is ignored and the legacy ordering still holds", async () => {
      // Both gated legs at once, on the fixture where the flag would otherwise change the answer.
      expect(await dueDateFor({ landed: "2026-12-24" })).toContain("2026-12-24");
      // (the landed column IS 2026-12-24, so the legacy deal-column-first rule returns it too — the
      // meaningful flag-off assertion is the lead-masking one below)
      expect(await dueDateFor({ mirror: "2026-12-24" })).toContain("2026-08-01");
    });

    it("flag ON: the precedence CORRECTION lands — the lead beats an un-landed deal column", async () => {
      expect(await dueDateFor({ env: "true" })).toContain("2026-09-15");
      expect(await dueDateFor({ env: "true", mirror: "2026-12-24" })).toContain("2026-09-15");
    });

    it("flag ON: once the board's date has LANDED in the column, that column beats the lead", async () => {
      expect(await dueDateFor({ env: "true", landed: "2026-12-24" })).toContain("2026-12-24");
    });

    it("flag ON: a stamp earned on a RETIRED project refuses the override", async () => {
      // Detached and re-linked elsewhere: dates and stamp preserved, but the stamp names a project this
      // deal is no longer on. Falls back to the corrected legacy chain (lead-first).
      expect(
        await dueDateFor({ env: "true", landed: "2026-12-24", stampedProject: "TR-RETIRED" })
      ).toContain("2026-09-15");
    });

    it("flag ON: a DETACHED deal refuses the override even with a landed column", async () => {
      // Falls back to the corrected legacy chain (lead-first), never to the board's date.
      expect(await dueDateFor({ env: "true", landed: "2026-12-24", detached: true })).toContain("2026-09-15");
    });

    // ★ THE LEAK. buildNormalizedRfpRequestBody computes
    // `dueDate: cleanIso(bidDueDate) ?? cleanIso(bidBoardDueDate)`. With a CLEARED lead and an UNLANDED
    // mirror the resolver returns null — the deal deliberately has no bid due date — and if the payload
    // still carried the mirror, that fallback would send the board's REJECTED date to SyncHub, which types
    // it into the Procore Bid Board project's Due Date field. The end of the chain is what this asserts:
    // the job payload itself, not the resolver's return value.
    it("flag ON: a rejected mirror does NOT reappear through the payload's dueDate fallback", async () => {
      pg = await setup();
      await pg!.query(
        `UPDATE deals SET bid_board_due_date = '2026-12-24' WHERE id = $1`,
        [DEAL]
      );
      // Clear the lead's value — the deal is lead-backed, so the lead owns the field and its clear wins.
      await pg!.query(`UPDATE leads SET bid_due_date = NULL WHERE id = $1`, [LEAD]);
      const tdb: any = drizzle(pg as any);
      process.env.BID_BOARD_DUE_DATE_READBACK = "true";
      try {
        await enqueueRfpBidBoardCreate({ tenantDb: tdb, officeId: null, deal: { id: DEAL } });
      } finally {
        delete process.env.BID_BOARD_DUE_DATE_READBACK;
      }

      const jobs = (await pg!.query(`SELECT payload FROM public.job_queue`)).rows as any[];
      const deal = jobs[0].payload.body.deal;
      expect(deal.dueDate).toBeNull();
      // The value that must never have travelled.
      expect(JSON.stringify(deal)).not.toContain("2026-12-24");
    });

    it("flag OFF: the SAME fixture keeps the legacy mirror fallback, byte-for-byte", async () => {
      // Parity in the other direction: on main, a null deal column and a null lead DO fall through to the
      // mirror. Flag-off must keep doing that, or this PR would be changing outbound RFP bodies while
      // switched off.
      pg = await setup();
      await pg!.query(`UPDATE deals SET bid_board_due_date = '2026-12-24', bid_due_date = NULL WHERE id = $1`, [DEAL]);
      await pg!.query(`UPDATE leads SET bid_due_date = NULL WHERE id = $1`, [LEAD]);
      const tdb: any = drizzle(pg as any);
      delete process.env.BID_BOARD_DUE_DATE_READBACK;

      await enqueueRfpBidBoardCreate({ tenantDb: tdb, officeId: null, deal: { id: DEAL } });

      const jobs = (await pg!.query(`SELECT payload FROM public.job_queue`)).rows as any[];
      expect(jobs[0].payload.body.deal.dueDate).toContain("2026-12-24");
    });
  });
});
