import { describe, expect, it } from "vitest";
import {
  isDealActivelyOnHold,
  isReportableDeal,
  reportableDealSqlPredicate,
  effectiveOnHoldSqlPredicate,
  activeDealCountFilterSqlPredicate,
  bidBoardTerminalSqlPredicate,
  closeTargetFarOutSqlPredicate,
  effectiveOnHoldConditionSqlPredicate,
  genuineEstimatingStageSqlPredicate,
  terminalDealStageIdSubselectSql,
  TERMINAL_DEAL_STAGE_SLUGS,
} from "./deal-reporting.js";
import { CLOSE_TARGET_HOLD_HORIZON_DAYS } from "./deal-hold-risk.js";
import {
  CANONICAL_TERMINAL_DEAL_STAGE_SLUGS,
  GENUINE_ESTIMATING_DEAL_STAGE_SLUGS,
  LOST_DEAL_STAGE_SLUGS,
  WON_DEAL_STAGE_SLUGS,
} from "./workflow.js";

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

// ---------------------------------------------------------------------------------------------------
// The STRING twins of the server's three "standard exclusion" drizzle builders.
//
// These are the artifact itself — a pure string builder's output IS what reaches Postgres — so exact
// equality is the right assertion here, unlike a substring match on a job's assembled query.
// ---------------------------------------------------------------------------------------------------

const TERMINAL_SLUG_SQL_LIST =
  "'won', 'lost', 'sent_to_production', 'service_sent_to_production', 'service_scheduled', " +
  "'service_complete', 'closed_won', 'deal_canceled', 'production_lost', 'service_lost', 'closed_lost'";

describe("worker-reachable string twins of the standard deal exclusions", () => {
  it("derives the terminal slug set from won + lost + canonical-terminal, never a hand list", () => {
    expect([...TERMINAL_DEAL_STAGE_SLUGS].sort()).toEqual(
      [
        ...new Set([
          ...CANONICAL_TERMINAL_DEAL_STAGE_SLUGS,
          ...WON_DEAL_STAGE_SLUGS,
          ...LOST_DEAL_STAGE_SLUGS,
        ]),
      ].sort()
    );
    // The mirror slug that C3 is about. If this ever stops being terminal, the report's exclusion of a
    // won-on-the-Bid-Board estimating deal stops working and this test is the one that says so.
    expect(TERMINAL_DEAL_STAGE_SLUGS).toContain("closed_won");
  });

  it("exports the genuine-estimating predicate the report selects its population with", () => {
    expect(genuineEstimatingStageSqlPredicate("d")).toBe(
      "d.stage_id IN (SELECT id FROM public.pipeline_stage_config " +
        "WHERE slug IN ('estimating', 'estimate_in_progress'))"
    );
    expect(genuineEstimatingStageSqlPredicate()).toBe(
      "stage_id IN (SELECT id FROM public.pipeline_stage_config " +
        "WHERE slug IN ('estimating', 'estimate_in_progress'))"
    );
    expect(genuineEstimatingStageSqlPredicate("d")).not.toContain("service_estimating");
  });

  it("resolves terminal stage IDS as a subselect, so a raw-SQL caller needs no id round trip", () => {
    expect(terminalDealStageIdSubselectSql()).toBe(
      `SELECT id FROM public.pipeline_stage_config WHERE slug IN (${TERMINAL_SLUG_SQL_LIST})`
    );
  });

  it("builds the Bid Board mirror-terminal predicate as text", () => {
    expect(bidBoardTerminalSqlPredicate("d")).toBe(
      `COALESCE(d.bid_board_stage_slug, '') IN (${TERMINAL_SLUG_SQL_LIST})`
    );
    expect(() => bidBoardTerminalSqlPredicate("d; DROP TABLE deals")).toThrow();
  });

  it("aliases the active-deal count filter onto the one reportability rule", () => {
    expect(activeDealCountFilterSqlPredicate("d")).toBe(reportableDealSqlPredicate("d"));
    expect(activeDealCountFilterSqlPredicate("d")).toBe("COALESCE(d.on_hold, false) = false");
  });

  it("carries the CRM-stage terminal leg BY DEFAULT — the arg the drizzle twin drops when unpassed", () => {
    // aliasedEffectiveOnHoldConditionSql defaults `terminalStageIds` to [] and therefore emits NO
    // stage_id leg unless a caller resolves and threads the ids. A raw-SQL caller has no such list to
    // thread, so the string twin defaults to the subselect instead: the safe form is the one you get for
    // free. Deleting the leg from the source makes this go red.
    const predicate = effectiveOnHoldConditionSqlPredicate("d");
    expect(predicate).toContain(
      `d.stage_id NOT IN (SELECT id FROM public.pipeline_stage_config WHERE slug IN (${TERMINAL_SLUG_SQL_LIST}))`
    );
    expect(predicate).toContain(
      `COALESCE(d.bid_board_stage_slug, '') NOT IN (${TERMINAL_SLUG_SQL_LIST})`
    );
  });

  it("emits stored-flag OR (both terminal guards AND far-out), in that shape", () => {
    // The far-out leg is the SHARED day-math, not a restatement — that is what keeps the SQL and the TS
    // twin (isDealEffectivelyOnHold) from disagreeing about which day a deal parks on.
    const farOut = closeTargetFarOutSqlPredicate("d");
    expect(effectiveOnHoldConditionSqlPredicate("d")).toBe(
      "(COALESCE(d.on_hold, false) = true OR (" +
        `d.stage_id NOT IN (${terminalDealStageIdSubselectSql()}) AND ` +
        `COALESCE(d.bid_board_stage_slug, '') NOT IN (${TERMINAL_SLUG_SQL_LIST}) AND ` +
        `(${farOut})))`
    );
  });

  it("drops the CRM-stage leg only when a caller asks for the open-only form", () => {
    // The legacy `terminalStageIds: []` shape, for a population that has no terminal rows at all.
    const openOnly = effectiveOnHoldConditionSqlPredicate("d", null);
    expect(openOnly).not.toContain("d.stage_id NOT IN");
    // The mirror guard is NOT optional — a Bid-Board-owned deal can be terminal in the mirror while its
    // CRM stage is still open, so no population is provably free of it.
    expect(openOnly).toContain(`COALESCE(d.bid_board_stage_slug, '') NOT IN (${TERMINAL_SLUG_SQL_LIST})`);
  });

  it("measures the far-out horizon against a caller-supplied DAY when one is given", () => {
    // For a report that must reproduce a particular run rather than describe this instant.
    expect(closeTargetFarOutSqlPredicate("d", { asOfDate: "2026-08-26" })).toContain(
      "DATE '2026-08-26' + INTERVAL '90 days'"
    );
    expect(closeTargetFarOutSqlPredicate("d")).toContain(
      "(now() AT TIME ZONE 'America/Chicago')::date + INTERVAL '90 days'"
    );
    expect(effectiveOnHoldConditionSqlPredicate("d", null, { asOfDate: "2026-08-26" })).toContain(
      "DATE '2026-08-26'"
    );
    // Interpolated, not bound — so the format is the guard.
    expect(() => closeTargetFarOutSqlPredicate("d", { asOfDate: "26-08-2026" })).toThrow();
    expect(() => closeTargetFarOutSqlPredicate("d", { asOfDate: "2026-08-26'; DROP TABLE deals--" })).toThrow();
  });

  it("measures the horizon against a caller-supplied BID DUE DATE expression when one is given", () => {
    // So a caller that has already resolved the EFFECTIVE date (lead-first) parks deals on the same date
    // it reports them on. Default unchanged: the deal column, UTC-normalized.
    const withOverride = closeTargetFarOutSqlPredicate("d", { bidDueDateSql: "l.bid_due_date" });
    expect(withOverride).toContain("COALESCE(l.bid_due_date, d.expected_close_date)");
    expect(withOverride).not.toContain("(d.bid_due_date AT TIME ZONE 'UTC')::date");
    expect(closeTargetFarOutSqlPredicate("d")).toContain(
      "COALESCE((d.bid_due_date AT TIME ZONE 'UTC')::date, d.expected_close_date)"
    );
  });

  it("validates the alias on every door", () => {
    expect(() => effectiveOnHoldConditionSqlPredicate("d; DROP TABLE deals")).toThrow();
    expect(() => genuineEstimatingStageSqlPredicate("d; DROP TABLE deals")).toThrow();
    expect(() => activeDealCountFilterSqlPredicate("d; DROP TABLE deals")).toThrow();
  });
});
