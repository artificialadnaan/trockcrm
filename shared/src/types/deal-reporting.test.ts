import { describe, expect, it } from "vitest";
import {
  isDealActivelyOnHold,
  isReportableDeal,
  reportableDealSqlPredicate,
  effectiveOnHoldSqlPredicate,
} from "./deal-reporting.js";
import { CLOSE_TARGET_HOLD_HORIZON_DAYS } from "./deal-hold-risk.js";
import { GENUINE_ESTIMATING_DEAL_STAGE_SLUGS } from "./workflow.js";

describe("deal reporting helpers", () => {
  it("uses active on-hold state as the single reportability rule", () => {
    expect(isDealActivelyOnHold({ onHold: true })).toBe(true);
    expect(isReportableDeal({ onHold: true })).toBe(false);
    expect(isReportableDeal({ onHold: false })).toBe(true);
    expect(isReportableDeal({ onHold: null })).toBe(true);
  });

  it("builds the shared SQL predicate from the same on_hold field", () => {
    expect(reportableDealSqlPredicate()).toBe("COALESCE(on_hold, false) = false");
    expect(reportableDealSqlPredicate("d")).toBe("COALESCE(d.on_hold, false) = false");
    expect(reportableDealSqlPredicate("open_deals")).toBe(
      "COALESCE(open_deals.on_hold, false) = false"
    );
    expect(() => reportableDealSqlPredicate("d; DROP TABLE deals")).toThrow();
  });

  it("builds the effective-on-hold predicate: stored on_hold OR a hold horizon past the 90-day mark", () => {
    // The horizon constant is shared with the TS twin so SQL + TS can never drift.
    expect(CLOSE_TARGET_HOLD_HORIZON_DAYS).toBe(90);

    const estimatingStages =
      "stage_id IN (SELECT id FROM public.pipeline_stage_config " +
      "WHERE slug IN ('estimating', 'estimate_in_progress'))";
    const horizonDate =
      `CASE WHEN ${estimatingStages} ` +
      "THEN COALESCE((bid_due_date AT TIME ZONE 'UTC')::date, expected_close_date) " +
      "ELSE expected_close_date END";
    expect(effectiveOnHoldSqlPredicate()).toBe(
      `(COALESCE(on_hold, false) = true OR ((${horizonDate}) IS NOT NULL AND ` +
        `(${horizonDate}) > (now() AT TIME ZONE 'America/Chicago')::date + INTERVAL '90 days'))`
    );

    const aliasedEstimatingStages =
      "d.stage_id IN (SELECT id FROM public.pipeline_stage_config " +
      "WHERE slug IN ('estimating', 'estimate_in_progress'))";
    const aliasedHorizonDate =
      `CASE WHEN ${aliasedEstimatingStages} ` +
      "THEN COALESCE((d.bid_due_date AT TIME ZONE 'UTC')::date, d.expected_close_date) " +
      "ELSE d.expected_close_date END";
    expect(effectiveOnHoldSqlPredicate("d")).toBe(
      `(COALESCE(d.on_hold, false) = true OR ((${aliasedHorizonDate}) IS NOT NULL AND ` +
        `(${aliasedHorizonDate}) > (now() AT TIME ZONE 'America/Chicago')::date + INTERVAL '90 days'))`
    );
    // CT anchor matches reportableDealSqlPredicate's day boundary (America/Chicago), so the pill and
    // the forecast SQL agree to the day.
    expect(effectiveOnHoldSqlPredicate("open_deals")).toContain(
      "(now() AT TIME ZONE 'America/Chicago')::date + INTERVAL '90 days'"
    );
    expect(() => effectiveOnHoldSqlPredicate("d; DROP TABLE deals")).toThrow();
  });

  it("keys the estimating branch on the derived slug set, and never on service_estimating", () => {
    // The SQL slug list is generated from GENUINE_ESTIMATING_DEAL_STAGE_SLUGS. Assert the emitted list
    // matches that set exactly: a hand-edit here (or a stage rename that drops an alias) silently moves a
    // whole stage back onto the close-target rule with every other test still green.
    const predicate = effectiveOnHoldSqlPredicate("d");
    const emitted = /WHERE slug IN \(([^)]*)\)/.exec(predicate)?.[1] ?? "";
    expect(emitted.split(", ").map((quoted) => quoted.slice(1, -1)).sort()).toEqual(
      [...GENUINE_ESTIMATING_DEAL_STAGE_SLUGS].sort()
    );
    expect(predicate).not.toContain("service_estimating");
  });

  it("reads bid_due_date at UTC, never in the session timezone", () => {
    // bid_due_date is a timestamptz stored at UTC midnight. A bare `::date` resolves in the session
    // timezone, which would shift the calendar day (and therefore a hold verdict, and therefore a dollar
    // value) the moment a pooler or a SET TIME ZONE changes it. expected_close_date is a plain date and
    // must NOT be re-cast.
    const predicate = effectiveOnHoldSqlPredicate("d");
    expect(predicate).toContain("(d.bid_due_date AT TIME ZONE 'UTC')::date");
    // Every occurrence of bid_due_date is UTC-normalized — no bare cast anywhere.
    expect(predicate).not.toMatch(/bid_due_date\s*(::|\))?\s*::date/);
    expect(predicate).not.toContain("d.expected_close_date::date");
  });

  it("keeps the IS NOT NULL leg so a horizon-less deal survives a negated predicate", () => {
    // Load-bearing three-valued-logic guard: the deals "active" status filter evaluates NOT (predicate).
    // Without the explicit IS NOT NULL, `NOT (NULL > x)` is NULL and a deal with no close target and no
    // bid due date would silently disappear from the Active list instead of appearing in it.
    expect(effectiveOnHoldSqlPredicate("d")).toContain(") IS NOT NULL AND (");
  });
});
