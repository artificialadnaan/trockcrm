// ★ THE ACCEPTANCE TEST for "Move back to Opportunity".
//
// Moving a deal back to Opportunity is POINTLESS unless the next Bid Board export cannot drag it
// forward again — bid-board-sync applies backward AND terminal-exit stage moves ("Bid Board is the
// source of truth"), so before this feature a reopened estimating deal was back in estimating within
// one sync cycle. This runs the REAL ingestBidBoardRows (against an in-memory Postgres, with only the
// pg pool swapped for a PGlite client) over a DETACHED deal, once per match tier, and proves nothing
// about the deal moves.
//
// If the base-WHERE predicate is removed, the "stage unchanged" and "is_bid_board_owned still false"
// assertions fail on the very first tier.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const SCHEMA = "office_test";
const ADMIN = U("5e7");
const ST_OPPORTUNITY = U("57e0");
const ST_ESTIMATING = U("57e1");
const ST_WON = U("57e4");

const ATTACHED = U("d0001");
const DETACHED = U("d0002");

let pg: PGlite;

// node-pg exposes rowCount; PGlite exposes affectedRows. The production code reads rowCount, so present
// a node-pg-compatible client here — a harness adapter, not a code change.
const client = {
  query: async (text: string, params?: unknown[]) => {
    const r: unknown = await pg.query(text, params as never);
    const row = r as { rows: unknown[]; affectedRows?: number; rowCount?: number };
    return { ...row, rowCount: row.affectedRows ?? row.rowCount ?? row.rows?.length ?? 0 };
  },
  release: () => {},
};

vi.mock("../../../src/db.js", () => ({
  pool: { connect: async () => client },
  releasePooledClient: () => {},
  isBrokenConnectionError: () => false,
}));

const { ingestBidBoardRows } = await import("../../../src/modules/bid-board-sync/service.js");

async function seedDeals() {
  await pg.exec(`DELETE FROM ${SCHEMA}.deals;`);
  await pg.exec(`DELETE FROM ${SCHEMA}.deal_stage_history;`);
  await pg.exec(`DELETE FROM ${SCHEMA}.bid_board_sync_runs;`);
  // Two deals with DIFFERENT identities on every tier, so a tier-specific export row targets exactly
  // one of them: the attached control proves the sync still works, the detached one proves the guard.
  await pg.exec(`
    INSERT INTO ${SCHEMA}.deals
      (id, name, stage_id, stage_entered_at, workflow_route, deal_number, project_number,
       bid_board_project_number, procore_bid_id, bid_board_created_at, bid_estimate,
       is_bid_board_owned, bid_board_stage_slug, is_active, bid_board_detached_at)
    VALUES
      ('${ATTACHED}', 'Attached Tower', '${ST_ESTIMATING}', now() - interval '5 days', 'normal',
       'DFW-1-00001-aa', 'DFW-1-00001-aa', 'DFW-1-00001-aa', 111111, '2026-01-01T00:00:00Z', 100000,
       true, 'estimating', true, NULL),
      -- deal_number is deliberately DIFFERENT from project_number on the detached deal: tier 2 is one
      -- OR-ed predicate over project_number / deal_number / bid_board_project_number, so with the two
      -- equal the "deal_number" case would silently re-run the project_number case and prove nothing.
      ('${DETACHED}', 'Detached Tower', '${ST_OPPORTUNITY}', now() - interval '5 days', 'normal',
       'DFW-2-90002-zz', 'DFW-2-00002-bb', NULL, 222222, '2026-02-02T00:00:00Z', 100000,
       false, NULL, true, '2026-07-20T12:00:00Z');
  `);
}

async function dealRow(id: string) {
  const { rows } = await pg.query<Record<string, unknown>>(
    `SELECT * FROM ${SCHEMA}.deals WHERE id = '${id}'`
  );
  return rows[0];
}

/** One export row that the Bid Board would use to push the deal into Won. */
function wonRow(overrides: Record<string, unknown>) {
  return {
    Name: "Detached Tower",
    Status: "Won",
    "Total Sales": "999000",
    ...overrides,
  };
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`
    CREATE TABLE public.pipeline_stage_config (
      id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL,
      display_order int, is_terminal boolean NOT NULL DEFAULT false,
      is_active_pipeline boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.users (
      id uuid PRIMARY KEY, display_name text NOT NULL, is_active boolean NOT NULL DEFAULT true,
      role text, office_id uuid, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.offices (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.deals (
      id uuid PRIMARY KEY, name text, stage_id uuid NOT NULL, stage_entered_at timestamptz,
      on_hold boolean NOT NULL DEFAULT false, on_hold_started_at timestamptz,
      on_hold_accumulated_seconds bigint NOT NULL DEFAULT 0,
      on_hold_accumulated_seconds_at_stage_entry bigint NOT NULL DEFAULT 0,
      workflow_route text NOT NULL DEFAULT 'normal', deal_number text, project_number text,
      bid_board_project_number text, bid_board_estimator text, estimator_user_id uuid,
      sales_source_user_id uuid, bid_board_office text, bid_board_status text,
      bid_board_sales_price_per_area text, bid_board_project_cost numeric,
      bid_board_profit_margin_pct numeric, bid_board_total_sales numeric,
      bid_board_created_at timestamptz, bid_board_due_date date, bid_board_customer_name text,
      bid_board_customer_contact_raw text, bid_board_stage_slug text, bid_board_stage_family text,
      bid_board_stage_status text, bid_board_stage_entered_at timestamptz,
      bid_board_last_updated_at timestamptz, bid_estimate numeric, awarded_amount numeric,
      won_closed_date date, contract_signed_date date, contract_signed_at timestamptz,
      actual_close_date date, lost_at timestamptz, bid_board_loss_outcome text,
      lost_reason_id uuid, lost_notes text, lost_competitor text,
      procore_bid_id bigint, is_bid_board_owned boolean NOT NULL DEFAULT false,
      read_only_synced_at timestamptz, is_active boolean NOT NULL DEFAULT true,
      is_change_order boolean NOT NULL DEFAULT false, parent_deal_id uuid,
      bid_board_detached_at timestamptz, bid_board_detached_by uuid, bid_board_detach_reason text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${SCHEMA}.deal_stage_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL, from_stage_id uuid, to_stage_id uuid NOT NULL, changed_by uuid NOT NULL,
      is_backward_move boolean NOT NULL DEFAULT false, is_director_override boolean NOT NULL DEFAULT false,
      override_reason text, duration_in_previous_stage interval,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${SCHEMA}.deal_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL, field_name text NOT NULL,
      old_value text, new_value text, changed_by uuid, source text, reason text,
      changed_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${SCHEMA}.audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_name text, record_id uuid, action text,
      changed_by uuid, actor_name text, actor_role text, actor_system_process text, entity_type text,
      entity_name_snapshot text, entity_secondary_id_snapshot text, impersonator_id uuid,
      changes jsonb, field_changes_jsonb jsonb, full_row jsonb, visibility_scope text,
      ip_address text, user_agent text, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${SCHEMA}.bid_board_sync_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_filename text, extracted_at timestamptz,
      payload_hash text, row_count int DEFAULT 0, updated_count int DEFAULT 0,
      no_match_count int DEFAULT 0, multi_match_count int DEFAULT 0, warning_count int DEFAULT 0,
      matched_count int DEFAULT 0, stage_updated_count int DEFAULT 0,
      skipped_no_project_number_count int DEFAULT 0, skipped_unmapped_status_count int DEFAULT 0,
      skipped_template_count int DEFAULT 0, applied_backward_count int DEFAULT 0,
      skipped_terminal_count int DEFAULT 0, skipped_no_stage_change_count int DEFAULT 0,
      skipped_detached_count int NOT NULL DEFAULT 0,
      estimate_updated_count int DEFAULT 0, estimate_updated_higher_count int DEFAULT 0,
      estimate_updated_lower_count int DEFAULT 0, estimate_skipped_no_value_count int DEFAULT 0,
      estimate_skipped_no_change_count int DEFAULT 0, estimate_warning_count int DEFAULT 0,
      estimate_skipped_terminal_count int DEFAULT 0, status text DEFAULT 'received',
      errors jsonb DEFAULT '[]', warnings jsonb DEFAULT '[]',
      unmatched_project_numbers jsonb DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.pipeline_stage_config (id, slug, name, display_order, is_terminal) VALUES
      ('${ST_OPPORTUNITY}', 'opportunity', 'Opportunity', 2, false),
      ('${ST_ESTIMATING}', 'estimating', 'Estimating', 3, false),
      ('${ST_WON}', 'won', 'Won', 7, true);
    INSERT INTO public.users (id, display_name, is_active, role) VALUES ('${ADMIN}', 'Ada Admin', true, 'admin');
  `);
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await seedDeals();
});

describe("Bid Board sync cannot re-claim a deal that was moved back to Opportunity", () => {
  // Each case matches the detached deal through ONE tier of findDealMatches. The predicate lives in the
  // shared base WHERE precisely so no tier can leak — this proves each of them individually.
  const tiers: Array<{ label: string; row: Record<string, unknown> }> = [
    {
      label: "tier 1 — procore_bid_id",
      row: wonRow({ "Bid Board Project ID": "222222", "Project #": "DFW-2-00002-bb" }),
    },
    {
      label: "tier 2 — project_number",
      row: wonRow({ "Project #": "DFW-2-00002-bb" }),
    },
    {
      label: "tier 2 — deal_number",
      row: wonRow({ "Project #": "DFW-2-90002-zz" }),
    },
    {
      label: "tier 3 — name + bid_board_created_at (reachable because the detach nulls bid_board_project_number)",
      row: wonRow({ "Project #": "SOMETHING-ELSE", "Created Date": "2026-02-02T00:00:00Z" }),
    },
  ];

  for (const tier of tiers) {
    it(`does not touch the detached deal via ${tier.label}`, async () => {
      const before = await dealRow(DETACHED);

      const result = await ingestBidBoardRows({ office_slug: "test", rows: [tier.row] });

      const after = await dealRow(DETACHED);
      // The stage dragger did NOT run.
      expect(after.stage_id).toBe(ST_OPPORTUNITY);
      // The stage-metadata refresh did NOT re-own it.
      expect(after.is_bid_board_owned).toBe(false);
      expect(after.bid_board_stage_slug).toBeNull();
      // The mirror UPDATE did not overwrite name / bid-board fields...
      expect(after.name).toBe("Detached Tower");
      expect(after.bid_board_status).toBeNull();
      // ...and the estimate writeback did not overwrite the deal's own bid estimate.
      expect(String(after.bid_estimate)).toBe(String(before.bid_estimate));
      // The detach marker itself survives.
      expect(after.bid_board_detached_at).not.toBeNull();

      // Classified as a deliberate skip, NOT as "no CRM deal matched" — otherwise every run from here
      // on reports completed_with_unmatched and unmatched_project_numbers fills with noise forever.
      expect(result.metrics.skippedDetached).toBe(1);
      expect(result.metrics.noMatch).toBe(0);
      expect(result.metrics.matched).toBe(0);
      expect(result.warnings.join(" ")).toContain("Delete this project from the Bid Board");
      // Date renders as a plain ISO day, not node-pg's "Mon Jul 20 2026 …" Date.toString().
      expect(result.warnings.join(" ")).toContain("moved back to Opportunity on 2026-07-20");

      const { rows: history } = await pg.query(
        `SELECT id FROM ${SCHEMA}.deal_stage_history WHERE deal_id = '${DETACHED}'`
      );
      expect(history).toHaveLength(0);
    });
  }

  // TIER PRIORITY. The detached lookup runs at the SAME tier as the attached one, before dropping to a
  // weaker tier — otherwise a row whose strongest identity (procore_bid_id) belongs to a detached deal
  // falls through and binds to a DIFFERENT deal on a weaker tier, overwriting that deal's name, stage
  // and estimate with another project's data. That is worse than either outcome the feature intends.
  it("stops at a DETACHED tier-1 identity instead of falling through to a different deal at tier 2", async () => {
    const before = await dealRow(ATTACHED);

    // procore_bid_id 222222 is the DETACHED deal's; the Project # is the ATTACHED deal's.
    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [wonRow({ "Bid Board Project ID": "222222", "Project #": "DFW-1-00001-aa" })],
    });

    const attached = await dealRow(ATTACHED);
    expect(attached.stage_id).toBe(ST_ESTIMATING);
    expect(attached.name).toBe("Attached Tower");
    expect(String(attached.bid_estimate)).toBe(String(before.bid_estimate));
    expect(attached.bid_board_status).toBeNull();

    expect(result.metrics.skippedDetached).toBe(1);
    expect(result.metrics.matched).toBe(0);
    expect(result.metrics.stageUpdated).toBe(0);
    expect(result.warnings.join(" ")).toContain(DETACHED);
  });

  // AMBIGUITY ACROSS THE PARTITION. Splitting the matcher into attached/detached halves must not hide a
  // multi-match: with the detached deal filtered out, the attached half alone looks like a clean single
  // hit and the multi-match guard — whose whole job is refusing an ambiguous write — never fires.
  it("still refuses an AMBIGUOUS row when the second claimant is the detached deal", async () => {
    // Give the attached deal a mirror project number equal to the detached deal's project_number, so one
    // tier-2 lookup legitimately identifies both. (Tier 2 ORs project_number / deal_number /
    // bid_board_project_number, so this is a shape the real data can take.)
    await pg.exec(
      `UPDATE ${SCHEMA}.deals SET bid_board_project_number = 'DFW-2-00002-bb' WHERE id = '${ATTACHED}'`
    );
    const attachedBefore = await dealRow(ATTACHED);

    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [wonRow({ "Project #": "DFW-2-00002-bb" })],
    });

    // Neither deal is written: an operator has to reconcile which project this row belongs to.
    const attached = await dealRow(ATTACHED);
    expect(attached.stage_id).toBe(ST_ESTIMATING);
    expect(attached.name).toBe("Attached Tower");
    expect(String(attached.bid_estimate)).toBe(String(attachedBefore.bid_estimate));
    expect((await dealRow(DETACHED)).stage_id).toBe(ST_OPPORTUNITY);

    expect(result.metrics.multiMatch).toBe(1);
    expect(result.metrics.stageUpdated).toBe(0);
    expect(result.metrics.matched).toBe(0);
    expect(result.metrics.skippedDetached).toBe(0);
  });

  it("still syncs a normal ATTACHED deal in the very same payload (the guard is not a blanket off-switch)", async () => {
    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [
        wonRow({ Name: "Attached Tower", "Project #": "DFW-1-00001-aa" }),
        wonRow({ "Project #": "DFW-2-00002-bb" }),
      ],
    });

    const attached = await dealRow(ATTACHED);
    expect(attached.stage_id).toBe(ST_WON);
    expect(attached.is_bid_board_owned).toBe(true);

    const detached = await dealRow(DETACHED);
    expect(detached.stage_id).toBe(ST_OPPORTUNITY);

    expect(result.metrics.stageUpdated).toBe(1);
    expect(result.metrics.skippedDetached).toBe(1);
    expect(result.metrics.noMatch).toBe(0);
  });

  it("persists skipped_detached_count on the run row and keeps the run status clean", async () => {
    await ingestBidBoardRows({ office_slug: "test", rows: [wonRow({ "Project #": "DFW-2-00002-bb" })] });

    const { rows } = await pg.query<{ skipped_detached_count: number; no_match_count: number; status: string; unmatched_project_numbers: string[] }>(
      `SELECT skipped_detached_count, no_match_count, status, unmatched_project_numbers
         FROM ${SCHEMA}.bid_board_sync_runs ORDER BY created_at DESC LIMIT 1`
    );
    expect(rows[0].skipped_detached_count).toBe(1);
    expect(rows[0].no_match_count).toBe(0);
    // NOT 'completed_with_unmatched' — that status is reserved for genuinely unmatched rows.
    expect(rows[0].status).toBe("success");
    expect(rows[0].unmatched_project_numbers).toEqual([]);
  });

  it("still reports a genuinely unmatched project number as noMatch", async () => {
    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [wonRow({ Name: "Nobody's Project", "Project #": "DFW-9-99999-zz" })],
    });
    expect(result.metrics.skippedDetached).toBe(0);
    expect(result.metrics.noMatch).toBe(1);
  });
});
