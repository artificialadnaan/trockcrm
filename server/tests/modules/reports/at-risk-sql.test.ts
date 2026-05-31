import { describe, expect, it } from "vitest";
import { buildAtRiskDealsSql } from "../../../src/modules/reports/at-risk-service.js";
import { aliasedReportableDealFilterSql } from "../../../src/modules/shared/deal-value-sql.js";

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

describe("buildAtRiskDealsSql — the forecast blind spots (M − N), same scope as projection coverage", () => {
  it("uses the IDENTICAL open-deal scope as the coverage aggregate, then excludes future-dated", () => {
    const text = extractSqlText(buildAtRiskDealsSql());
    // same scope as buildProjectionCoverageSql (so at-risk count === M − N)
    expect(text).toContain("d.is_active = true");
    expect(text).toContain("is_terminal = false");
    expect(text).toContain("is_test_data");
    expect(text).toContain(extractSqlText(aliasedReportableDealFilterSql("d")));
    // the future-dated predicate is NEGATED (CT-anchored), so only NULL/past-dated remain
    expect(text).toContain("America/Chicago");
    expect(text).toContain("expected_close_date");
    expect(text).toMatch(/NOT\s*\(/i);
  });

  it("returns rows with $ at risk (best-estimate basis), a reason, days-in-stage", () => {
    const text = extractSqlText(buildAtRiskDealsSql());
    expect(text.toLowerCase()).toContain("bid_board_total_sales"); // F3 best-estimate chain
    expect(text).toContain("AS value");
    expect(text).toContain("reason");
    expect(text).toContain("stage_entered_at");
    expect(text).toContain("d.id");
  });

  it("a rep scope narrows by assigned_rep; office (no arg) does not", () => {
    expect(extractSqlText(buildAtRiskDealsSql())).not.toContain("assigned_rep_id =");
    expect(extractSqlText(buildAtRiskDealsSql("rep-9"))).toContain("assigned_rep_id =");
    expect(extractSqlText(buildAtRiskDealsSql(null))).toContain("assigned_rep_id IS NULL");
  });
});
