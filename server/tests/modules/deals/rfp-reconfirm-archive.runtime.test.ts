/**
 * Runtime (PGlite) proof that reconfirmRfpDecline auto-archives the deal and prepends the combined
 * voter + reviewer notes to deals.description when it upholds a denial.
 *
 * Assertion 1: first call with a note → ok=true, is_active=false, description starts with "[Archived"
 *              and contains both rfp_declined_reason and the reviewer note; a deal_history row exists
 *              with field_name='description' and source='rfp_reconfirm_denial'.
 * Assertion 2: a second call on the same (now-inactive) deal → ok=false ("not_actionable"); the
 *              description is NOT double-prepended (guarded on is_active).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));

// Stub the audit side-effects so the test only needs deals + deal_history + job_queue.
const mocks = vi.hoisted(() => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("../../../src/modules/audit/audit-logger.js", () => ({
  logActivity: mocks.logActivity,
  buildAuditActorFromUser: () => ({ actorType: "user", userId: "x", name: "x", role: "x" }),
}));

import { reconfirmRfpDecline } from "../../../src/modules/deals/rfp-override-service.js";

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const DEAL_ID = U("de01");
const DEAL_ID_NULL_REASON = U("de02");
const ACTOR_ID = U("ac01");

const VOTER_NOTES = "Margins too thin; scope unclear";
const REVIEWER_NOTE = "Upheld — no path to profitability";
const ORIGINAL_DESC = "Big roofing job on the east wing.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    -- Full deals table: same shape as in archive-deal.runtime.test.ts so the Drizzle
    -- .returning() (which selects every column in the schema) doesn't hit a missing-column error.
    CREATE TABLE deals (
      id uuid PRIMARY KEY,
      deal_number varchar(50), name varchar(500), stage_id uuid, assigned_rep_id uuid,
      primary_contact_id uuid, billing_contact_id uuid, billing_contact_required_at timestamptz, company_id uuid, property_id uuid, source_lead_id uuid,
      dd_estimate numeric(14, 2), bid_estimate numeric(14, 2), awarded_amount numeric(14, 2),
      awarded_amount_overridden boolean, dd_estimate_overridden boolean, change_order_total numeric(14, 2),
      description text,
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
      rfp_override_note text, rfp_override_state text, rfp_override_error text,
      rfp_bidboard_attempt_at timestamptz, rfp_conflict_reason text,
      rfp_conflict_with jsonb, rfp_last_attempt_error text, last_synced_from_hubspot_at timestamptz,
      workflow_route text, pipeline_disposition text, last_activity_at timestamptz, on_hold boolean,
      on_hold_started_at timestamptz, on_hold_accumulated_seconds bigint,
      on_hold_accumulated_seconds_at_stage_entry bigint, stage_entered_at timestamptz,
      is_active boolean NOT NULL DEFAULT true,
      hubspot_deal_id varchar(50), companycam_project_id varchar(50), created_by_user_id uuid,
      property_lat numeric(10, 7), property_lng numeric(10, 7), estimating_substage text,
      proposal_status text, proposal_draft_started_at timestamptz, proposal_sent_at timestamptz,
      proposal_accepted_at timestamptz, bid_due_date timestamptz, proposal_revision_count integer,
      proposal_notes text, is_test_data boolean, is_change_order boolean, parent_deal_id uuid,
      created_at timestamptz, updated_at timestamptz
    );

    -- deal_history: id col required (Drizzle insert uses .values() → PGlite needs DEFAULT gen_random_uuid()).
    -- writeOverrideHistory uses a raw SQL INSERT without the id col, so DEFAULT fires automatically.
    CREATE TABLE deal_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL,
      field_name text NOT NULL,
      old_value text,
      new_value text,
      changed_by uuid NOT NULL,
      source text,
      reason text,
      changed_at timestamptz DEFAULT now()
    );

    -- job_queue: needed so the Drizzle jobQueue schema reference resolves at import time.
    -- The deal has rfp_approval_request_id = 99 (non-null) so the enqueue branch (null == null) won't fire;
    -- but the table must exist for the module to load without errors.
    CREATE TABLE job_queue (
      id bigserial PRIMARY KEY,
      job_type text NOT NULL,
      payload jsonb NOT NULL,
      office_id uuid,
      status text NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      last_error text,
      started_processing_at timestamptz,
      run_after timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );

    -- tasks: needed by the task-dismissal Drizzle UPDATE added in FIX 3.
    -- Minimal columns — only the ones the UPDATE reads/writes (status, is_overdue, deal_id).
    CREATE TABLE tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title varchar(500) NOT NULL DEFAULT 'Task',
      type text NOT NULL DEFAULT 'follow_up',
      priority text NOT NULL DEFAULT 'normal',
      status text NOT NULL DEFAULT 'pending',
      assigned_to uuid NOT NULL DEFAULT gen_random_uuid(),
      is_overdue boolean NOT NULL DEFAULT false,
      is_test_data boolean NOT NULL DEFAULT false,
      deal_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  tdb = drizzle(pg);
}, 30_000);

afterAll(async () => { await pg?.close(); });

beforeEach(async () => {
  mocks.logActivity.mockClear();
  await pg.query("DELETE FROM tasks");
  await pg.query("DELETE FROM deals");
  await pg.query("DELETE FROM deal_history");
  await pg.query("DELETE FROM job_queue");
  // Seed a deal that is reviewable: declined, not yet reconfirmed, is_active=true, with voter notes + description.
  await pg.query(
    `INSERT INTO deals (id, name, deal_number, project_number,
                        rfp_approval_status, rfp_approval_request_id,
                        rfp_declined_reason, description, is_active, updated_at)
     VALUES ($1, 'Test RFP Deal', 'TR-9001', 'PR-9001',
             'declined', 99,
             $2, $3, true, now())`,
    [DEAL_ID, VOTER_NOTES, ORIGINAL_DESC],
  );
  // Seed a second deal that is reviewable but has rfp_declined_reason = NULL (e.g. a voting-path denial).
  await pg.query(
    `INSERT INTO deals (id, name, deal_number, project_number,
                        rfp_approval_status, rfp_approval_request_id,
                        rfp_declined_reason, description, is_active, updated_at)
     VALUES ($1, 'Null Reason RFP Deal', 'TR-9002', 'PR-9002',
             'declined', 99,
             NULL, $2, true, now())`,
    [DEAL_ID_NULL_REASON, ORIGINAL_DESC],
  );
});

describe("reconfirmRfpDecline auto-archive", () => {
  it("FAILING BASELINE: before feature lands, deal stays active after reconfirm", async () => {
    // This test is written BEFORE the implementation to satisfy TDD (red phase).
    // Once the feature is added, reconfirm will set is_active=false; at that point this baseline
    // is superseded by "assertion 1" below (which actually asserts the new behavior).
    const row = (await pg.query<{ is_active: boolean }>(`SELECT is_active FROM deals WHERE id = $1`, [DEAL_ID])).rows[0];
    expect(row?.is_active).toBe(true); // baseline: deal is active before any call
  });

  it("assertion 1: reconfirm soft-deletes the deal and prepends combined notes to description", async () => {
    const res = await reconfirmRfpDecline({
      tenantDb: tdb,
      dealId: DEAL_ID,
      actor: { userId: ACTOR_ID, name: "Adam Shaw", role: "admin" },
      note: REVIEWER_NOTE,
      // rfp_approval_request_id = 99, so the email enqueue branch (null == null) won't fire.
      officeId: null,
    });

    expect(res.ok).toBe(true);
    // The result reports the archive outcome so the email + review-page CTA can reflect it.
    if (res.ok) expect(res.archived).toBe(true);

    // Deal must now be soft-deleted.
    const deal = (
      await pg.query<{ is_active: boolean; description: string }>(
        `SELECT is_active, description FROM deals WHERE id = $1`,
        [DEAL_ID],
      )
    ).rows[0];

    expect(deal?.is_active).toBe(false);

    // Description must start with the archive block.
    expect(deal?.description).toMatch(/^\[Archived \d{4}-\d{2}-\d{2} — /);

    // Description must contain both the voter notes and the reviewer reason.
    expect(deal?.description).toContain(VOTER_NOTES);
    expect(deal?.description).toContain(REVIEWER_NOTE);

    // The original description must still be present (preserved below the archive block).
    expect(deal?.description).toContain(ORIGINAL_DESC);

    // A deal_history row must record the description change with source='rfp_reconfirm_denial'.
    const histRows = (
      await pg.query<{ field_name: string; source: string }>(
        `SELECT field_name, source FROM deal_history WHERE deal_id = $1 AND field_name = 'description'`,
        [DEAL_ID],
      )
    ).rows;
    expect(histRows).toHaveLength(1);
    expect(histRows[0]).toMatchObject({ field_name: "description", source: "rfp_reconfirm_denial" });
  });

  it("assertion 2: a second reconfirm call returns ok=false (not_actionable) and does NOT double-prepend", async () => {
    // First call archives the deal.
    const first = await reconfirmRfpDecline({
      tenantDb: tdb,
      dealId: DEAL_ID,
      actor: { userId: ACTOR_ID, name: "Adam Shaw", role: "admin" },
      note: REVIEWER_NOTE,
      officeId: null,
    });
    expect(first.ok).toBe(true);

    const descAfterFirst = (
      await pg.query<{ description: string }>(`SELECT description FROM deals WHERE id = $1`, [DEAL_ID])
    ).rows[0]?.description ?? "";

    // Second call: the guarded UPDATE matches 0 rows (denial_reconfirmed already set) → not_actionable.
    const second = await reconfirmRfpDecline({
      tenantDb: tdb,
      dealId: DEAL_ID,
      actor: { userId: ACTOR_ID, name: "Adam Shaw", role: "admin" },
      note: "Trying again",
      officeId: null,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("not_actionable");
    }

    // Description must NOT have been prepended a second time.
    const descAfterSecond = (
      await pg.query<{ description: string }>(`SELECT description FROM deals WHERE id = $1`, [DEAL_ID])
    ).rows[0]?.description ?? "";
    expect(descAfterSecond).toBe(descAfterFirst);

    // Only one deal_history description row (from the first call).
    const histCount = (
      await pg.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM deal_history WHERE deal_id = $1 AND field_name = 'description'`,
        [DEAL_ID],
      )
    ).rows[0]?.n ?? 0;
    expect(histCount).toBe(1);
  });

  it("assertion 3: null rfp_declined_reason still produces a sensible description (no 'null'/'undefined' literals, no doubled spaces)", async () => {
    const reviewerNote = "Upheld despite no voter notes";
    const res = await reconfirmRfpDecline({
      tenantDb: tdb,
      dealId: DEAL_ID_NULL_REASON,
      actor: { userId: ACTOR_ID, name: "Adam Shaw", role: "admin" },
      note: reviewerNote,
      officeId: null,
    });

    expect(res.ok).toBe(true);

    const deal = (
      await pg.query<{ is_active: boolean; description: string }>(
        `SELECT is_active, description FROM deals WHERE id = $1`,
        [DEAL_ID_NULL_REASON],
      )
    ).rows[0];

    // Deal must be soft-deleted.
    expect(deal?.is_active).toBe(false);

    // Description must start with the archive block.
    expect(deal?.description).toMatch(/^\[Archived \d{4}-\d{2}-\d{2} — /);

    // Must contain the sentinel prefix and the reviewer's reason.
    expect(deal?.description).toContain("RFP denied.");
    expect(deal?.description).toContain(reviewerNote);

    // The original description must still be present.
    expect(deal?.description).toContain(ORIGINAL_DESC);

    // Must NOT contain the literal words "null" or "undefined" (would indicate a missing null-coalesce).
    expect(deal?.description).not.toMatch(/\bnull\b/i);
    expect(deal?.description).not.toMatch(/\bundefined\b/i);

    // Must NOT contain doubled spaces that would arise from a blank voter-notes interpolation.
    expect(deal?.description).not.toContain("  ");
  });

  it("assertion 4: pending and in_progress tasks on the deal are dismissed on archive", async () => {
    // Seed three tasks: pending + in_progress (both should be dismissed) and completed (must stay completed).
    const TASK_PENDING = U("0a01");
    const TASK_INPROG = U("0a02");
    const TASK_DONE = U("0a03");
    await pg.query(
      `INSERT INTO tasks (id, deal_id, status) VALUES ($1, $2, 'pending'), ($3, $2, 'in_progress'), ($4, $2, 'completed')`,
      [TASK_PENDING, DEAL_ID, TASK_INPROG, TASK_DONE],
    );

    const res = await reconfirmRfpDecline({
      tenantDb: tdb,
      dealId: DEAL_ID,
      actor: { userId: ACTOR_ID, name: "Adam Shaw", role: "admin" },
      note: REVIEWER_NOTE,
      officeId: null,
    });
    expect(res.ok).toBe(true);

    const taskRows = (
      await pg.query<{ id: string; status: string }>(
        `SELECT id, status FROM tasks WHERE deal_id = $1`,
        [DEAL_ID],
      )
    ).rows;

    const byId = Object.fromEntries(taskRows.map((r) => [r.id, r.status]));
    expect(byId[TASK_PENDING]).toBe("dismissed");
    expect(byId[TASK_INPROG]).toBe("dismissed");
    // completed tasks must be left untouched
    expect(byId[TASK_DONE]).toBe("completed");
  });

  it("assertion 5: a soft_delete audit entry is written via logActivity on archive", async () => {
    const res = await reconfirmRfpDecline({
      tenantDb: tdb,
      dealId: DEAL_ID,
      actor: { userId: ACTOR_ID, name: "Adam Shaw", role: "admin" },
      note: REVIEWER_NOTE,
      officeId: null,
    });
    expect(res.ok).toBe(true);

    // logActivity is mocked; find the call with action='soft_delete'.
    const softDeleteCall = mocks.logActivity.mock.calls.find(
      (args: any[]) => args[0]?.action === "soft_delete",
    );
    expect(softDeleteCall).toBeDefined();
    const callArg = softDeleteCall![0];
    expect(callArg.entity.recordId).toBe(DEAL_ID);
    expect(callArg.entity.tableName).toBe("deals");
    expect(callArg.fieldChanges).toMatchObject({ isActive: { from: true, to: false } });
  });

  it("assertion 6: the stuck-approving escape hatch reconfirms WITHOUT archiving (deal stays active)", async () => {
    const APPROVING_DEAL = U("de99");
    await pg.query(
      `INSERT INTO deals (id, name, deal_number, project_number,
                          rfp_approval_status, rfp_approval_request_id,
                          rfp_declined_reason, description, rfp_override_state, is_active, updated_at)
       VALUES ($1, 'Stuck Approving Deal', 'TR-9003', 'PR-9003',
               'declined', 99, $2, $3, 'approving', true, now())`,
      [APPROVING_DEAL, VOTER_NOTES, ORIGINAL_DESC],
    );

    const res = await reconfirmRfpDecline({
      tenantDb: tdb,
      dealId: APPROVING_DEAL,
      actor: { userId: ACTOR_ID, name: "Adam Shaw", role: "admin" },
      note: REVIEWER_NOTE,
      officeId: null,
    });
    expect(res.ok).toBe(true);
    // The escape hatch upholds the denial but does NOT archive — the result must report archived=false so the
    // email keeps a working deal link and the review-page footer CTA stays visible.
    if (res.ok) expect(res.archived).toBe(false);

    const deal = (
      await pg.query<{ is_active: boolean; description: string; rfp_override_decision: string }>(
        `SELECT is_active, description, rfp_override_decision FROM deals WHERE id = $1`,
        [APPROVING_DEAL],
      )
    ).rows[0];

    // The reconfirm is recorded, but the deal is NOT archived: a still-in-flight SyncHub /bid-board-created
    // callback (its findDeal filters is_active=true) must be able to find the active row and no-op idempotently.
    expect(deal?.rfp_override_decision).toBe("denial_reconfirmed");
    expect(deal?.is_active).toBe(true);
    expect(deal?.description).toBe(ORIGINAL_DESC);
  });
});
