import { describe, expect, it } from "vitest";
import {
  buildWonEvidenceSql,
  buildStageEntryEvidenceSql,
  buildProjectionEvidenceSql,
  buildPipelineEvidenceSql,
  buildLeadEvidenceSql,
} from "../../../src/modules/reports/monday-showcase-service.js";
import { SENT_STAGE_SLUGS, ESTIMATED_STAGE_SLUGS } from "../../../src/modules/reports/foundations.js";
import { aliasedReportableDealFilterSql } from "../../../src/modules/shared/deal-value-sql.js";

// Walk a drizzle SQL object to plain text (incl. raw chunks + param values) so we can assert the
// evidence row-select queries reuse the EXACT canonical cohort predicates of their aggregates -- the
// records behind a number must be the same set the number aggregates. No DB.
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

describe("Monday showcase EVIDENCE builders reuse the aggregate cohort predicates", () => {
  it("won evidence: same predicate as getWonCloseSummary (close-date cohort, awarded-first $, on-hold/test filters)", () => {
    const text = extractSqlText(buildWonEvidenceSql("2026-05-24", "2026-05-30"));
    // close-date cohort axis (the protected 191/$9.78M basis)
    expect(text).toContain("won_closed_date");
    expect(text).toContain("2026-05-24");
    expect(text).toContain("2026-05-30");
    // awarded-first value basis (NOT best-estimate) -> awarded_amount appears first in the chain
    expect(text.toLowerCase()).toContain("awarded_amount");
    // on-hold zeroing + test-data exclusion (reportable filter)
    expect(text).toContain("on_hold");
    expect(text).toContain("is_test_data");
    // returns deal rows, not an aggregate
    expect(text).toContain("d.id");
    expect(text).toContain("d.name");
    expect(text).toContain("cohort_date");
  });

  it("won evidence: per-rep scope adds an assigned_rep filter; office scope does not", () => {
    const office = extractSqlText(buildWonEvidenceSql("2026-05-24", "2026-05-30"));
    const rep = extractSqlText(buildWonEvidenceSql("2026-05-24", "2026-05-30", "rep-1"));
    const unassigned = extractSqlText(buildWonEvidenceSql("2026-05-24", "2026-05-30", null));
    expect(office).not.toContain("assigned_rep_id =");
    expect(rep).toContain("assigned_rep_id =");
    expect(rep).toContain("rep-1");
    expect(unassigned).toContain("assigned_rep_id IS NULL");
  });

  it("region scope keys on the report's displayed-region expression (not region_id); office scope has none", () => {
    const PREDICATE = "COALESCE(NULLIF(rc.name, ''), 'Unassigned') =";
    const wonOffice = extractSqlText(buildWonEvidenceSql("2026-05-24", "2026-05-30"));
    const wonWest = extractSqlText(buildWonEvidenceSql("2026-05-24", "2026-05-30", undefined, "West Coast"));
    const wonUnassigned = extractSqlText(buildWonEvidenceSql("2026-05-24", "2026-05-30", undefined, "Unassigned"));
    // office-wide drill carries NO region predicate (reconciles to the office number)
    expect(wonOffice).not.toContain(PREDICATE);
    // a region drill keys on the SAME expression the report GROUPs by, so dup/inactive same-named configs
    // fold together exactly as the clicked row does; the param is the displayed name ("West Coast"/"Unassigned")
    expect(wonWest).toContain(PREDICATE);
    expect(wonWest).toContain("West Coast");
    expect(wonUnassigned).toContain(PREDICATE);
    expect(wonUnassigned).toContain("Unassigned");
    // the SAME region key threads through the stage-entry (sent/estimated) and projection builders
    expect(extractSqlText(buildStageEntryEvidenceSql(SENT_STAGE_SLUGS, "2026-05-24", "2026-05-30", undefined, "West Coast"))).toContain(PREDICATE);
    expect(extractSqlText(buildProjectionEvidenceSql(undefined, undefined, "West Coast"))).toContain(PREDICATE);
  });

  it("sent evidence: stage-entry cohort on to_stage_id within the CT window, best-estimate $, distinct deal", () => {
    const text = extractSqlText(buildStageEntryEvidenceSql(SENT_STAGE_SLUGS, "2026-05-24", "2026-05-30"));
    expect(text).toContain("to_stage_id"); // stage-ENTRY
    expect(text).toContain("estimate_sent_to_client"); // the sent slugs
    expect(text).toContain("bid_sent"); // legacy alias swept in
    expect(text).toContain("America/Chicago"); // F1 CT window on created_at
    expect(text).toContain("entered.deal_id"); // joins the per-deal entry set
    expect(text).toContain("GROUP BY dsh.deal_id"); // distinct deals (one row per deal)
    // open best-estimate $ (bid_board first), NOT awarded-first
    expect(text.toLowerCase()).toContain("bid_board_total_sales");
    // same reportable filter as the aggregate
    const filter = extractSqlText(aliasedReportableDealFilterSql("d"));
    expect(text).toContain(filter);
  });

  it("estimated evidence: uses the estimating slugs (incl. legacy estimate_in_progress)", () => {
    const text = extractSqlText(buildStageEntryEvidenceSql(ESTIMATED_STAGE_SLUGS, "2026-05-24", "2026-05-30"));
    expect(text).toContain("estimating");
    expect(text).toContain("estimate_in_progress");
  });

  it("projection evidence: open + future-dated + non-terminal + active (same as the bands aggregate)", () => {
    const text = extractSqlText(buildProjectionEvidenceSql());
    expect(text).toContain("expected_close_date");
    expect(text).toContain("is_terminal = false");
    expect(text).toContain("d.is_active = true");
    // future-dated predicate (N): close date not null and >= today
    expect(text).toContain("IS NOT NULL");
    // best-estimate basis
    expect(text.toLowerCase()).toContain("bid_board_total_sales");
  });

  it("pipeline evidence: ALL open deals (active, non-terminal, reportable) — NOT future-dated, so it reconciles to the region 'Open Pipeline'", () => {
    const text = extractSqlText(buildPipelineEvidenceSql());
    expect(text).toContain("d.is_active = true");
    expect(text).toContain("is_terminal = false");
    // open best-estimate basis (bid-board first), same as the region report's openVal
    expect(text.toLowerCase()).toContain("bid_board_total_sales");
    // crucially NOT future-dated — pipeline is the full open snapshot, unlike the projection metric
    expect(text).not.toContain("future");
  });

  it("pipeline evidence: a stageSlug narrows to one stage (reconciles to a single region×stage heatmap cell)", () => {
    const text = extractSqlText(buildPipelineEvidenceSql(undefined, "West Coast", "estimating"));
    expect(text).toContain("psc.slug =");
    expect(text).toContain("estimating");
    expect(text).toContain("COALESCE(NULLIF(rc.name, ''), 'Unassigned') ="); // region key still applied
  });

  it("projection evidence: a band scope narrows to exactly that 30/60/90 rung", () => {
    const text = extractSqlText(buildProjectionEvidenceSql(undefined, "31_60"));
    expect(text).toContain("31_60");
    // the band CASE is reused to filter
    expect(text).toContain("INTERVAL '60 days'");
  });

  it("lead evidence: same active-open-lead scope as buildLeadStatusSql (no deal value)", () => {
    const text = extractSqlText(buildLeadEvidenceSql());
    expect(text).toContain("l.is_active = true");
    expect(text).toContain("'open'");
    expect(text).toContain("workflow_family = 'lead'");
    expect(text).toContain("is_terminal = false");
    expect(text).toContain("l.is_test_data");
  });

  it("deal evidence carries the actionable drill columns (company, region, type, age) via ADDITIVE LEFT JOINs", () => {
    // The drill-down needs more than name+number: who owns it, how much, where, what type, how long it's
    // sat. These are SELECT additions + 1:1 LEFT JOINs (companies, region_config) -- the cohort WHERE is
    // untouched, so the records still reconcile to the number.
    for (const text of [
      extractSqlText(buildWonEvidenceSql("2026-05-24", "2026-05-30")),
      extractSqlText(buildStageEntryEvidenceSql(SENT_STAGE_SLUGS, "2026-05-24", "2026-05-30")),
      extractSqlText(buildProjectionEvidenceSql()),
    ]) {
      expect(text).toContain("company_name");
      expect(text).toContain("AS region");
      expect(text).toContain("deal_type");
      expect(text).toContain("days_in_stage");
      // age anchored to the America/Chicago business date (not raw session-TZ CURRENT_DATE)
      expect(text).toContain("America/Chicago");
      expect(text).toContain("LEFT JOIN companies c ON c.id = d.company_id");
      expect(text).toContain("LEFT JOIN region_config rc ON rc.id = d.region_id");
      // Type prefers the canonical project_type_config name over the legacy project_type text
      expect(text).toContain("LEFT JOIN public.project_type_config ptc ON ptc.id = d.project_type_id");
      expect(text).toContain("ptc.name");
    }
    // The Won cohort predicate is unchanged alongside the new columns (still the protected close-date guard).
    const won = extractSqlText(buildWonEvidenceSql("2026-05-24", "2026-05-30"));
    expect(won).toContain("won_closed_date");
  });

  it("lead evidence carries company/type/age too (region via the company; no region_config join)", () => {
    const text = extractSqlText(buildLeadEvidenceSql());
    expect(text).toContain("company_name");
    expect(text).toContain("deal_type");
    expect(text).toContain("days_in_stage");
    expect(text).toContain("LEFT JOIN companies c ON c.id = l.company_id");
    expect(text).toContain("LEFT JOIN public.project_type_config ptc ON ptc.id = l.project_type_id");
    // leads have no region_id -> region comes from the company only, no region_config join
    expect(text).not.toContain("region_config");
  });
});
