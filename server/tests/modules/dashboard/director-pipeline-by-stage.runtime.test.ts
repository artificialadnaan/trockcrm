import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@trock-crm/shared/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * RUNTIME guard for the director Pipeline-by-Stage breakdown. getScopedPipelineSummary is the SAME
 * query whose rows reduce into the Active Pipeline KPI, so this test executes it against a faithful
 * PGlite schema and proves, with real SQL:
 *  - per-stage counts + $ are correct (shared dealValueSql resolver, awarded > bid_board_total_sales
 *    > bid_estimate > dd_estimate);
 *  - empty active-pipeline stages render as a 0/0 row (not missing);
 *  - terminal (won/lost), on-hold, and test-data deals are excluded by the active-pipeline predicate;
 *  - the per-stage totals reconcile to the overall active-pipeline number (sum of rows == the reduce
 *    buildDirectorScopeSummary feeds to the KPI) — the cross-surface drift this app is prone to.
 */

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

const { getScopedPipelineSummary } = await import("../../../src/modules/dashboard/service.js");

// Faithful column dumps (mirror production / the Drizzle schema) so a bad column reference fails here.
// pipeline_stage_config is full-SELECTed by the builder, so its column set matches the Drizzle schema.
const PIPELINE_STAGE_CONFIG_COLUMNS =
  "id uuid PRIMARY KEY, name text, slug text, display_order integer, workflow_family text, is_active_pipeline boolean, is_terminal boolean, required_fields jsonb, required_documents jsonb, required_approvals jsonb, touchpoint_cadence_days integer, stale_escalation_tiers jsonb, procore_stage_mapping text, color text";

const DEALS_COLUMNS =
  "id uuid PRIMARY KEY, deal_number text, name text, stage_id uuid, assigned_rep_id uuid, sales_source_user_id uuid, dd_estimate numeric, bid_estimate numeric, awarded_amount numeric, is_active boolean, workflow_route text, is_test_data boolean, on_hold boolean, expected_close_date date, bid_due_date timestamptz, bid_board_total_sales numeric, bid_board_stage_slug text, created_at timestamptz, updated_at timestamptz";

const OPP = "11111111-1111-1111-1111-111111111111";
const EST = "22222222-2222-2222-2222-222222222222";
const SENT = "33333333-3333-3333-3333-333333333333";
const WON = "44444444-4444-4444-4444-444444444444";

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (${PIPELINE_STAGE_CONFIG_COLUMNS});
    CREATE TABLE deals (${DEALS_COLUMNS});

    INSERT INTO pipeline_stage_config (id, slug, name, display_order, workflow_family, is_active_pipeline, is_terminal) VALUES
      ('${OPP}',  'opportunity',              'Opportunity',              1, 'standard_deal', true,  false),
      ('${EST}',  'estimating',               'Estimating',               2, 'standard_deal', true,  false),
      ('${SENT}', 'estimate_sent_to_client',  'Estimate Sent to Client',  3, 'standard_deal', true,  false),
      ('${WON}',  'won',                      'Won',                      9, 'standard_deal', false, true);

    -- Opportunity: two active deals (value from bid_estimate) -> count 2, $150,000
    INSERT INTO deals (id, deal_number, name, stage_id, is_active, workflow_route, is_test_data, on_hold, bid_estimate, created_at, updated_at) VALUES
      ('aaaa1111-0000-0000-0000-000000000001'::uuid, 'O-1', 'Opp One', '${OPP}', true, 'normal', false, false, 100000, now(), now()),
      ('aaaa1111-0000-0000-0000-000000000002'::uuid, 'O-2', 'Opp Two', '${OPP}', true, 'normal', false, false,  50000, now(), now());
    -- Opportunity: on-hold deal -> EXCLUDED from count + $ (reportable predicate on_hold=false)
    INSERT INTO deals (id, deal_number, name, stage_id, is_active, workflow_route, is_test_data, on_hold, bid_estimate, created_at, updated_at) VALUES
      ('aaaa1111-0000-0000-0000-0000000000ff'::uuid, 'O-H', 'Opp Hold', '${OPP}', true, 'normal', false, true, 999999, now(), now());

    -- Estimating: one active deal -> count 1, $200,000 (awarded outranks bid -> proves resolver chain)
    INSERT INTO deals (id, deal_number, name, stage_id, is_active, workflow_route, is_test_data, on_hold, awarded_amount, bid_estimate, created_at, updated_at) VALUES
      ('bbbb2222-0000-0000-0000-000000000001'::uuid, 'E-1', 'Est One', '${EST}', true, 'normal', false, false, 200000, 123, now(), now());
    -- Estimating: test-data deal -> EXCLUDED
    INSERT INTO deals (id, deal_number, name, stage_id, is_active, workflow_route, is_test_data, on_hold, bid_estimate, created_at, updated_at) VALUES
      ('bbbb2222-0000-0000-0000-0000000000ff'::uuid, 'E-T', 'Est Test', '${EST}', true, 'normal', true, false, 888888, now(), now());

    -- Won (terminal): active deal -> EXCLUDED (terminal stage not in active pipeline)
    INSERT INTO deals (id, deal_number, name, stage_id, is_active, workflow_route, is_test_data, on_hold, bid_estimate, created_at, updated_at) VALUES
      ('cccc4444-0000-0000-0000-000000000001'::uuid, 'W-1', 'Won One', '${WON}', true, 'normal', false, false, 777777, now(), now());

    -- estimate_sent_to_client: NO deals -> must still render as a 0/0 row.
  `);
});

afterAll(async () => {
  await pg.close();
});

describe("getScopedPipelineSummary — pipeline by stage", () => {
  it("returns active-pipeline stages in display order, with correct counts + $", async () => {
    const rows = await getScopedPipelineSummary(testDb, {});
    const byName = Object.fromEntries(rows.map((r) => [r.stageName, r]));

    expect(byName["Opportunity"]).toMatchObject({ dealCount: 2, totalValue: 150000 });
    expect(byName["Estimating"]).toMatchObject({ dealCount: 1, totalValue: 200000 });
    // Empty active stage is present as a 0/0 row, not dropped.
    expect(byName["Estimate Sent to Client"]).toMatchObject({ dealCount: 0, totalValue: 0 });

    // Ordering follows display_order.
    expect(rows.map((r) => r.stageName)).toEqual([
      "Opportunity",
      "Estimating",
      "Estimate Sent to Client",
    ]);
  });

  it("excludes terminal (won) deals from the active-pipeline breakdown", async () => {
    const rows = await getScopedPipelineSummary(testDb, {});
    expect(rows.find((r) => r.stageName === "Won")).toBeUndefined();
  });

  it("reconciles: per-stage totals sum to the overall active-pipeline number", async () => {
    const rows = await getScopedPipelineSummary(testDb, {});
    // This reduce is exactly how buildDirectorScopeSummary derives the Active Pipeline KPI.
    const total = rows.reduce(
      (acc, r) => ({ count: acc.count + r.dealCount, totalValue: acc.totalValue + r.totalValue }),
      { count: 0, totalValue: 0 }
    );
    expect(total).toEqual({ count: 3, totalValue: 350000 });
  });
});
