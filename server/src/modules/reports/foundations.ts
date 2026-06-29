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
  aliasedEffectiveDealValueSql,
} from "../shared/deal-value-sql.js";

// CT-anchored "today" as a SQL date -- DST-safe via Postgres, matching F1's America/Chicago anchoring.
const CT_TODAY_SQL = "(now() AT TIME ZONE 'America/Chicago')::date";

// Resolve the projection "today" reference into a SQL expression. Default = the CT-anchored now()-based
// expression. A caller pinning today to a precomputed F1 date passes a YYYY-MM-DD string, which is
// emitted as a BOUND `DATE '...'` literal (NOT raw text -- `>= 2026-05-31` is not a valid Postgres date
// comparison) and shape-validated so nothing arbitrary reaches the interpolated SQL.
function projectionTodaySql(today?: string): string {
  if (today === undefined) return CT_TODAY_SQL;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new Error(`projection 'today' must be a YYYY-MM-DD date, got: ${JSON.stringify(today)}`);
  }
  return `DATE '${today}'`;
}

// ===================== F2: projection 30/60/90 + N/M coverage =====================

export const PROJECTION_WINDOW_DAYS = [30, 60, 90] as const;
export type ProjectionBand = "0_30" | "31_60" | "61_90" | "beyond_90";

/**
 * N predicate: a deal is "projected" ONLY via its own maintained expected_close_date -- alone, never
 * COALESCE'd onto won/other dates -- and only when that date is today-or-future (a stale PAST date is
 * not a live projection). Bid-Board-mirror deals carry a NULL expected_close_date and therefore fail
 * this predicate; they remain in the M denominator (never silently dropped), so the caveat stays honest.
 */
export function futureDatedCloseDatePredicateSql(closeDateExpr: string, today?: string): SQL {
  const todaySql = projectionTodaySql(today);
  return sql.raw(`(${closeDateExpr} IS NOT NULL AND ${closeDateExpr} >= ${todaySql})`);
}

/** Discrete 30/60/90 band for a deal's expected_close_date; NULL for none / past / beyond 90 days. */
export function projectionBandSql(closeDateExpr: string, today?: string): SQL {
  const todaySql = projectionTodaySql(today);
  return sql.raw(
    `CASE
       WHEN ${closeDateExpr} IS NULL OR ${closeDateExpr} < ${todaySql} THEN NULL
       WHEN ${closeDateExpr} <= ${todaySql} + INTERVAL '30 days' THEN '0_30'
       WHEN ${closeDateExpr} <= ${todaySql} + INTERVAL '60 days' THEN '31_60'
       WHEN ${closeDateExpr} <= ${todaySql} + INTERVAL '90 days' THEN '61_90'
       ELSE 'beyond_90'
     END`
  );
}

export interface ProjectionCoverage {
  /** future-dated open deals (the N predicate above). */
  n: number;
  /** ALL open deals in scope, incl. Bid-Board-mirror NULL-dated deals. */
  m: number;
  /** open best-estimate $ over the (M − N) undated complement (never-dated + stale-past-dated). The
   *  count of that complement is M − N; this is its $ so the "No future close date" card shows both. */
  undatedValue: number;
}

/**
 * The mandatory honesty caption shown wherever a projection appears -- never a bare projected number.
 * Per-rep n/m sum to the office n/m by construction (same predicate over disjoint rep slices).
 */
export function formatProjectionCoverageCaption({ n, m }: { n: number; m: number }): string {
  if (m <= 0) return "No open deals in scope.";
  const dealWord = m === 1 ? "deal" : "deals";
  const haveWord = n === 1 ? "has" : "have";
  return `${n} of ${m} open ${dealWord} ${haveWord} a maintained (future-dated) expected close date.`;
}

// ===================== F3: value-label discipline =====================
// Two value-basis LABELS for caption discipline. As of the 2026-06-18 "awarded-highest" convention shift
// BOTH bases now resolve through the SAME awarded-first chain (deal-value-sql.ts DEAL_VALUE_PRIORITY_CHAIN:
// awarded_amount > bid_board/bid/dd). The open basis was formerly bid-first/awarded-last and was unified to
// awarded-first (verified inert on prod reportable totals at the time of the shift). The basis now drives
// only the LABEL/context shown to the user (a Won column vs an open column), not the value computation; the
// two are kept distinct so each rendered $ still carries the right caption.
//   won_awarded_first  -> aliasedEffectiveWonDealValueSql  (awarded-first chain)
//   open_best_estimate -> aliasedDealBestEstimateSql       (awarded-first chain — unified 2026-06-18)

export type DealValueBasis = "won_awarded_first" | "open_best_estimate";

export const DEAL_VALUE_BASIS_LABEL: Record<DealValueBasis, string> = {
  won_awarded_first: "Awarded-first won value",
  open_best_estimate: "Best current estimate",
};

export function dealValueSqlForBasis(alias: string, basis: DealValueBasis): SQL {
  // Both bases go through the EFFECTIVE wrapper (on-hold value -> 0). Post-2026-06-18 both the won and open
  // helpers resolve through the same awarded-first chain (DEAL_VALUE_PRIORITY_CHAIN), so the returned SQL is
  // now equivalent for either basis; the basis is retained as a labeling/context selector (and a hook for
  // any future divergence), keeping these foundations consistent with every other effective-value read.
  return basis === "won_awarded_first"
    ? aliasedEffectiveWonDealValueSql(alias)
    : aliasedEffectiveDealValueSql(alias);
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

// `bid_sent` is the legacy pre-realignment slug for the sent stage (migration 0053 -> canonical
// estimate_sent_to_client; marked inactive but historical deal_stage_history rows still point at it).
// Swept shared/src/types/workflow.ts: bid_sent (sent) + estimate_in_progress (estimating) are the ONLY
// inactive aliases that canonicalize into these two cohorts -- include them so historical stage-entry
// rows aren't undercounted (terminal aliases like closed_won/production_lost are Won/Lost, not these).
export const SENT_STAGE_SLUGS = ["estimate_sent_to_client", "service_estimate_sent_to_client", "bid_sent"] as const;
// `estimate_in_progress` is the legacy pre-0064 slug for the estimating stage (now inactive). Historical
// deal_stage_history rows from before #549's migration 0064 still point at it (workflow.ts canonicalizes
// it to `estimating`), so the stage-entry cohort/trend must include it or it undercounts historical
// estimating entries -- mirroring how SENT carries its service-workflow variant.
export const ESTIMATED_STAGE_SLUGS = ["estimating", "service_estimating", "estimate_in_progress"] as const;
