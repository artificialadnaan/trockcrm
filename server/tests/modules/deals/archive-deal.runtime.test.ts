import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { deleteDeal } from "../../../src/modules/deals/service.js";

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const REP = U("ee01");        // hex-safe representative user
const OPP_STAGE = U("50a1");
const AWARDED_STAGE = U("50a2");
const DD_STAGE = U("50a3");    // legacy Due Diligence stage → canonical opportunity alias
const D_OPP = U("d001");
const D_AWARDED = U("d002");
const D_DD = U("d003");
const D_INACTIVE = U("d004");  // seeded already-archived (is_active=false)
const D_MISSING = U("dfff");   // never inserted

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, name text, slug text UNIQUE, is_terminal boolean NOT NULL DEFAULT false);
    -- Full deals table so tenantDb.select().from(deals) doesn't miss any columns.
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
      procore_company_id text, procore_bid_id bigint, synchub_bid_board_id text, procore_image_category_id bigint,
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
      bid_board_detached_at timestamptz, bid_board_detached_by uuid, bid_board_detach_reason text,
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
    INSERT INTO pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${OPP_STAGE}', 'Opportunity', 'opportunity', false),
      ('${AWARDED_STAGE}', 'Awarded', 'awarded', false),
      ('${DD_STAGE}', 'Due Diligence', 'dd', false);
    INSERT INTO deals (id, name, stage_id, description, assigned_rep_id, is_active, is_change_order, on_hold, is_test_data, created_at, updated_at) VALUES
      ('${D_OPP}',     'Opp Deal',     '${OPP_STAGE}',     'Original scope.', '${REP}', true, false, false, false, now(), now()),
      ('${D_AWARDED}', 'Awarded Deal', '${AWARDED_STAGE}',  'Original scope.', '${REP}', true, false, false, false, now(), now()),
      ('${D_DD}',      'DD Deal',      '${DD_STAGE}',       'Original scope.', '${REP}', true, false, false, false, now(), now()),
      ('${D_INACTIVE}','Gone Deal',    '${OPP_STAGE}',      'Original scope.', '${REP}', false, false, false, false, now(), now());
    CREATE TABLE deal_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL, field_name text NOT NULL,
      old_value text, new_value text, changed_by uuid NOT NULL, source text, reason text,
      changed_at timestamptz DEFAULT now()
    );
    CREATE TABLE tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid, status text, is_overdue boolean);
    CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_deal_id uuid, is_active boolean, updated_at timestamptz);
    CREATE TABLE deal_signed_commissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid, rep_user_id uuid, amount numeric(14,2));
    CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_name text, record_id text, action text,
      changed_by uuid, actor_name text, actor_role text, entity_type text, changes jsonb,
      full_row jsonb, ip_address text, user_agent text, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => { await pg?.close?.(); });

describe("deleteDeal archive rules", () => {
  it("rejects an empty reason", async () => {
    await expect(deleteDeal(tdb, D_OPP, { actorRole: "rep", actorId: REP, reason: "  " })).rejects.toMatchObject({
      statusCode: 400, code: "DEAL_ARCHIVE_REASON_REQUIRED",
    });
  });

  it("blocks a rep archiving a non-opportunity deal", async () => {
    await expect(
      deleteDeal(tdb, D_AWARDED, { actorRole: "rep", actorId: REP, reason: "no" })
    ).rejects.toMatchObject({ statusCode: 403, code: "DEAL_ARCHIVE_STAGE_FORBIDDEN" });
  });

  it("archives an opportunity deal for a rep, prepending the reason to the description", async () => {
    const row = await deleteDeal(tdb, D_OPP, {
      actorRole: "rep", actorId: REP, reason: "Lost to competitor",
    });
    expect(row?.isActive).toBe(false);
    expect(row?.description).toMatch(/^\[Archived \d{4}-\d{2}-\d{2} — Lost to competitor\]\n\nOriginal scope\.$/);
    const hist = await pg.query(`SELECT field_name, source FROM deal_history WHERE deal_id = '${D_OPP}'`);
    expect(hist.rows).toContainEqual({ field_name: "description", source: "deal_archive" });
  });

  it("lets a rep archive a legacy dd-stage deal (opportunity alias)", async () => {
    const row = await deleteDeal(tdb, D_DD, {
      actorRole: "rep", actorId: REP, reason: "Dead lead",
    });
    expect(row?.isActive).toBe(false);
  });

  it("lets an admin archive a non-opportunity deal", async () => {
    const row = await deleteDeal(tdb, D_AWARDED, {
      actorRole: "admin", actorId: REP, reason: "Admin cleanup",
    });
    expect(row?.isActive).toBe(false);
  });

  it("returns null (no-op) when the deal is already archived", async () => {
    const row = await deleteDeal(tdb, D_INACTIVE, { actorRole: "admin", actorId: REP, reason: "again" });
    expect(row).toBeNull();
  });

  it("throws 404 for a non-existent deal", async () => {
    await expect(
      deleteDeal(tdb, D_MISSING, { actorRole: "admin", actorId: REP, reason: "x" })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
