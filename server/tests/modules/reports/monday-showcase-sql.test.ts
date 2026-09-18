import { describe, expect, it } from "vitest";
import {
  buildStageEntryCohortSql,
  buildProjectionBandsSql,
  buildProjectionCoverageSql,
  buildWeeklyCohortTrendSql,
  buildLeadStatusSql,
  buildWonEvidenceSql,
  buildStageEntryEvidenceSql,
  buildProjectionEvidenceSql,
  buildUndatedEvidenceSql,
  buildStaleEvidenceSql,
  buildNoDateEvidenceSql,
  buildPipelineEvidenceSql,
  buildLeadEvidenceSql,
  buildCurrentEstimatingProjectsSql,
  buildRfpInitiatedProjectsSql,
  buildEstimateSentProjectsSql,
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
    expect(text).toContain("d.is_active = true"); // inactive/archived deals must not inflate the bands
  });

  it("projection coverage: N (future-dated) vs M (all open) split for the N/M caveat", () => {
    const text = extractSqlText(buildProjectionCoverageSql());
    expect(text).toContain("FILTER");
    expect(text).toContain("expected_close_date IS NOT NULL");
    expect(text).toContain("is_terminal = false");
    expect(text).toContain("d.is_active = true"); // inactive deals excluded from the N/M denominator too
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

  it("A1 current estimating is a live effective-stage snapshot with direct DD and hold-aware stage age", () => {
    const text = extractSqlText(buildCurrentEstimatingProjectsSql());
    expect(text).toContain("COALESCE(NULLIF");
    expect(text).toContain("bid_board_stage_slug");
    expect(text).toContain("estimate_in_progress"); // legacy estimating alias stays visible
    expect(text).toContain("d.dd_estimate");
    expect(text).toContain("d.is_active = true");
    expect(text).toContain("on_hold_accumulated_seconds"); // aliasedEffectiveStageAgeDaysSql, not raw age
  });

  it("A1 RFP and sent cohorts use their distinct CT date sources and raw latest Bid Board fields", () => {
    const rfp = extractSqlText(buildRfpInitiatedProjectsSql("2026-05-24", "2026-05-30"));
    expect(rfp).toContain("rfp_approval_requested_at");
    expect(rfp).toContain("America/Chicago");
    expect(rfp).toContain("assigned_rep_id");

    const sent = extractSqlText(buildEstimateSentProjectsSql("2026-05-24", "2026-05-30"));
    expect(sent).toContain("dsh.to_stage_id");
    expect(sent).toContain("MIN(dsh.created_at)");
    expect(sent).toContain("bid_board_total_sales");
    expect(sent).toContain("bid_board_profit_margin_pct");
    expect(sent).not.toContain("d.bid_estimate AS latest_bid_board_total_sales");
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

// The Service / Other narrowing, asserted at the SQL level across EVERY builder at once. The runtime
// suite proves the numbers reconcile; this proves no builder was left un-threaded (a missed one would
// still "work" -- it would just quietly return the unfiltered set beside filtered neighbours), and that
// the default emits literally no predicate.
describe("the Service / Other route filter reaches every deal-sourced builder", () => {
  // Each entry: a name, and a factory taking the selection. Adding a builder without adding it here is
  // the mistake this list exists to make loud.
  const DEAL_BUILDERS: Array<[string, (routes?: readonly ("service" | "other")[]) => unknown]> = [
    ["stageEntryCohort(sent)", (r) => buildStageEntryCohortSql(SENT_STAGE_SLUGS, "2026-06-01", "2026-06-07", r)],
    ["stageEntryCohort(estimated)", (r) => buildStageEntryCohortSql(ESTIMATED_STAGE_SLUGS, "2026-06-01", "2026-06-07", r)],
    ["a1CurrentEstimating", (r) => buildCurrentEstimatingProjectsSql(r)],
    ["a1RfpInitiated", (r) => buildRfpInitiatedProjectsSql("2026-06-01", "2026-06-07", r)],
    ["a1EstimateSent", (r) => buildEstimateSentProjectsSql("2026-06-01", "2026-06-07", r)],
    ["projectionBands", (r) => buildProjectionBandsSql(r)],
    ["projectionCoverage", (r) => buildProjectionCoverageSql(r)],
    ["weeklyCohortTrend", (r) => buildWeeklyCohortTrendSql("2026-05-01", "2026-06-07", undefined, r)],
    ["wonEvidence", (r) => buildWonEvidenceSql("2026-06-01", "2026-06-07", undefined, undefined, r)],
    ["stageEntryEvidence", (r) => buildStageEntryEvidenceSql(SENT_STAGE_SLUGS, "2026-06-01", "2026-06-07", undefined, undefined, r)],
    ["projectionEvidence", (r) => buildProjectionEvidenceSql(undefined, undefined, undefined, r)],
    ["undatedEvidence", (r) => buildUndatedEvidenceSql(undefined, r)],
    ["staleEvidence", (r) => buildStaleEvidenceSql(undefined, r)],
    ["noDateEvidence", (r) => buildNoDateEvidenceSql(undefined, r)],
    ["pipelineEvidence", (r) => buildPipelineEvidenceSql(undefined, undefined, undefined, r)],
  ];

  // The signature of the CANONICAL predicate -- its configured-code tier, which nothing else emits.
  //
  // Deliberately NOT "project_type_config": the evidence builders already LEFT JOIN that table for their
  // deal_type display column, so asserting on its name would pass whether or not the filter was applied
  // -- a vacuous test dressed as a strict one. And deliberately not a long literal spanning the alias:
  // extractSqlText joins queryChunks with a SPACE, so an interpolated `sql.raw("d")` splits any substring
  // written across it (`COALESCE( d .project_type`), and such an assertion fails for the wrong reason.
  const CANONICAL_PROJECT_TYPE_TEST = "~ '^[1-9]$'";

  it.each(DEAL_BUILDERS)("%s narrows on the canonical project-type test, not the raw route column", (_name, build) => {
    const service = extractSqlText(build(["service"]));
    // THE FIX. Every one of these builders used to narrow on `workflow_route` alone -- the input the
    // canonical resolution consults LAST -- so a service deal typed correctly (and stamped DFW-4-… in its
    // deal number) was counted as normal work. They must now ask project_type FIRST.
    expect(service).toContain(CANONICAL_PROJECT_TYPE_TEST);
    expect(service).toContain(".project_type");
    // ...while workflow_route survives as the final fallback, for deals carrying no type at all.
    expect(service).toContain("workflow_route = 'service'");

    const other = extractSqlText(build(["other"]));
    // "other" is the strict COMPLEMENT of "service", which is what keeps the partition total. The old
    // spelling needed an explicit `IS NULL` leg because a bare `<>` is UNKNOWN for a NULL row and would
    // drop it from BOTH buckets; the canonical predicate COALESCEs to false, so NOT is total by
    // construction and the null leg is no longer a thing that can be forgotten.
    expect(other).toContain("AND NOT");
    expect(other).toContain(CANONICAL_PROJECT_TYPE_TEST);
    // That the two buckets are exact complements (and therefore additive) is proven behaviourally, on
    // real rows, by the "additivity: service-only + other-only === both-selected" suite in
    // monday-showcase-route-filter.runtime.test.ts. It is NOT asserted here by string shape: several of
    // these builders legitimately contain their own "AND NOT" for date predicates, so a text test would
    // be measuring the wrong thing.
  });

  it.each(DEAL_BUILDERS)("%s emits NO route predicate by default or with both buckets", (_name, build) => {
    expect(extractSqlText(build(undefined))).not.toContain(CANONICAL_PROJECT_TYPE_TEST);
    expect(extractSqlText(build(["service", "other"]))).not.toContain(CANONICAL_PROJECT_TYPE_TEST);
    expect(extractSqlText(build(undefined))).not.toContain("workflow_route");
    expect(extractSqlText(build(["service", "other"]))).not.toContain("workflow_route");
    // Byte-identical, not merely "both lack the column name": the default page load must issue the exact
    // query the report issued before this filter existed.
    expect(extractSqlText(build(["service", "other"]))).toBe(extractSqlText(build(undefined)));
    expect(extractSqlText(build(["other", "service"]))).toBe(extractSqlText(build(undefined)));
  });

  it("leaves the LEAD builders alone -- the leads table has no workflow_route to filter on", () => {
    expect(extractSqlText(buildLeadStatusSql())).not.toContain("workflow_route");
    expect(extractSqlText(buildLeadEvidenceSql())).not.toContain("workflow_route");
  });

  it("refuses to build SQL for an empty selection instead of emitting a false predicate", () => {
    // A `false` predicate would return zeros that read like measurements. The request layer 400s first;
    // this is the backstop that keeps a zeroed report unreachable even from a direct service call.
    for (const [, build] of DEAL_BUILDERS) {
      expect(() => build([])).toThrow(/at least one/i);
    }
  });
});
