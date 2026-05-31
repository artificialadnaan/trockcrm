import { describe, expect, it } from "vitest";
import {
  buildStageEntryCohortSql,
  buildProjectionBandsSql,
  buildProjectionCoverageSql,
  buildWeeklyCohortTrendSql,
  buildLeadStatusSql,
} from "../../../src/modules/reports/monday-showcase-service.js";
import { SENT_STAGE_SLUGS, ESTIMATED_STAGE_SLUGS } from "../../../src/modules/reports/foundations.js";

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

  it("lead status: active (open) leads grouped by stage, per rep", () => {
    const text = extractSqlText(buildLeadStatusSql());
    expect(text).toContain("l.stage_id"); // grouped by lead stage
    expect(text).toContain("'open'");
    expect(text).toContain("l.assigned_rep_id");
  });
});
