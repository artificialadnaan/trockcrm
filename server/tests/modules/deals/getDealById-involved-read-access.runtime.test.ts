import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getDealById } from "../../../src/modules/deals/service.js";
import { AppError } from "../../../src/middleware/error-handler.js";

/**
 * REAL-SQL (PGlite) proof of the READ-vs-WRITE authorization split on getDealById.
 *
 * P2 AUTHORIZATION fix: getDealById is BOTH the deal-detail READ gate AND the RBAC gate for many WRITE
 * routes (estimating uploads, contact associations, deal edits). An earlier widening let an estimator/
 * source rep pass the gate unconditionally, so the widening leaked into those write routes. The fix makes
 * the involved-rep widening READ-only and opt-in via { involvedReadAccess: true }:
 *   - WITH the flag  (READ intent)  → owner OR estimator OR sales_source may access.
 *   - WITHOUT it (DEFAULT, write gates) → STRICT owner-only for reps (the pre-widening behavior).
 * A rep who is neither owner/estimator/source is always rejected.
 *
 * The deals table DDL mirrors close-target-suppresses-at-risk.runtime (the columns getDealById selects).
 */

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const ST = { opp: U("57a2") };
const REP = U("abc1"); // the rep whose access we probe
const OTHER = U("dad1"); // the deal's actual owner in the involved-but-not-owner cases
const D = {
  owned: U("da01"), // REP is the assigned rep
  sourced: U("da02"), // REP is the sales source only
  estimated: U("da03"), // REP is the estimator only
  unrelated: U("da04"), // REP has no involvement
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, name text, slug text UNIQUE, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE deals (
      id uuid PRIMARY KEY,
      deal_number varchar(50), name varchar(500), stage_id uuid, assigned_rep_id uuid,
      primary_contact_id uuid, billing_contact_id uuid, billing_contact_required_at timestamptz, company_id uuid, property_id uuid, source_lead_id uuid,
      dd_estimate numeric(14, 2), bid_estimate numeric(14, 2), awarded_amount numeric(14, 2),
      awarded_amount_overridden boolean, dd_estimate_overridden boolean, change_order_total numeric(14, 2), description text,
      estimator text, property_address text, property_city varchar(255), property_state varchar(2),
      property_zip varchar(10), property_country text, office_code text, project_type text,
      project_type_id uuid, region_id uuid, source varchar(100), win_probability integer,
      decision_maker_name varchar(255), decision_process text, budget_status varchar(100),
      incumbent_vendor varchar(255), unit_count integer, build_year integer, forecast_window text,
      forecast_category text, forecast_confidence_percent integer, forecast_revenue numeric(14, 2),
      forecast_gross_profit numeric(14, 2), forecast_blockers text, next_step text,
      next_step_due_at timestamptz, next_milestone_at timestamptz, support_needed_type text,
      support_needed_notes text, forecast_updated_at timestamptz, forecast_updated_by uuid,
      email_count integer, last_email_at timestamptz, procore_project_id bigint,
      procore_company_id text, procore_bid_id bigint, procore_image_category_id bigint,
      procore_photo_link_id bigint, procore_photo_link_status varchar(50),
      procore_last_synced_at timestamptz, is_bid_board_owned boolean, bid_board_stage_slug varchar(100),
      bid_board_stage_family varchar(50), bid_board_stage_status varchar(50),
      bid_board_stage_entered_at timestamptz, bid_board_stage_exited_at timestamptz,
      bid_board_stage_duration text, bid_board_loss_outcome varchar(100), bid_board_estimator text,
      estimator_user_id uuid, sales_source_user_id uuid, bid_board_office text, bid_board_status text,
      bid_board_sales_price_per_area text, bid_board_project_cost numeric(14, 2),
      bid_board_profit_margin_pct numeric(9, 4), bid_board_total_sales numeric(14, 2),
      bid_board_created_at timestamptz, bid_board_due_date date, bid_board_customer_name text,
      bid_board_customer_contact_raw text, bid_board_project_number text, project_number text,
      bid_board_linked_at timestamptz, bid_board_last_updated_at timestamptz, bid_board_assigned_pm text,
      intended_project_number text, bid_board_mirror_source_entered_at timestamptz,
      bid_board_mirror_source_exited_at timestamptz, pipeline_type_snapshot text,
      region_classification varchar(50), is_read_only_mirror boolean, is_read_only_sync_dirty boolean,
      read_only_synced_at timestamptz, hubspot_owner_id varchar(64), hubspot_owner_email varchar(320),
      ownership_synced_at timestamptz, ownership_sync_status varchar(32), unassigned_reason_code varchar(64),
      lost_reason_id uuid, lost_notes text, lost_competitor varchar(255), lost_at timestamptz,
      expected_close_date date, actual_close_date date, won_closed_date date, contract_signed_date date,
      contract_signed_at timestamptz, rfp_approval_requested_at timestamptz,
      rfp_approval_request_event_id uuid, rfp_approval_requested_by uuid, rfp_approval_request_id integer,
      rfp_approval_token text, rfp_approval_status text, rfp_declined_reason text, rfp_declined_at timestamptz,
      rfp_override_reviewed_at timestamptz, rfp_override_reviewed_by uuid, rfp_override_decision text,
      rfp_override_note text, rfp_override_state text, rfp_override_error text, rfp_bidboard_attempt_at timestamptz, rfp_conflict_reason text,
      rfp_conflict_with jsonb, rfp_last_attempt_error text, last_synced_from_hubspot_at timestamptz,
      workflow_route text, pipeline_disposition text, last_activity_at timestamptz, on_hold boolean,
      on_hold_started_at timestamptz, on_hold_accumulated_seconds bigint,
      on_hold_accumulated_seconds_at_stage_entry bigint, stage_entered_at timestamptz, is_active boolean,
      hubspot_deal_id varchar(50), companycam_project_id varchar(50), created_by_user_id uuid,
      property_lat numeric(10, 7), property_lng numeric(10, 7), estimating_substage text,
      proposal_status text, proposal_draft_started_at timestamptz, proposal_sent_at timestamptz,
      proposal_accepted_at timestamptz, bid_due_date timestamptz, proposal_revision_count integer,
      proposal_notes text, is_test_data boolean, is_change_order boolean, parent_deal_id uuid,
      created_at timestamptz, updated_at timestamptz
    );
    CREATE TABLE tasks (id uuid PRIMARY KEY, deal_id uuid, status text, is_overdue boolean);
    CREATE TABLE projects (id uuid PRIMARY KEY, source_deal_id uuid, is_active boolean NOT NULL DEFAULT true, updated_at timestamptz);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);

    INSERT INTO pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${ST.opp}','Opportunity','opportunity',false);

    INSERT INTO users (id, display_name) VALUES
      ('${REP}','Probe Rep'), ('${OTHER}','Owning Rep');

    -- Four deals isolating the access relationship: owner / source-only / estimator-only / unrelated.
    INSERT INTO deals (id, name, deal_number, stage_id, assigned_rep_id, estimator_user_id, sales_source_user_id,
                       is_active, is_change_order, on_hold, is_test_data, stage_entered_at, created_at, updated_at) VALUES
      ('${D.owned}',     'Owned',     'TR-1','${ST.opp}','${REP}',  NULL,     NULL,     true, false, false, false, now(), now(), now()),
      ('${D.sourced}',   'Sourced',   'TR-2','${ST.opp}','${OTHER}',NULL,     '${REP}', true, false, false, false, now(), now(), now()),
      ('${D.estimated}', 'Estimated', 'TR-3','${ST.opp}','${OTHER}','${REP}', NULL,     true, false, false, false, now(), now(), now()),
      ('${D.unrelated}', 'Unrelated', 'TR-4','${ST.opp}','${OTHER}',NULL,     NULL,     true, false, false, false, now(), now(), now());
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

async function expect403(fn: () => Promise<unknown>) {
  await expect(fn()).rejects.toMatchObject({ statusCode: 403 });
  // Also confirm it is the deliberate AppError, not an incidental failure.
  await fn().catch((err) => expect(err).toBeInstanceOf(AppError));
}

const READ = { involvedReadAccess: true } as const;

describe("getDealById — READ-vs-WRITE authorization split for reps", () => {
  it("owner rep can access their own deal in BOTH modes (no regression)", async () => {
    // Default (write gate) and read intent both admit the owner.
    expect((await getDealById(tdb, D.owned, "rep", REP))?.id).toBe(D.owned);
    expect((await getDealById(tdb, D.owned, "rep", REP, "rep", false, READ))?.id).toBe(D.owned);
  });

  it("source rep can READ an involved deal WITH involvedReadAccess", async () => {
    const deal = await getDealById(tdb, D.sourced, "rep", REP, "rep", false, READ);
    expect(deal?.id).toBe(D.sourced);
  });

  it("estimator rep can READ an involved deal WITH involvedReadAccess", async () => {
    const deal = await getDealById(tdb, D.estimated, "rep", REP, "rep", false, READ);
    expect(deal?.id).toBe(D.estimated);
  });

  it("source rep is REJECTED (403) WITHOUT the flag (default = write-gate strictness)", async () => {
    await expect403(() => getDealById(tdb, D.sourced, "rep", REP));
  });

  it("estimator rep is REJECTED (403) WITHOUT the flag (default = write-gate strictness)", async () => {
    await expect403(() => getDealById(tdb, D.estimated, "rep", REP));
  });

  it("a rep who is neither owner/estimator/source is REJECTED (403) in BOTH modes", async () => {
    await expect403(() => getDealById(tdb, D.unrelated, "rep", REP));
    await expect403(() => getDealById(tdb, D.unrelated, "rep", REP, "rep", false, READ));
  });
});
