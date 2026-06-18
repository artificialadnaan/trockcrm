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
 *  - $0 / all-null rows contribute 0.
 * The per-row assertion (SQL value == getEffectiveDealValue) is the byte-for-byte guarantee;
 * the SUM assertion proves the aggregate the card reads.
 */

const dialect = new PgDialect();
const WON_STAGE_IDS = ["won"];

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
  // won, awarded-first picks awarded_amount even though bid_board is also set
  { id: "won_awarded", stage_id: "won", stageSlug: "won", on_hold: false, bid_board_total_sales: 250000, bid_estimate: 0, dd_estimate: 0, awarded_amount: 500000, expected: 500000 },
  // won, awarded missing -> falls back to bid_board within the awarded-first chain
  { id: "won_fallback", stage_id: "won", stageSlug: "won", on_hold: false, bid_board_total_sales: 120000, bid_estimate: 0, dd_estimate: 0, awarded_amount: 0, expected: 120000 },
  // on hold -> 0 regardless of a large raw value (shown as $0 in the list, summed as 0)
  { id: "onhold", stage_id: "opportunity", stageSlug: "opportunity", on_hold: true, bid_board_total_sales: 999999, bid_estimate: 0, dd_estimate: 0, awarded_amount: 0, expected: 0 },
  // genuinely $0
  { id: "zero", stage_id: "opportunity", stageSlug: "opportunity", on_hold: false, bid_board_total_sales: 0, bid_estimate: 0, dd_estimate: 0, awarded_amount: 0, expected: 0 },
];

const EXPECTED_TOTAL = ROWS.reduce((sum, row) => sum + row.expected, 0); // 1,400,000

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE deals (
      id text PRIMARY KEY,
      stage_id text NOT NULL,
      on_hold boolean NOT NULL DEFAULT false,
      bid_board_total_sales numeric,
      bid_estimate numeric,
      dd_estimate numeric,
      awarded_amount numeric
    );
  `);
  for (const r of ROWS) {
    await db.query(
      `INSERT INTO deals (id, stage_id, on_hold, bid_board_total_sales, bid_estimate, dd_estimate, awarded_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [r.id, r.stage_id, r.on_hold, r.bid_board_total_sales, r.bid_estimate, r.dd_estimate, r.awarded_amount]
    );
  }
});

afterAll(async () => {
  await db?.close();
});

describe("value-total SQL — running-total card reconciliation (#4)", () => {
  it("SUM(stage-aware effective value) over the set equals the hand-computed total", async () => {
    const expr = dialect.sqlToQuery(aliasedStageAwareEffectiveDealValueSql("deals", WON_STAGE_IDS));
    const { rows } = await db.query<{ total: string }>(
      `SELECT coalesce(sum(${expr.sql}), 0) AS total FROM deals`,
      expr.params as unknown[]
    );
    expect(Number(rows[0].total)).toBe(EXPECTED_TOTAL);
  });

  it("each row's SQL effective value equals the client's getEffectiveDealValue (display == sum basis)", async () => {
    const expr = dialect.sqlToQuery(aliasedStageAwareEffectiveDealValueSql("deals", WON_STAGE_IDS));
    const { rows } = await db.query<{ id: string; v: string }>(
      `SELECT id, (${expr.sql}) AS v FROM deals ORDER BY id`,
      expr.params as unknown[]
    );
    const sqlById = new Map(rows.map((r) => [r.id, Number(r.v)]));

    let clientSum = 0;
    for (const r of ROWS) {
      const clientValue = getEffectiveDealValue({
        onHold: r.on_hold,
        stageSlug: r.stageSlug,
        workflowRoute: "normal",
        awardedAmount: r.awarded_amount,
        bidBoardTotalSales: r.bid_board_total_sales,
        bidEstimate: r.bid_estimate,
        ddEstimate: r.dd_estimate,
      });
      clientSum += clientValue;
      // per-row: the value the list DISPLAYS == the value the card SUMS, for every classification.
      expect(sqlById.get(r.id)).toBe(clientValue);
      expect(clientValue).toBe(r.expected);
    }
    // and the aggregate the card reads reconciles to the per-row display sum.
    expect(clientSum).toBe(EXPECTED_TOTAL);
  });
});
