import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEffectiveDealValue } from "@trock-crm/shared/types";
import { aliasedStageAwareEffectiveDealValueSql } from "../../../src/modules/deals/deal-filter-predicates.js";

/**
 * RECONCILIATION lock for the running-total card (#4): the value-total card sums
 * aliasedStageAwareEffectiveDealValueSql over the list's WHERE. This proves — against real SQL —
 * that that SUM equals the sum of what each row DISPLAYS (the client's getEffectiveDealValue), so
 * the total and the list can NEVER disagree:
 *  - ALL rows (open AND Won) use the SAME unified awarded-first chain (awarded → bid_board → bid → dd)
 *    as of the 2026-06-18 convention shift — open and Won no longer diverge by value;
 *  - on_hold rows are 0 (matching the list's $0 display, while still being counted/summed);
 *  - $0 / all-null rows contribute 0;
 *  - an ESTIMATING row auto-parks off its BID due date rather than its close target (2026-07-27), and the
 *    SQL (pipeline_stage_config subselect) and the client (route-aware slug) must agree on that row-for-row.
 * The per-row assertion (SQL value == getEffectiveDealValue) is the byte-for-byte guarantee;
 * the SUM assertion proves the aggregate the card reads.
 */

const dialect = new PgDialect();
const WON_STAGE_IDS = ["won"];
const ESTIMATING_STAGE_IDS = ["estimating"];
const LOST_STAGE_IDS = ["lost"];

// stageSlug/workflowRoute drive the CLIENT's Won classification (isGenuineWonDealStageSlug);
// stage_id IN WON_STAGE_IDS drives the SERVER's. They are aligned here (won rows: slug "won",
// id "won") exactly as production aligns wonStageIds (Won-family slugs -> ids) with the client.
const ROWS = [
  // open, no awarded -> unified awarded-first chain falls through to bid_board_total_sales
  { id: "open_bb", stage_id: "opportunity", stageSlug: "opportunity", on_hold: false, bid_board_total_sales: 300000, bid_estimate: 200000, dd_estimate: 100000, awarded_amount: 0, expected: 300000 },
  // open WITH awarded set -> unified awarded-first picks awarded over the higher bid_board (proves the 2026-06-18 shift)
  { id: "open_awarded", stage_id: "opportunity", stageSlug: "opportunity", on_hold: false, bid_board_total_sales: 200000, bid_estimate: 100000, dd_estimate: 50000, awarded_amount: 400000, expected: 400000 },
  // open, falls through to dd_estimate
  { id: "open_dd", stage_id: "opportunity", stageSlug: "opportunity", on_hold: false, bid_board_total_sales: 0, bid_estimate: 0, dd_estimate: 80000, awarded_amount: 0, expected: 80000 },
  // estimating, bid + DD set, no awarded -> DD OUTRANKS bid (awarded>dd>bid), so 200000 not 300000 (2026-06-18 rule)
  { id: "est_dd", stage_id: "estimating", stageSlug: "estimating", on_hold: false, bid_board_total_sales: 300000, bid_estimate: 280000, dd_estimate: 200000, awarded_amount: 0, expected: 200000 },
  // estimating, bid only (no DD) -> bid is the FALLBACK, not skipped: 150000 not $0
  { id: "est_bid_only", stage_id: "estimating", stageSlug: "estimating", on_hold: false, bid_board_total_sales: 150000, bid_estimate: 0, dd_estimate: 0, awarded_amount: 0, expected: 150000 },
  // won, awarded-first picks awarded_amount even though bid_board is also set
  { id: "won_awarded", stage_id: "won", stageSlug: "won", on_hold: false, bid_board_total_sales: 250000, bid_estimate: 0, dd_estimate: 0, awarded_amount: 500000, expected: 500000 },
  // won, awarded missing -> falls back to bid_board within the awarded-first chain
  { id: "won_fallback", stage_id: "won", stageSlug: "won", on_hold: false, bid_board_total_sales: 120000, bid_estimate: 0, dd_estimate: 0, awarded_amount: 0, expected: 120000 },
  // on hold -> 0 regardless of a large raw value (shown as $0 in the list, summed as 0)
  { id: "onhold", stage_id: "opportunity", stageSlug: "opportunity", on_hold: true, bid_board_total_sales: 999999, bid_estimate: 0, dd_estimate: 0, awarded_amount: 0, expected: 0 },
  // genuinely $0
  { id: "zero", stage_id: "opportunity", stageSlug: "opportunity", on_hold: false, bid_board_total_sales: 0, bid_estimate: 0, dd_estimate: 0, awarded_amount: 0, expected: 0 },
  // OPEN deal with a close target far past the 90-day horizon -> effectively on hold -> 0 (auto-park).
  { id: "open_far_future", stage_id: "opportunity", stageSlug: "opportunity", on_hold: false, bid_board_total_sales: 400000, bid_estimate: 0, dd_estimate: 0, awarded_amount: 0, expected_close_date: "2099-12-31", expected: 0 },
  // WON EARLY while the forecast date is still far out -> realized revenue, NOT auto-parked: keeps its
  // value (the won path stamps the won date but doesn't clear expected_close_date). Guards the P1.
  { id: "won_far_future", stage_id: "won", stageSlug: "won", on_hold: false, bid_board_total_sales: 0, bid_estimate: 0, dd_estimate: 0, awarded_amount: 300000, expected_close_date: "2099-12-31", expected: 300000 },
  // LOST with a far-out forecast date -> PRESERVED for Loss Analysis, NOT auto-parked to $0 (a lost bid is
  // realized history; only its stored on_hold flag would zero it). Guards Codex P2 — the lost branch.
  { id: "lost_far_future", stage_id: "lost", stageSlug: "lost", on_hold: false, bid_board_total_sales: 0, bid_estimate: 0, dd_estimate: 0, awarded_amount: 250000, expected_close_date: "2099-12-31", expected: 250000 },
  // LOST, normal (near) forecast -> awarded-first chain, falls through to bid_board.
  { id: "lost_normal", stage_id: "lost", stageSlug: "lost", on_hold: false, bid_board_total_sales: 60000, bid_estimate: 0, dd_estimate: 0, awarded_amount: 0, expected: 60000 },
  // LOST but explicitly on hold -> stored flag still zeros even a terminal deal (matches the client).
  { id: "lost_onhold", stage_id: "lost", stageSlug: "lost", on_hold: true, bid_board_total_sales: 100000, bid_estimate: 0, dd_estimate: 0, awarded_amount: 0, expected: 0 },
  // Bid Board-owned: CRM stage_id still OPEN (opportunity) but the BB mirror is terminal (won) with a
  // far-out forecast date -> realized/preserved, NOT auto-parked to $0 (Codex P2 — BB-mirror in the value
  // CASE's open branch). Client classifies it terminal via bidBoardStageSlug.
  { id: "bb_mirror_far", stage_id: "opportunity", stageSlug: "opportunity", bidBoardStageSlug: "won", on_hold: false, bid_board_total_sales: 175000, bid_estimate: 0, dd_estimate: 0, awarded_amount: 0, expected_close_date: "2099-12-31", expected: 175000 },
  // ESTIMATING with a NEAR close target but a FAR BID due date -> auto-parked to $0 (2026-07-27). Under the
  // old close-target-only rule this row was worth its full DD value, so this is the direction that removes
  // dollars from every pipeline total.
  { id: "est_far_bid", stage_id: "estimating", stageSlug: "estimating", on_hold: false, bid_board_total_sales: 0, bid_estimate: 0, dd_estimate: 220000, awarded_amount: 0, expected_close_date: "2026-08-01", bid_due_date: "2099-12-31T00:00:00.000Z", expected: 0 },
  // ESTIMATING with a FAR close target but a NEAR BID due date -> RELEASED back to full value. Under the old
  // rule the far-out close target parked it at $0; a live bid is not a parked deal.
  { id: "est_near_bid", stage_id: "estimating", stageSlug: "estimating", on_hold: false, bid_board_total_sales: 0, bid_estimate: 0, dd_estimate: 190000, awarded_amount: 0, expected_close_date: "2099-12-31", bid_due_date: "2026-08-01T00:00:00.000Z", expected: 190000 },
  // ESTIMATING with NO bid due date -> falls back to the close target, reproducing the old behaviour exactly
  // (the NULL policy: bid_due_date is null on ~91% of prod deals, so "no bid date => never park" would
  // release millions of stale forecast dollars).
  { id: "est_null_bid", stage_id: "estimating", stageSlug: "estimating", on_hold: false, bid_board_total_sales: 0, bid_estimate: 0, dd_estimate: 160000, awarded_amount: 0, expected_close_date: "2099-12-31", expected: 0 },
];

const EXPECTED_TOTAL = ROWS.reduce((sum, row) => sum + row.expected, 0); // 2,250,000

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    -- pipeline_stage_config lives ONLY in \`public\` in prod, and the shared effective-on-hold predicate
    -- subselects it to detect the estimating stage (whose auto-park horizon is bid_due_date, not the close
    -- target). PGlite's default schema IS public, so a bare CREATE TABLE reproduces prod's placement.
    CREATE TABLE pipeline_stage_config (id text PRIMARY KEY, slug text NOT NULL);
    INSERT INTO pipeline_stage_config (id, slug) VALUES
      ('opportunity', 'opportunity'), ('estimating', 'estimating'), ('won', 'won'), ('lost', 'lost');
    CREATE TABLE deals (
      id text PRIMARY KEY, sales_source_user_id uuid,
      stage_id text NOT NULL,
      bid_board_stage_slug text,
      on_hold boolean NOT NULL DEFAULT false,
      expected_close_date date, bid_due_date timestamptz,
      bid_board_total_sales numeric,
      bid_estimate numeric,
      dd_estimate numeric,
      awarded_amount numeric
    );
  `);
  for (const r of ROWS) {
    await db.query(
      `INSERT INTO deals (id, stage_id, bid_board_stage_slug, on_hold, expected_close_date, bid_due_date, bid_board_total_sales, bid_estimate, dd_estimate, awarded_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [r.id, r.stage_id, ("bidBoardStageSlug" in r ? (r as { bidBoardStageSlug?: string }).bidBoardStageSlug : null) ?? null, r.on_hold, ("expected_close_date" in r ? r.expected_close_date : null) ?? null, ("bid_due_date" in r ? (r as { bid_due_date?: string }).bid_due_date : null) ?? null, r.bid_board_total_sales, r.bid_estimate, r.dd_estimate, r.awarded_amount]
    );
  }
});

afterAll(async () => {
  await db?.close();
});

describe("value-total SQL — running-total card reconciliation (#4)", () => {
  it("SUM(stage-aware effective value) over the set equals the hand-computed total", async () => {
    const expr = dialect.sqlToQuery(aliasedStageAwareEffectiveDealValueSql("deals", WON_STAGE_IDS, ESTIMATING_STAGE_IDS, LOST_STAGE_IDS));
    const { rows } = await db.query<{ total: string }>(
      `SELECT coalesce(sum(${expr.sql}), 0) AS total FROM deals`,
      expr.params as unknown[]
    );
    expect(Number(rows[0].total)).toBe(EXPECTED_TOTAL);
  });

  it("each row's SQL effective value equals the client's getEffectiveDealValue (display == sum basis)", async () => {
    const expr = dialect.sqlToQuery(aliasedStageAwareEffectiveDealValueSql("deals", WON_STAGE_IDS, ESTIMATING_STAGE_IDS, LOST_STAGE_IDS));
    const { rows } = await db.query<{ id: string; v: string }>(
      `SELECT id, (${expr.sql}) AS v FROM deals ORDER BY id`,
      expr.params as unknown[]
    );
    const sqlById = new Map(rows.map((r) => [r.id, Number(r.v)]));

    let clientSum = 0;
    for (const r of ROWS) {
      const clientValue = getEffectiveDealValue({
        onHold: r.on_hold,
        expectedCloseDate: ("expected_close_date" in r ? r.expected_close_date : null) ?? null,
        bidDueDate: ("bid_due_date" in r ? (r as { bid_due_date?: string }).bid_due_date : null) ?? null,
        stageSlug: r.stageSlug,
        bidBoardStageSlug: ("bidBoardStageSlug" in r ? (r as { bidBoardStageSlug?: string }).bidBoardStageSlug : null) ?? null,
        workflowRoute: "normal",
        awardedAmount: r.awarded_amount,
        bidBoardTotalSales: r.bid_board_total_sales,
        bidEstimate: r.bid_estimate,
        ddEstimate: r.dd_estimate,
      });
      clientSum += clientValue;
      // per-row: the value the list DISPLAYS == the value the card SUMS, for every classification.
      expect(sqlById.get(r.id), `row ${r.id}`).toBe(clientValue);
      expect(clientValue, `row ${r.id}`).toBe(r.expected);
    }
    // and the aggregate the card reads reconciles to the per-row display sum.
    expect(clientSum).toBe(EXPECTED_TOTAL);
  });
});
