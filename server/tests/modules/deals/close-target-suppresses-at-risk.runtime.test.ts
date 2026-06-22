import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getDealById } from "../../../src/modules/deals/service.js";

/**
 * REAL-SQL (PGlite) proof that the deal-detail at-risk verdict honors the close-target suppression:
 * getDealById -> attachAtRiskResult now forwards expected_close_date into the shared at-risk engine, so
 * a deal that is over its stage-age SLA but has a TODAY-OR-FUTURE expected_close_date reads "not at risk /
 * close_target_pending" (the SLA is postponed until the target passes), while a past/null target falls
 * back to the normal stage-age at-risk. The full deals table DDL mirrors soft-deleted-won-hidden.runtime.
 */

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const ST = { opp: U("57a2") };
const D = { future: U("d11"), past: U("d12"), none: U("d13") };
const ADMIN = U("ad01");

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
      primary_contact_id uuid, company_id uuid, property_id uuid, source_lead_id uuid,
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
      estimator_user_id uuid, bid_board_office text, bid_board_status text,
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
      rfp_override_note text, rfp_override_state text, rfp_override_error text, rfp_conflict_reason text,
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

    -- All three: 40 days in Opportunity (rep SLA 7d) => over the stage-age threshold. They differ ONLY
    -- in expected_close_date, isolating the close-target suppression.
    INSERT INTO deals (id, name, deal_number, stage_id, is_active, is_change_order, on_hold, is_test_data,
                       stage_entered_at, expected_close_date, created_at, updated_at) VALUES
      ('${D.future}','Future target','TR-1','${ST.opp}', true, false, false, false, now() - interval '40 days', (current_date + 30)::date, now(), now()),
      ('${D.past}',  'Past target',  'TR-2','${ST.opp}', true, false, false, false, now() - interval '40 days', (current_date - 5)::date,  now(), now()),
      ('${D.none}',  'No target',    'TR-3','${ST.opp}', true, false, false, false, now() - interval '40 days', NULL,                       now(), now());
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

describe("getDealById — close-target postpones the deal-detail at-risk verdict", () => {
  it("a TODAY-OR-FUTURE expected_close_date suppresses at-risk (reason close_target_pending)", async () => {
    const deal = await getDealById(tdb, D.future, "admin", ADMIN, "rep");
    expect(deal?.atRisk).toMatchObject({ isAtRisk: false, status: "not_at_risk", reason: "close_target_pending" });
  });

  it("a PAST expected_close_date falls back to normal stage-age at-risk", async () => {
    const deal = await getDealById(tdb, D.past, "admin", ADMIN, "rep");
    expect(deal?.atRisk).toMatchObject({ isAtRisk: true, reason: "threshold_reached" });
  });

  it("a NULL expected_close_date falls back to normal stage-age at-risk", async () => {
    const deal = await getDealById(tdb, D.none, "admin", ADMIN, "rep");
    expect(deal?.atRisk).toMatchObject({ isAtRisk: true, reason: "threshold_reached" });
  });
});
