import { describe, expect, it } from "vitest";
import {
  DEAL_VALUE_PRIORITY_CHAIN,
  ESTIMATING_VALUE_CHAIN,
  aliasedDealBestEstimateSqlText,
  aliasedDealEstimatingValueSqlText,
  dealValueChainSqlText,
} from "./deal-value-sql-text.js";

/**
 * These builders had NO test before the chains moved here — `grep` for either name found only the two
 * production call sites. The change-order branch in particular has been unpinned since it was written, and
 * the server's own comment records that the first draft of it shipped WITHOUT that branch. A pure string
 * builder's output IS the artifact, so exact equality is the right assertion.
 */

const candidate = (column: string) => `CASE WHEN d.${column} > 0 THEN d.${column} END`;
const chainOf = (columns: readonly string[]) =>
  `CASE WHEN COALESCE(d.is_change_order, false) THEN COALESCE(d.awarded_amount, 0) ` +
  `ELSE COALESCE(${columns.map(candidate).join(", ")}, 0) END`;

describe("deal value chains", () => {
  it("orders the DEFAULT chain awarded > bid_board > bid > dd", () => {
    expect([...DEAL_VALUE_PRIORITY_CHAIN]).toEqual([
      "awarded_amount",
      "bid_board_total_sales",
      "bid_estimate",
      "dd_estimate",
    ]);
  });

  it("orders the ESTIMATING chain awarded > dd > bid_board > bid", () => {
    expect([...ESTIMATING_VALUE_CHAIN]).toEqual([
      "awarded_amount",
      "dd_estimate",
      "bid_board_total_sales",
      "bid_estimate",
    ]);
  });

  it("DIFFERS from the default chain exactly where DD and the Bid Board total swap", () => {
    // The property that makes an email and its click-through able to disagree. A deal carrying BOTH a DD
    // estimate and a Bid Board total resolves to different money under the two chains, which is why the
    // surface a number has to reconcile with decides which chain it is drawn from.
    const dd = ESTIMATING_VALUE_CHAIN.indexOf("dd_estimate");
    const board = ESTIMATING_VALUE_CHAIN.indexOf("bid_board_total_sales");
    expect(dd).toBeLessThan(board);
    const defaultDd = DEAL_VALUE_PRIORITY_CHAIN.indexOf("dd_estimate");
    const defaultBoard = DEAL_VALUE_PRIORITY_CHAIN.indexOf("bid_board_total_sales");
    expect(defaultBoard).toBeLessThan(defaultDd);
    // Awarded still leads both.
    expect(ESTIMATING_VALUE_CHAIN[0]).toBe("awarded_amount");
    expect(DEAL_VALUE_PRIORITY_CHAIN[0]).toBe("awarded_amount");
  });
});

describe("dealValueChainSqlText", () => {
  it("renders the awarded-first chain", () => {
    expect(aliasedDealBestEstimateSqlText("d")).toBe(chainOf(DEAL_VALUE_PRIORITY_CHAIN));
  });

  it("renders the estimating chain", () => {
    expect(aliasedDealEstimatingValueSqlText("d")).toBe(chainOf(ESTIMATING_VALUE_CHAIN));
  });

  it("takes a CHANGE ORDER's awarded_amount verbatim, ahead of the > 0 chain", () => {
    // A deductive CO carries its value NEGATIVE, and every `> 0` candidate drops a negative — so without
    // this branch the deduction reports as $0 on exactly the rows where being wrong is most visible.
    // Provably inert for a positive CO, whose awarded_amount was already the only candidate that matched.
    for (const rendered of [aliasedDealEstimatingValueSqlText("d"), aliasedDealBestEstimateSqlText("d")]) {
      expect(rendered).toContain("CASE WHEN COALESCE(d.is_change_order, false) THEN COALESCE(d.awarded_amount, 0)");
      expect(rendered.startsWith("CASE WHEN COALESCE(d.is_change_order, false)")).toBe(true);
    }
  });

  it("gates every candidate on > 0, so both NULL and 0 fall through", () => {
    const rendered = aliasedDealEstimatingValueSqlText("d");
    for (const column of ESTIMATING_VALUE_CHAIN) {
      expect(rendered).toContain(candidate(column));
    }
    // The chain's final fallback, so the expression is never NULL.
    expect(rendered).toContain(", 0) END");
  });

  it("honours the caller's alias", () => {
    expect(aliasedDealEstimatingValueSqlText("deals")).toContain("deals.dd_estimate");
  });

  it("rejects an alias that is not a plain identifier", () => {
    expect(() => aliasedDealEstimatingValueSqlText("d; DROP TABLE deals")).toThrow();
    expect(() => aliasedDealBestEstimateSqlText("d; DROP TABLE deals")).toThrow();
    expect(() => dealValueChainSqlText("d-1", ESTIMATING_VALUE_CHAIN)).toThrow();
  });
});
