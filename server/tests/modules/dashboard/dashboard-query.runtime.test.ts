import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "@trock-crm/shared/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * RUNTIME guard for the raw dashboard + pipeline SQL. These service functions build SQL strings
 * and run them via `tenantDb.execute()` / the Drizzle builder; no test executed them, so a bad
 * column / dropped join / renamed CTE slipped through CI (e.g. the dropped
 * `latest_current_stage_entered_at.entered_at` lateral that took the dashboard down in prod).
 *
 * This test runs the REAL queries against an in-memory Postgres (PGlite) whose tables mirror
 * production columns (dumped from information_schema), so any invalid column reference or missing
 * join fails HERE instead of in prod. A single Drizzle-over-PGlite client backs both the module
 * `db` (public schema reads: stages, offices, office membership) and the `tenantDb` argument
 * (deal reads) — only the DB connection is swapped; every query runs for real.
 */

// One in-memory Postgres, created before the service modules load. `holder` is populated after the
// client exists; the mock reads it lazily (db is only touched inside service functions, at test
// time), which side-steps the import/hoist ordering between vi.mock and client construction.
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../../../src/db.js", () => ({
  get db() {
    return holder.db;
  },
  pool: {},
}));

const pg = new PGlite();
const testDb = drizzle(pg, { schema });
holder.db = testDb;

// Service modules import the (now-mocked) db at load time, so import them after the mock is set up.
const { getDashboardAtRiskRows } = await import("../../../src/modules/dashboard/service.js");
const { listDealStagePage } = await import("../../../src/modules/deals/service.js");

// Column lists mirror production so the raw queries run against a faithful schema — a reference to a
// non-existent column (the failure mode this guards) errors instead of silently passing. `deals` /
// `deal_stage_history` are read only via raw SQL, so these are verbatim information_schema dumps.
// The builder-touched tables (pipeline_stage_config, offices, users, user_office_access) keep the
// column NAMES the Drizzle schema expects.
//
// Provenance: dumped from the production information_schema. After a migration that adds or renames a
// column these queries reference, refresh the affected list from the live schema. A stale dump fails
// loudly here ("column does not exist") — the safe direction — never a silent pass.
// NOTE: pipeline_stage_config is full-SELECTed by listDealStages (Drizzle `.select()`), so its column
// set must stay in sync with shared/src/schema/public/pipeline-stage-config.ts.
const DEALS_COLUMNS =
  "id uuid PRIMARY KEY, deal_number text, name text, stage_id uuid, assigned_rep_id uuid, primary_contact_id uuid, dd_estimate numeric, bid_estimate numeric, awarded_amount numeric, change_order_total numeric, description text, property_address text, property_city text, property_state text, property_zip text, project_type_id uuid, region_id uuid, source text, win_probability integer, procore_project_id bigint, procore_bid_id bigint, procore_last_synced_at timestamptz, lost_reason_id uuid, lost_notes text, lost_competitor text, lost_at timestamptz, expected_close_date date, actual_close_date date, last_activity_at timestamptz, stage_entered_at timestamptz, is_active boolean, hubspot_deal_id text, created_at timestamptz, updated_at timestamptz, company_id uuid, companycam_project_id text, property_lat numeric, property_lng numeric, workflow_route text, proposal_status text, proposal_sent_at timestamptz, proposal_accepted_at timestamptz, proposal_revision_count integer, proposal_notes text, estimating_substage text, property_id uuid, source_lead_id uuid, decision_maker_name text, decision_process text, budget_status text, incumbent_vendor text, unit_count integer, build_year integer, forecast_window text, forecast_category text, forecast_confidence_percent integer, forecast_revenue numeric, forecast_gross_profit numeric, forecast_blockers text, next_step text, next_step_due_at timestamptz, next_milestone_at timestamptz, support_needed_type text, support_needed_notes text, forecast_updated_at timestamptz, forecast_updated_by uuid, hubspot_owner_id text, hubspot_owner_email text, ownership_synced_at timestamptz, ownership_sync_status text, unassigned_reason_code text, pipeline_disposition text, is_bid_board_owned boolean, bid_board_stage_slug text, bid_board_stage_status text, bid_board_stage_entered_at timestamptz, bid_board_stage_exited_at timestamptz, bid_board_stage_duration text, bid_board_mirror_source_entered_at timestamptz, bid_board_mirror_source_exited_at timestamptz, pipeline_type_snapshot text, region_classification text, is_read_only_mirror boolean, is_read_only_sync_dirty boolean, read_only_synced_at timestamptz, bid_board_stage_family text, bid_board_loss_outcome text, contract_signed_date date, bid_board_estimator text, bid_board_office text, bid_board_status text, bid_board_sales_price_per_area text, bid_board_project_cost numeric, bid_board_profit_margin_pct numeric, bid_board_total_sales numeric, bid_board_created_at timestamptz, bid_board_due_date date, bid_board_customer_name text, bid_board_customer_contact_raw text, bid_board_project_number text, last_synced_from_hubspot_at timestamptz, proposal_draft_started_at timestamptz, project_type text, intended_project_number text, office_code text, is_test_data boolean, contract_signed_at timestamptz, rfp_approval_requested_at timestamptz, rfp_approval_request_event_id uuid, rfp_approval_requested_by uuid, procore_image_category_id bigint, procore_photo_link_id bigint, procore_photo_link_status text, rfp_approval_request_id integer, rfp_approval_token text, rfp_approval_status text, rfp_conflict_reason text, rfp_conflict_with jsonb, rfp_last_attempt_error text, estimator text, bid_due_date timestamptz, property_country text, procore_company_id text, bid_board_linked_at timestamptz, bid_board_last_updated_at timestamptz, bid_board_assigned_pm text, cleanup_status text, cleanup_completed_at timestamptz, cleanup_completed_by uuid, skip_reason text, skip_notes text, needs_leadership_review boolean, hubspot_extra_properties jsonb, project_number text, email_count integer, last_email_at timestamptz, created_by_user_id uuid, on_hold boolean, on_hold_started_at timestamptz, on_hold_accumulated_seconds bigint, on_hold_accumulated_seconds_at_stage_entry bigint, rfp_declined_reason text, rfp_declined_at timestamptz, won_closed_date date, estimator_user_id uuid, sales_source_user_id uuid, is_change_order boolean, parent_deal_id uuid";

const DEAL_STAGE_HISTORY_COLUMNS =
  "id uuid, deal_id uuid, from_stage_id uuid, to_stage_id uuid, changed_by uuid, is_backward_move boolean, is_director_override boolean, override_reason text, duration_in_previous_stage text, created_at timestamptz";

// Matches the Drizzle pipelineStageConfig schema (listDealStages does a full SELECT *).
const PIPELINE_STAGE_CONFIG_COLUMNS =
  "id uuid PRIMARY KEY, name text, slug text, display_order integer, workflow_family text, is_active_pipeline boolean, is_terminal boolean, required_fields jsonb, required_documents jsonb, required_approvals jsonb, touchpoint_cadence_days integer, stale_escalation_tiers jsonb, procore_stage_mapping text, color text";

const USERS_COLUMNS =
  "id uuid PRIMARY KEY, email text, display_name text, azure_ad_id text, avatar_url text, role text, office_id uuid, is_active boolean, notification_prefs text, created_at timestamptz, updated_at timestamptz, reports_to uuid, first_name text, last_name text, phone text, created_by_user_id uuid, onboarding_completed_at timestamptz, onboarding_completed_by uuid, onboarding_override_reason text, is_test_data boolean";

const OFFICES_COLUMNS =
  "id uuid PRIMARY KEY, name text, slug text, timezone text, address text, phone text, is_active boolean";

const USER_OFFICE_ACCESS_COLUMNS = "id uuid PRIMARY KEY, user_id uuid, office_id uuid";

const STAGE_ID = "11111111-1111-1111-1111-111111111111";
const REP_ID = "22222222-2222-2222-2222-222222222222";
const DEAL_ID = "33333333-3333-3333-3333-333333333333";
const OFFICE_ID = "44444444-4444-4444-4444-444444444444";

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (${PIPELINE_STAGE_CONFIG_COLUMNS});
    CREATE TABLE offices (${OFFICES_COLUMNS});
    CREATE TABLE users (${USERS_COLUMNS});
    CREATE TABLE user_office_access (${USER_OFFICE_ACCESS_COLUMNS});
    CREATE TABLE deals (${DEALS_COLUMNS});
    CREATE TABLE deal_stage_history (${DEAL_STAGE_HISTORY_COLUMNS});

    INSERT INTO pipeline_stage_config (id, slug, name, display_order, workflow_family, is_active_pipeline, is_terminal)
      VALUES ('${STAGE_ID}', 'opportunity', 'Opportunity', 1, 'standard_deal', true, false);
    INSERT INTO offices (id, name, slug, timezone, is_active)
      VALUES ('${OFFICE_ID}', 'Dallas', 'dallas', 'America/Chicago', true);
    INSERT INTO users (id, email, display_name, office_id, is_active)
      VALUES ('${REP_ID}', 'rep@example.com', 'Test Rep', '${OFFICE_ID}', true);
    -- office_code NULL + assigned_rep in the active office => matches the office-scope condition
    -- (resolveOfficeCodeFromOffice maps slug 'dallas' -> 'dfw', so the officeCode branch applies).
    -- stage_entered_at AND bid_board_stage_entered_at are left NULL so the dashboard COALESCE must
    -- fall through to the latest_current_stage_entered_at lateral — the dropped-join construct that
    -- took prod down — making that lateral load-bearing for the assertion below.
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, office_code, workflow_route, is_active, is_test_data, on_hold, bid_board_total_sales, bid_estimate, created_at, updated_at)
      VALUES ('${DEAL_ID}', 'D-1', 'Deal One', '${STAGE_ID}', '${REP_ID}', NULL, 'normal', true, false, false, 100000, 90000, now(), now());
    INSERT INTO deal_stage_history (id, deal_id, to_stage_id, created_at)
      VALUES (gen_random_uuid(), '${DEAL_ID}', '${STAGE_ID}', '2026-05-01 12:00:00+00');
  `);
});

afterAll(async () => {
  await pg.close();
});

describe("dashboard + pipeline SQL — real execution against a faithful schema", () => {
  it("the harness surfaces invalid-column errors (so a bad query reference fails the test)", async () => {
    // Proves the guard mechanism: a reference to a non-existent column throws here.
    await expect(
      testDb.execute(sql`SELECT d.column_that_does_not_exist FROM deals d`)
    ).rejects.toThrow();
  });

  it("getDashboardAtRiskRows executes — guards the latest_current_stage_entered_at lateral + COALESCE", async () => {
    // The exact query whose `latest_current_stage_entered_at.entered_at` reference broke prod;
    // executing it here means a dropped/renamed lateral or any bad column fails CI.
    const rows = await getDashboardAtRiskRows(testDb, {});
    expect(Array.isArray(rows)).toBe(true);
    const seeded = rows.find((r) => r.dealId === DEAL_ID);
    expect(seeded).toBeDefined();
    expect(seeded?.stageSlug).toBe("opportunity");
    // stage_entered_at AND bid_board_stage_entered_at are NULL, so this value can ONLY come from the
    // latest_current_stage_entered_at lateral (MAX(deal_stage_history.created_at) = 2026-05-01). That
    // makes the dropped-join construct that broke prod load-bearing: drop/rename it and this fails.
    expect(seeded?.stageEnteredAt).not.toBeNull();
    expect(new Date(seeded?.stageEnteredAt as string | Date).toISOString()).toMatch(/^2026-05-01/);
  });

  it("listDealStagePage executes — guards the pipeline count + row queries and the estimator predicate", async () => {
    // Runs the REAL pipeline count + full-projection row queries. `assignedRepId` exercises
    // buildAliasedInvolvedRepSql -> `(d.assigned_rep_id = $ OR d.estimator_user_id = $)`, so a bad
    // column in the projection, the shared filters, or the estimator predicate fails CI.
    const result = await listDealStagePage(testDb, {
      role: "admin",
      userId: REP_ID,
      activeOfficeId: OFFICE_ID,
      scope: "all",
      stageId: STAGE_ID,
      page: 1,
      pageSize: 25,
      assignedRepId: REP_ID,
    });

    expect(result.stage.id).toBe(STAGE_ID);
    expect(result.summary.totalCount).toBe(1);
    const row = result.rows.find((r) => r.id === DEAL_ID);
    expect(row).toBeDefined();
    expect(row?.assignedRepId).toBe(REP_ID);
  });
});
