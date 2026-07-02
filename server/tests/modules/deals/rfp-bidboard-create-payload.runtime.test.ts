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
      project_type text, workflow_route text NOT NULL DEFAULT 'normal',
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
      parent_file_id uuid, display_name text, file_extension text, mime_type text, r2_key text, category text
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
       id, name, deal_number, project_number, project_type, workflow_route,
       awarded_amount, description, estimator,
       property_address, property_city, property_state, property_zip, property_country,
       bid_due_date, rfp_approval_request_event_id, rfp_approval_request_id,
       assigned_rep_id, company_id, primary_contact_id, source_lead_id
     ) VALUES (
       $1, 'Jason Ranches', 'TR-2001', 'TR-2001', 'roofing', 'normal',
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
    expect(deal.dueDate).toContain("2026-08-01"); // deal's own bid_due_date
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
});
