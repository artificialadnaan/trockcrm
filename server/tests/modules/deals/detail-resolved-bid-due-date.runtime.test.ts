import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

/**
 * REAL-SQL (PGlite) proof of getDealDetail's `resolvedBidDueDate` — the AUTHORITATIVE bid due date
 * the deal-detail banner reads.
 *
 *   - For a LEAD-BACKED deal the bid due date's lineage source is the lead (lineage-resolver:
 *     bidDueDate -> "lead"), and scoping edits write leads.bid_due_date WITHOUT mirroring it into
 *     deals.bid_due_date — so deals.bid_due_date is a STALE conversion-time snapshot. resolvedBidDueDate
 *     must surface the LEAD's value (leads.bid_due_date, a `date` column -> "YYYY-MM-DD"), NOT the
 *     stale deal snapshot. If the lead cleared it (NULL) the resolved value is null even when the deal
 *     column still holds a stale date.
 *   - For a NON-lead deal there is no lead row, so the deal's own column (deals.bid_due_date,
 *     timestamptz) is canonical; a null deal column resolves to null.
 *
 * The full 138-column deals table mirrors soft-deleted-won-hidden.runtime; the module-level config db
 * (getStageById, hit via getDealDetail -> getStageByIdForWorkflowRoute) is stubbed like the other deals
 * runtime tests so a single benign stage is returned without a real Postgres connection.
 */

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const ST = { opp: U("57a2") };
const L = { diff: U("1ead01"), nullDate: U("1ead02") };
const D = {
  leadDiff: U("d01"),
  nonLead: U("d02"),
  leadNull: U("d03"),
  nonLeadNull: U("d04"),
};
const ADMIN = U("ad01");

// getDealDetail -> getStageByIdForWorkflowRoute reads the module-level config db (NOT tenantDb). Stub it
// to return one benign standard-deal stage so the at-risk/post-conversion derivations run; the stage has
// no bearing on resolvedBidDueDate. Mirrors on-hold-scope.runtime / watched-scope.runtime.
vi.mock("../../../src/db.js", () => {
  const stage = {
    id: ST.opp,
    slug: "opportunity",
    name: "Opportunity",
    workflowFamily: "standard_deal",
    displayOrder: 1,
    isActivePipeline: true,
    isTerminal: false,
  };
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve([stage]);
  chain.orderBy = () => Promise.resolve([stage]);
  return { db: chain, pool: {} };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
// Imported AFTER the db.js mock is registered.
let getDealDetail: typeof import("../../../src/modules/deals/service.js").getDealDetail;

beforeAll(async () => {
  ({ getDealDetail } = await import("../../../src/modules/deals/service.js"));
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
    -- getDealDetail left-joins / sub-selects these; empty is fine (null FKs -> null fields).
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE companies (id uuid PRIMARY KEY, name text, owner_id uuid);
    CREATE TABLE contacts (id uuid PRIMARY KEY, first_name text, last_name text, job_title text, owner_id uuid);
    CREATE TABLE project_type_config (id uuid PRIMARY KEY, name text);
    CREATE TABLE deal_stage_history (
      id uuid PRIMARY KEY, deal_id uuid, from_stage_id uuid, to_stage_id uuid, changed_by uuid,
      is_backward_move boolean, is_director_override boolean, override_reason text,
      duration_in_previous_stage interval, created_at timestamptz
    );
    CREATE TABLE deal_approvals (
      id uuid PRIMARY KEY, deal_id uuid, target_stage_id uuid, required_role text, requested_by uuid,
      approved_by uuid, status text, notes text, created_at timestamptz, resolved_at timestamptz
    );
    CREATE TABLE change_orders (
      id uuid PRIMARY KEY, deal_id uuid, co_number integer, title text, amount numeric(14, 2),
      status text, procore_co_id bigint, approved_at timestamptz, created_at timestamptz, updated_at timestamptz
    );
    CREATE TABLE deal_change_orders (
      id uuid PRIMARY KEY, deal_id uuid, signed_date date, amount numeric(14, 2), description text,
      created_by uuid, updated_by uuid, created_at timestamptz, updated_at timestamptz
    );
    -- Only id + bid_due_date are read by getDealDetail's lead lookup (a date column -> "YYYY-MM-DD").
    CREATE TABLE leads (id uuid PRIMARY KEY, bid_due_date date);

    INSERT INTO pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${ST.opp}','Opportunity','opportunity',false);

    -- Leads: one with a date that DIFFERS from its deal's stale snapshot, one with a NULL bid due date.
    INSERT INTO leads (id, bid_due_date) VALUES
      ('${L.diff}', '2026-07-10'),
      ('${L.nullDate}', NULL);

    INSERT INTO deals (id, name, deal_number, stage_id, source_lead_id, workflow_route, is_active,
                       is_change_order, on_hold, is_test_data, bid_due_date, created_at, updated_at) VALUES
      -- lead-backed; deals.bid_due_date is a STALE 2026-01-01 snapshot, lead says 2026-07-10
      ('${D.leadDiff}','Lead diff','TR-1','${ST.opp}','${L.diff}','normal', true, false, false, false, '2026-01-01T00:00:00.000Z', now(), now()),
      -- non-lead; the deal's own column is canonical
      ('${D.nonLead}','Non lead','TR-2','${ST.opp}', NULL,        'normal', true, false, false, false, '2026-08-15T00:00:00.000Z', now(), now()),
      -- lead-backed but lead cleared the date; deal still holds a stale snapshot
      ('${D.leadNull}','Lead null','TR-3','${ST.opp}','${L.nullDate}','normal', true, false, false, false, '2026-02-02T00:00:00.000Z', now(), now()),
      -- non-lead with no bid due date at all
      ('${D.nonLeadNull}','Non lead null','TR-4','${ST.opp}', NULL, 'normal', true, false, false, false, NULL, now(), now());
  `);
  tdb = drizzle(pg);
  // PGlite init + the full 138-column deals table can exceed Vitest's default 10s hook timeout.
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

describe("getDealDetail — resolvedBidDueDate is the authoritative bid due date", () => {
  it("LEAD-BACKED: resolves to the LEAD's value, NOT the stale deals.bid_due_date snapshot", async () => {
    const detail = await getDealDetail(tdb, D.leadDiff, "admin", ADMIN);
    // The lead's date-only value (leads.bid_due_date is a `date` column).
    expect(detail?.resolvedBidDueDate).toBe("2026-07-10");
    // Prove it is NOT the stale deal snapshot the banner used to read.
    expect(detail?.resolvedBidDueDate).not.toEqual(detail?.bidDueDate);
    // The raw deal column is left UNCHANGED on the payload (other consumers may rely on it).
    expect(detail?.bidDueDate).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("NON-lead: resolves to the deal's own deals.bid_due_date", async () => {
    const detail = await getDealDetail(tdb, D.nonLead, "admin", ADMIN);
    expect(detail?.resolvedBidDueDate).toEqual(new Date("2026-08-15T00:00:00.000Z"));
    expect(detail?.resolvedBidDueDate).toEqual(detail?.bidDueDate);
  });

  it("LEAD-BACKED with a cleared (null) lead date: resolves to null even though the deal holds a stale date", async () => {
    const detail = await getDealDetail(tdb, D.leadNull, "admin", ADMIN);
    expect(detail?.resolvedBidDueDate).toBeNull();
    // The stale deal snapshot is still present on the raw field but is NOT what the banner reads.
    expect(detail?.bidDueDate).toEqual(new Date("2026-02-02T00:00:00.000Z"));
  });

  it("NON-lead with no bid due date: resolves to null", async () => {
    const detail = await getDealDetail(tdb, D.nonLeadNull, "admin", ADMIN);
    expect(detail?.resolvedBidDueDate).toBeNull();
  });
});
