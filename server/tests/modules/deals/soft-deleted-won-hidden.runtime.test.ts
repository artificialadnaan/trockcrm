import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getDealById, deleteDeal } from "../../../src/modules/deals/service.js";

/**
 * REAL-SQL (PGlite) proof of the soft-deleted-Won data-integrity invariant:
 *   - a soft-deleted (is_active=false) Won deal is NOT served by getDealById (the detail-page /
 *     edit / per-deal-action access gate), so it can no longer be opened or edited; but a LIVE
 *     (is_active=true) Won deal still IS served — the #695 field Won-browse feature depends on
 *     live Won staying visible/openable.
 *   - deleteDeal soft-deletes a live Won deal AND cascades is_active=false to its dependent
 *     `projects` mirror row (which the self-FK never deactivated), while leaving another live
 *     deal's project untouched; a repeat delete is idempotent (returns null — no false success).
 *
 * The full 138-column deals table is required because getDealById/deleteDeal select every column
 * (getTableColumns(deals) / select()). DDL generated from shared/src/schema/tenant/deals.ts with
 * the project's custom enum + interval types coerced to text/loose types (column NAMES are what
 * the drizzle query references; the DB type is irrelevant to a SELECT/UPDATE-by-name).
 */

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const ST = { won: U("57a1"), opp: U("57a2") };
const D = {
  liveWon: U("d01"),
  deletedWon: U("d02"),
  liveOpp: U("d03"),
  toDelete: U("d04"),
  coParent: U("d05"),
  deletedCoChild: U("d06"),
};
const PRJ = { toDelete: U("c01"), otherLive: U("c02"), deletedCoChild: U("c03") };
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
    -- getDealById now left-joins users (estimatorUserName for the PR3 estimator picker); the join needs
    -- the table to exist even when estimator_user_id is null (no rows required here).
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);

    INSERT INTO pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${ST.won}','Won','won',true),
      ('${ST.opp}','Opportunity','opportunity',false);

    INSERT INTO deals (id, name, deal_number, stage_id, is_active, is_change_order, parent_deal_id, on_hold, is_test_data, won_closed_date, created_at, updated_at) VALUES
      ('${D.liveWon}',       'Live Won',    'TR-1','${ST.won}', true,  false, NULL,            false, false, '2026-06-01', now(), now()),
      ('${D.deletedWon}',    'Deleted Won', 'TR-2','${ST.won}', false, false, NULL,            false, false, '2026-06-02', now(), now()),
      ('${D.liveOpp}',       'Live Opp',    'TR-3','${ST.opp}', true,  false, NULL,            false, false, NULL,         now(), now()),
      ('${D.toDelete}',      'To Delete',   'TR-4','${ST.won}', true,  false, NULL,            false, false, '2026-06-03', now(), now()),
      ('${D.coParent}',      'CO Parent',   'TR-5','${ST.won}', true,  false, NULL,            false, false, '2026-06-04', now(), now()),
      ('${D.deletedCoChild}','Deleted CO',  'TR-6','${ST.won}', false, true,  '${D.coParent}', true,  false, '2026-06-04', now(), now());

    INSERT INTO projects (id, source_deal_id, is_active, updated_at) VALUES
      ('${PRJ.toDelete}',      '${D.toDelete}',       true, now()),
      ('${PRJ.otherLive}',     '${D.liveOpp}',        true, now()),
      ('${PRJ.deletedCoChild}','${D.deletedCoChild}', true, now());
  `);
  tdb = drizzle(pg);
  // PGlite init + the full 138-column deals table can exceed Vitest's default 10s hook timeout when
  // many test files run in parallel; give the setup explicit headroom (Codex P2).
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

describe("getDealById — soft-deleted deals are not served, live deals are", () => {
  it("serves a LIVE Won deal (field #695 live-Won path stays openable)", async () => {
    await expect(getDealById(tdb, D.liveWon, "admin", ADMIN)).resolves.toMatchObject({ id: D.liveWon });
  });

  it("does NOT serve a soft-deleted Won deal — returns null (→ route 404, not openable/editable)", async () => {
    expect(await getDealById(tdb, D.deletedWon, "admin", ADMIN)).toBeNull();
  });

  it("still serves a soft-deleted deal when includeInactive=true (opt-in escape hatch for a future restore/admin view)", async () => {
    await expect(
      getDealById(tdb, D.deletedWon, "admin", ADMIN, "admin", true)
    ).resolves.toMatchObject({ id: D.deletedWon });
  });
});

describe("deleteDeal — soft-deletes the deal, hides it, and cascades to its project", () => {
  it("deletes a live Won deal, then it is no longer served; its project is deactivated; a sibling project is untouched; repeat delete is idempotent", async () => {
    const deleted = await deleteDeal(tdb, D.toDelete, "admin", ADMIN);
    expect(deleted).not.toBeNull();
    expect(deleted).toMatchObject({ id: D.toDelete, isActive: false });

    // (a) no longer openable/editable
    expect(await getDealById(tdb, D.toDelete, "admin", ADMIN)).toBeNull();

    // (d) the dependent project mirror is deactivated by the cascade...
    const target = await pg.query<{ is_active: boolean }>(
      `SELECT is_active FROM projects WHERE id = '${PRJ.toDelete}'`
    );
    expect(target.rows[0]?.is_active).toBe(false);

    // ...but another live deal's project is NOT touched (cascade is scoped to the deleted deal)
    const other = await pg.query<{ is_active: boolean }>(
      `SELECT is_active FROM projects WHERE id = '${PRJ.otherLive}'`
    );
    expect(other.rows[0]?.is_active).toBe(true);

    // repeat delete: no false success — already-inactive returns null
    expect(await deleteDeal(tdb, D.toDelete, "admin", ADMIN)).toBeNull();
  });

  it("cascades to the project mirror of an ALREADY-deleted CO child when its parent is deleted", async () => {
    // The CO child was soft-deleted in a prior CO-delete, so softDeleteChangeOrderChildren won't return
    // it during the parent delete; its project mirror was left active and dangling. The cascade must
    // still deactivate it — it collects ALL CO child ids, not just the ones voided in this call (Codex P2).
    const before = await pg.query<{ is_active: boolean }>(
      `SELECT is_active FROM projects WHERE id = '${PRJ.deletedCoChild}'`
    );
    expect(before.rows[0]?.is_active).toBe(true);

    await deleteDeal(tdb, D.coParent, "admin", ADMIN);

    const after = await pg.query<{ is_active: boolean }>(
      `SELECT is_active FROM projects WHERE id = '${PRJ.deletedCoChild}'`
    );
    expect(after.rows[0]?.is_active).toBe(false);
  });
});
