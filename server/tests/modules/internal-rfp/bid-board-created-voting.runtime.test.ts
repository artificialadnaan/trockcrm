import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const holder = vi.hoisted(() => ({ pg: null as any }));

async function pgQuery(text: string, params?: any[]) {
  const r = await holder.pg.query(text, params ?? []);
  return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
}

vi.mock("../../../src/db.js", () => ({
  pool: {
    query: (text: string, params?: any[]) => pgQuery(text, params),
    connect: async () => ({ query: (t: string, p?: any[]) => pgQuery(t, p), release: () => {} }),
  },
  releasePooledClient: () => {},
  isBrokenConnectionError: () => false,
}));
vi.mock("../../../src/modules/audit/pg-activity-logger.js", () => ({ logActivityWithPgClient: vi.fn(async () => {}) }));
vi.mock("../../../src/modules/audit/audit-logger.js", () => ({ buildAuditActorFromSystem: () => ({}) }));
vi.mock("../../../src/modules/audit/system-processes.js", () => ({ INTERNAL_RFP_RECEIVER: "internal_rfp_receiver" }));

const SECRET = "shared-secret";
const DEAL = "00000000-0000-0000-0000-0000000000d1";
const REP = "00000000-0000-0000-0000-000000000001";
const OPP = "00000000-0000-0000-0000-0000000000a1";
const EST = "00000000-0000-0000-0000-0000000000a2";

function sign(body: string) {
  return `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

async function seed() {
  const db = new PGlite();
  holder.pg = db;
  await db.exec(`
    CREATE SCHEMA office_test;
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug text NOT NULL, display_order integer, is_terminal boolean NOT NULL DEFAULT false);
    INSERT INTO public.pipeline_stage_config (id, slug, display_order, is_terminal) VALUES ('${OPP}', 'opportunity', 3, false), ('${EST}', 'estimating', 5, false);
    CREATE TABLE office_test.deals (
      id uuid PRIMARY KEY, name text, deal_number text, project_number text, project_type text, bid_estimate numeric,
      estimator text, description text, bid_due_date timestamptz, property_address text, property_city text, property_state text,
      property_zip text, property_country text, stage_id uuid, company_id uuid, primary_contact_id uuid, procore_bid_id bigint,
      procore_company_id text, is_bid_board_owned boolean NOT NULL DEFAULT false, rfp_approval_status text, rfp_declined_reason text,
      rfp_declined_at timestamptz, rfp_override_state text, rfp_override_error text, rfp_override_decision text,
      rfp_override_reviewed_at timestamptz, bid_board_linked_at timestamptz, assigned_rep_id uuid, rfp_approval_requested_by uuid,
      rfp_approval_request_id integer, workflow_route text NOT NULL DEFAULT 'normal', stage_entered_at timestamptz,
      on_hold boolean NOT NULL DEFAULT false, on_hold_started_at timestamptz, on_hold_accumulated_seconds bigint DEFAULT 0,
      on_hold_accumulated_seconds_at_stage_entry bigint DEFAULT 0, is_active boolean NOT NULL DEFAULT true, updated_at timestamptz
    );
    CREATE TABLE office_test.deal_stage_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid, from_stage_id uuid, to_stage_id uuid, changed_by uuid,
      is_backward_move boolean, is_director_override boolean, override_reason text, duration_in_previous_stage interval,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Voting-path deal: pending round, NO rfp_approval_request_id.
  await db.query(
    `INSERT INTO office_test.deals (id, name, deal_number, stage_id, workflow_route, rfp_approval_status, rfp_approval_request_id, assigned_rep_id, rfp_approval_requested_by, stage_entered_at)
     VALUES ($1, 'jasonn ranches', 'TR-1001', $2, 'normal', 'pending', NULL, $3, $3, now())`,
    [DEAL, OPP, REP],
  );
  return db;
}

async function buildApp() {
  const { internalRfpRoutes } = await import("../../../src/modules/internal-rfp/routes.js");
  const app = express();
  app.use(internalRfpRoutes);
  return app;
}

describe("POST /bid-board-created (voting path)", () => {
  beforeEach(() => { process.env.SYNCHUB_SHARED_SECRET = SECRET; });
  afterEach(async () => { await holder.pg?.close(); holder.pg = null; vi.restoreAllMocks(); });

  it("advances a voting deal (no rfp_approval_request_id) on a 'created' callback with no rfpApprovalRequestId", async () => {
    await seed();
    const app = await buildApp();
    const raw = JSON.stringify({
      status: "created",
      sourceDealId: DEAL,
      bidboardProjectId: "88123",
      procoreCompanyId: "42",
      createdAt: new Date().toISOString(),
    });
    const res = await request(app).post("/bid-board-created").set("content-type", "application/json").set("x-rfp-request-signature", sign(raw)).send(raw);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const rows = (await holder.pg.query(`SELECT rfp_approval_status, is_bid_board_owned, procore_bid_id, stage_id FROM office_test.deals WHERE id=$1`, [DEAL])).rows as any[];
    expect(rows[0].rfp_approval_status).toBe("approved");
    expect(rows[0].is_bid_board_owned).toBe(true);
    expect(String(rows[0].procore_bid_id)).toBe("88123");
    expect(rows[0].stage_id).toBe(EST);
  });
});
