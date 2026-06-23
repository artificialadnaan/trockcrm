import { describe, expect, it } from "vitest";
import {
  PROJECTION_WINDOW_DAYS,
  futureDatedCloseDatePredicateSql,
  projectionBandSql,
  formatProjectionCoverageCaption,
  DEAL_VALUE_BASIS_LABEL,
  dealValueSqlForBasis,
  BACKFILL_SPIKE_WEEK_START,
  excludeBackfillSpikeWeekPredicateSql,
  distinctDealCountSql,
  SENT_STAGE_SLUGS,
  ESTIMATED_STAGE_SLUGS,
} from "../../../src/modules/reports/foundations.js";

// Same SQL-text extractor used across the server query-builder tests (no DB needed).
function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }
  return "";
}

// ---------------- F2: projection 30/60/90 + N/M coverage ----------------
describe("F2 projection", () => {
  it("future-dated predicate uses expected_close_date ALONE (no COALESCE), today-or-future, CT-anchored by default", () => {
    const text = extractSqlText(futureDatedCloseDatePredicateSql("d.expected_close_date"));
    expect(text).toContain("d.expected_close_date IS NOT NULL");
    expect(text).toContain("d.expected_close_date >=");
    expect(text).not.toMatch(/COALESCE/i); // must not fall back onto won/other dates
    expect(text).toContain("America/Chicago"); // CT-anchored today, consistent with F1
  });

  it("projection band buckets into 0_30 / 31_60 / 61_90 / beyond_90, NULL for none/past", () => {
    const text = extractSqlText(projectionBandSql("d.expected_close_date"));
    expect(text).toContain("CASE");
    expect(PROJECTION_WINDOW_DAYS).toEqual([30, 60, 90]);
    expect(text).toContain("INTERVAL '30 days'");
    expect(text).toContain("INTERVAL '60 days'");
    expect(text).toContain("INTERVAL '90 days'");
    expect(text).toContain("'0_30'");
    expect(text).toContain("'beyond_90'");
  });

  it("a 'today' override is emitted as a bound DATE literal (never raw text), and a bad date is rejected", () => {
    const pred = extractSqlText(futureDatedCloseDatePredicateSql("d.expected_close_date", "2026-05-31"));
    expect(pred).toContain("DATE '2026-05-31'"); // valid date literal, not a bare 2026-05-31
    expect(pred).not.toMatch(/>=\s*2026-05-31\b/); // never the invalid bare form
    const band = extractSqlText(projectionBandSql("d.expected_close_date", "2026-05-31"));
    expect(band).toContain("DATE '2026-05-31'");
    // guards against injection / malformed input on the interpolated path
    expect(() => projectionBandSql("d.expected_close_date", "not-a-date")).toThrow();
    expect(() => futureDatedCloseDatePredicateSql("d.expected_close_date", "'); DROP TABLE deals;--")).toThrow();
  });

  it("coverage caption is literally honest and grammatical", () => {
    expect(formatProjectionCoverageCaption({ n: 15, m: 319 })).toBe(
      "15 of 319 open deals have a maintained (future-dated) expected close date."
    );
    expect(formatProjectionCoverageCaption({ n: 1, m: 1 })).toBe(
      "1 of 1 open deal has a maintained (future-dated) expected close date."
    );
    expect(formatProjectionCoverageCaption({ n: 0, m: 5 })).toBe(
      "0 of 5 open deals have a maintained (future-dated) expected close date."
    );
    expect(formatProjectionCoverageCaption({ n: 0, m: 0 })).toBe("No open deals in scope.");
  });
});

// ---------------- F3: value-label discipline ----------------
describe("F3 value basis", () => {
  it("unifies both value bases to awarded-first (convention shift 2026-06-18)", () => {
    const won = extractSqlText(dealValueSqlForBasis("d", "won_awarded_first")).toLowerCase();
    const open = extractSqlText(dealValueSqlForBasis("d", "open_best_estimate")).toLowerCase();
    // Both bases are now awarded-FIRST: awarded_amount precedes bid_board_total_sales in the COALESCE chain.
    expect(won.indexOf("awarded_amount")).toBeLessThan(won.indexOf("bid_board_total_sales"));
    expect(open.indexOf("awarded_amount")).toBeLessThan(open.indexOf("bid_board_total_sales"));
    // Both bases resolve through the SAME awarded-first VALUE chain (DEAL_VALUE_PRIORITY_CHAIN); the basis
    // is a labeling/context selector. They now differ ONLY in the on-hold ZEROING wrapper: the Won basis
    // zeros on the stored on_hold flag ALONE (realized revenue is never auto-parked by a stale forecast),
    // while the open basis ALSO zeros a far-out (90+ day) close target (effective hold). See deal-value-sql.
    expect(won.indexOf("bid_board_total_sales")).toBeLessThan(won.indexOf("bid_estimate"));
    expect(open.indexOf("bid_board_total_sales")).toBeLessThan(open.indexOf("bid_estimate"));
    // BOTH bases zero out the stored on-hold value.
    expect(won).toContain("on_hold");
    expect(open).toContain("on_hold");
    // ONLY the open basis carries the far-future auto-park leg; the Won basis must NOT (P1: realized-safe).
    expect(open).toContain("expected_close_date");
    expect(won).not.toContain("expected_close_date");
  });

  it("labels every basis", () => {
    expect(DEAL_VALUE_BASIS_LABEL.won_awarded_first).toBeTruthy();
    expect(DEAL_VALUE_BASIS_LABEL.open_best_estimate).toBeTruthy();
  });
});

// ---------------- F4: backfill spike exclusion ----------------
describe("F4 backfill spike", () => {
  it("excludes the 2026-05-17 stage-history spike week from trends", () => {
    expect(BACKFILL_SPIKE_WEEK_START).toBe("2026-05-17");
    const text = extractSqlText(excludeBackfillSpikeWeekPredicateSql("week_start"));
    expect(text).toContain("2026-05-17");
    expect(text).toContain("<>");
  });
});

// ---------------- F5: distinct-deal counting ----------------
describe("F5 distinct counting", () => {
  it("counts distinct deals (a deal re-entering a stage must not double-count)", () => {
    expect(extractSqlText(distinctDealCountSql()).replace(/\s+/g, " ")).toContain("COUNT(DISTINCT deal_id)");
    expect(extractSqlText(distinctDealCountSql("h.deal_id")).replace(/\s+/g, " ")).toContain("COUNT(DISTINCT h.deal_id)");
  });
});

// ---------------- week stage-entry cohorts ----------------
describe("week stage-entry cohorts", () => {
  it("Sent / Estimated slug sets match the active platform slugs", () => {
    // SENT includes the legacy `bid_sent` alias (migration 0053 -> canonical estimate_sent_to_client);
    // ESTIMATED includes the legacy pre-0064 `estimate_in_progress` alias -- so historical/backfilled
    // stage-entry rows that still point at the inactive aliases aren't undercounted.
    expect(SENT_STAGE_SLUGS).toEqual(["estimate_sent_to_client", "service_estimate_sent_to_client", "bid_sent"]);
    expect(ESTIMATED_STAGE_SLUGS).toEqual(["estimating", "service_estimating", "estimate_in_progress"]);
  });
});
