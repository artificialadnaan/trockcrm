import { describe, expect, it } from "vitest";
import {
  buildStageEntryCohortSql,
  buildProjectionBandsSql,
  buildProjectionCoverageSql,
  buildWeeklyCohortTrendSql,
  buildLeadStatusSql,
  eightWeekStartsEndingAt,
} from "../../../src/modules/reports/monday-showcase-service.js";
import { SENT_STAGE_SLUGS, ESTIMATED_STAGE_SLUGS } from "../../../src/modules/reports/foundations.js";
import { aliasedReportableDealFilterSql } from "../../../src/modules/shared/deal-value-sql.js";

// Walk a drizzle SQL object to plain text (incl. raw chunks + param values) so we can assert the
// F1-F5 foundations are actually composed into each query, with no DB.
function extractSqlText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.queryChunks)) return obj.queryChunks.map(extractSqlText).join(" ");
  if ("value" in obj) {
    const v = obj.value;
    if (Array.isArray(v)) return v.map(extractSqlText).join(" ");
    if (typeof v === "string") return v;
    if (v != null) return String(v);
  }
  return "";
}

describe("Monday showcase SQL builders compose F1-F5", () => {
  it("stage-entry cohort: F5 DISTINCT deal, stage-entry via to_stage_id, CT-anchored window, best-estimate $", () => {
    const text = extractSqlText(buildStageEntryCohortSql(SENT_STAGE_SLUGS, "2026-05-24", "2026-05-30"));
    expect(text).toContain("dsh.to_stage_id"); // stage-ENTRY (the new stage), not exit
    expect(text).toContain("entered.deal_id");
    expect(text).toContain("DISTINCT");
    expect(text).toContain("estimate_sent_to_client");
    expect(text).toContain("America/Chicago"); // F1 business tz on dsh.created_at
    expect(text).toContain("2026-05-24");
    // F3 open best-estimate basis (bid_board first); NOT the won awarded-first chain
    expect(text.toLowerCase()).toContain("bid_board_total_sales");
  });

  it("projection bands: F2 expected_close_date ALONE (no COALESCE), 30/60/90 CASE, terminal excluded", () => {
    const text = extractSqlText(buildProjectionBandsSql());
    expect(text).toContain("expected_close_date");
    expect(text).not.toMatch(/COALESCE\([^)]*expected_close_date[^)]*,/i); // never COALESCE'd onto another date
    expect(text).toContain("INTERVAL '30 days'");
    expect(text).toContain("INTERVAL '90 days'");
    expect(text).toContain("is_terminal = false");
  });

  it("projection coverage: N (future-dated) vs M (all open) split for the N/M caveat", () => {
    const text = extractSqlText(buildProjectionCoverageSql());
    expect(text).toContain("FILTER");
    expect(text).toContain("expected_close_date IS NOT NULL");
    expect(text).toContain("is_terminal = false");
  });

  it("weekly trend: F1 Sunday bucket + both Est and Sent cohorts, distinct deal", () => {
    const text = extractSqlText(buildWeeklyCohortTrendSql("2026-04-05", "2026-05-30"));
    expect(text).toContain("date_trunc('week'"); // F1 sundayWeekBucketSql
    expect(text).toContain("interval '1 day'");
    expect(text).toContain("DISTINCT");
    expect(text).toContain(ESTIMATED_STAGE_SLUGS[0]);
    expect(text).toContain(SENT_STAGE_SLUGS[0]);
  });

  it("weekly trend applies the SAME reportable-deal filter as the cohorts (no on-hold / non-reportable drift)", () => {
    const filterText = extractSqlText(aliasedReportableDealFilterSql("d"));
    const trend = extractSqlText(buildWeeklyCohortTrendSql("2026-04-05", "2026-05-30"));
    const cohort = extractSqlText(buildStageEntryCohortSql(SENT_STAGE_SLUGS, "2026-05-24", "2026-05-30"));
    expect(filterText.length).toBeGreaterThan(0);
    expect(cohort).toContain(filterText); // cohort already filtered
    expect(trend).toContain(filterText); // trend now matches the cohort basis
  });

  it("lead status: active (open) leads grouped by stage, per rep", () => {
    const text = extractSqlText(buildLeadStatusSql());
    expect(text).toContain("l.stage_id"); // grouped by lead stage
    expect(text).toContain("'open'");
    expect(text).toContain("l.assigned_rep_id");
    // mirrors the canonical active-lead scope so Report B counts the same leads as everywhere else
    expect(text).toContain("l.is_active = true");
    expect(text).toContain("l.is_test_data");
    expect(text).toContain("psc.workflow_family = 'lead'");
    expect(text).toContain("psc.is_terminal = false");
  });

  it("8-week trend always covers exactly 8 Sunday weeks ending at the period (zero-fill, current week last)", () => {
    const weeks = eightWeekStartsEndingAt("2026-05-24"); // a Sunday
    expect(weeks).toHaveLength(8);
    expect(weeks[7]).toBe("2026-05-24"); // current week last
    expect(weeks[0]).toBe("2026-04-05"); // 7 weeks earlier
    // strictly ascending, exactly 7 days apart
    for (let i = 1; i < weeks.length; i++) {
      const prev = new Date(`${weeks[i - 1]}T00:00:00Z`).getTime();
      const cur = new Date(`${weeks[i]}T00:00:00Z`).getTime();
      expect((cur - prev) / 86_400_000).toBe(7);
    }
  });
});
