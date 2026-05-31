// Reports Part 2 -- shared SOURCE foundations (F2-F5 + week stage-entry cohorts). Every report variant
// (the 8 Monday-showcase presentations) composes THESE helpers so no two variants can disagree on a
// number: "many presentations, one source of truth." F1 (the canonical Sunday-Saturday period helper)
// lives in ../../lib/period.ts and is imported by the week-based surfaces.
//
// Discipline encoded here:
//   F2  projection 30/60/90 from expected_close_date ALONE (no COALESCE) + the mandatory N/M caveat.
//   F3  value-basis labels -- Won $ and open (Sent/Estimated) $ are DIFFERENT bases, never summed.
//   F4  the 2026-05-17 stage-history backfill spike is excluded from every trend/average.
//   F5  Est/Sent are COUNT(DISTINCT deal) -- a deal re-entering a stage must not double-count.

import { sql, type SQL } from "drizzle-orm";
import {
  aliasedEffectiveWonDealValueSql,
  aliasedDealBestEstimateSql,
} from "../shared/deal-value-sql.js";

// CT-anchored "today" as a SQL date -- DST-safe via Postgres, matching F1's America/Chicago anchoring.
// Callers may override (e.g. to bind a precomputed F1 businessToday) but the default keeps every
// projection surface on the same business-day boundary.
const CT_TODAY_SQL = "(now() AT TIME ZONE 'America/Chicago')::date";

// ===================== F2: projection 30/60/90 + N/M coverage =====================

export const PROJECTION_WINDOW_DAYS = [30, 60, 90] as const;
export type ProjectionBand = "0_30" | "31_60" | "61_90" | "beyond_90";

/**
 * N predicate: a deal is "projected" ONLY via its own maintained expected_close_date -- alone, never
 * COALESCE'd onto won/other dates -- and only when that date is today-or-future (a stale PAST date is
 * not a live projection). Bid-Board-mirror deals carry a NULL expected_close_date and therefore fail
 * this predicate; they remain in the M denominator (never silently dropped), so the caveat stays honest.
 */
export function futureDatedCloseDatePredicateSql(closeDateExpr: string, todayExpr: string = CT_TODAY_SQL): SQL {
  return sql.raw(`(${closeDateExpr} IS NOT NULL AND ${closeDateExpr} >= ${todayExpr})`);
}

/** Discrete 30/60/90 band for a deal's expected_close_date; NULL for none / past / beyond 90 days. */
export function projectionBandSql(closeDateExpr: string, todayExpr: string = CT_TODAY_SQL): SQL {
  return sql.raw(
    `CASE
       WHEN ${closeDateExpr} IS NULL OR ${closeDateExpr} < ${todayExpr} THEN NULL
       WHEN ${closeDateExpr} <= ${todayExpr} + INTERVAL '30 days' THEN '0_30'
       WHEN ${closeDateExpr} <= ${todayExpr} + INTERVAL '60 days' THEN '31_60'
       WHEN ${closeDateExpr} <= ${todayExpr} + INTERVAL '90 days' THEN '61_90'
       ELSE 'beyond_90'
     END`
  );
}

export interface ProjectionCoverage {
  /** future-dated open deals (the N predicate above). */
  n: number;
  /** ALL open deals in scope, incl. Bid-Board-mirror NULL-dated deals. */
  m: number;
}

/**
 * The mandatory honesty caption shown wherever a projection appears -- never a bare projected number.
 * Per-rep n/m sum to the office n/m by construction (same predicate over disjoint rep slices).
 */
export function formatProjectionCoverageCaption({ n, m }: ProjectionCoverage): string {
  if (m <= 0) return "No open deals in scope.";
  const dealWord = m === 1 ? "deal" : "deals";
  const haveWord = n === 1 ? "has" : "have";
  return `${n} of ${m} open ${dealWord} ${haveWord} a maintained (future-dated) expected close date.`;
}

// ===================== F3: value-label discipline =====================
// Two DISTINCT value bases. They DIFFER by design and are NEVER reconciled/summed across a funnel row
// or scoreboard; each rendered $ must carry its basis label.
//   won_awarded_first  -> aliasedEffectiveWonDealValueSql  (awarded_amount first, then bid_board/bid/dd)
//   open_best_estimate -> aliasedDealBestEstimateSql       (bid_board/bid/dd first, awarded last)

export type DealValueBasis = "won_awarded_first" | "open_best_estimate";

export const DEAL_VALUE_BASIS_LABEL: Record<DealValueBasis, string> = {
  won_awarded_first: "Awarded-first won value",
  open_best_estimate: "Best current estimate",
};

export function dealValueSqlForBasis(alias: string, basis: DealValueBasis): SQL {
  return basis === "won_awarded_first"
    ? aliasedEffectiveWonDealValueSql(alias)
    : aliasedDealBestEstimateSql(alias);
}

// ===================== F4: backfill spike exclusion =====================
// A bulk backfill on 2026-05-17 (a Sunday) dumped a one-off spike of deal_stage_history rows. That week
// is EXCLUDED from any trend/average and shown raw-but-flagged in a single-week cell -- applied
// identically everywhere. Compose with F1's sundayWeekBucketSql to get the week-start expression.

export const BACKFILL_SPIKE_WEEK_START = "2026-05-17";

export function excludeBackfillSpikeWeekPredicateSql(weekStartExpr: string): SQL {
  return sql.raw(`(${weekStartExpr}) <> DATE '${BACKFILL_SPIKE_WEEK_START}'`);
}

// ===================== F5: distinct-deal counting =====================
// Est/Sent counts are COUNT(DISTINCT deal) per stage/week -- a deal re-entering a stage must not
// double-count. Uniform everywhere.

export function distinctDealCountSql(dealIdExpr = "deal_id"): SQL {
  return sql.raw(`COUNT(DISTINCT ${dealIdExpr})`);
}

// ===================== week stage-entry cohorts =====================
// "Sent this week" / "Estimated this week" are STAGE-ENTRY cohorts on deal_stage_history.created_at
// (the platform has no dedicated sent/estimated event-date column, so stage entry is the documented
// proxy -- WEAK for Estimated). Slugs mirror shared/src/types/workflow.ts; the active estimating stage
// is `estimating` (NOT the dead `estimate_in_progress`, inactive since migration 0064 -- see #549).
// Combine with F1's getWtdPeriod(...) on created_at and F5's distinctDealCountSql for the weekly count.

export const SENT_STAGE_SLUGS = ["estimate_sent_to_client", "service_estimate_sent_to_client"] as const;
export const ESTIMATED_STAGE_SLUGS = ["estimating", "service_estimating"] as const;
