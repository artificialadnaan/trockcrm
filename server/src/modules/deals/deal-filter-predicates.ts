import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { deals } from "@trock-crm/shared/schema";
import {
  aliasedActiveDealCountFilterSql,
  aliasedDealBestEstimateSql,
  aliasedEffectiveEstimatingDealValueSql,
  aliasedEffectiveWonDealValueSql,
  aliasedEffectiveLostDealValueSql,
  aliasedEffectiveOnHoldConditionSql,
  aliasedTerminalAwareEffectiveDealValueSql,
} from "../shared/deal-value-sql.js";
import { TERMINAL_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";
import {
  buildDealOutcomeDateScope,
  type DealDateScopeContext,
} from "../shared/deal-date-scope.js";

/**
 * Composable filter predicate registry for the deals list (the shared FilterBar
 * backend). Each dimension is a pure builder (input, ctx) => SQL | undefined:
 *   - undefined  = the filter is unset → OMIT it (graceful: no WHERE narrowing,
 *                  never a broken or empty-IN clause);
 *   - SQL        = a single condition, AND-combinable with the others.
 * The driver `buildDealFilterBarConditions` runs the registry and drops the
 * undefineds, so N active dimensions => N AND'd predicates in one query.
 *
 * PARAM CONTRACT (consumed here; emitted by RED's FilterBar frontend):
 *   assignedRepId  string | "__unassigned__"   eq, or IS NULL for the sentinel
 *   regionId       string | "__unassigned__"   eq, or IS NULL for the sentinel
 *   projectTypeId  string                       eq
 *   workflowRoute  "normal" | "service"         eq (stored verbatim — no mapping)
 *   status         active|on_hold|inactive|any  is_active / on_hold predicate pair
 *   valueMin/Max   number                       BETWEEN on the effective value chain
 *   minAgeDays/Max number                       days-in-stage; GATED on stageEntryDateEnabled
 *   dateFrom/To    YYYY-MM-DD                    outcome-aware window (deal-date-scope)
 *
 * See .audit/shared-filterbar-design.md (§4 registry, §5 date reliability tiers).
 */

/** Sentinel value the FilterBar emits for the "Unassigned" bucket on FK dimensions. */
export const UNASSIGNED_FILTER_SENTINEL = "__unassigned__";

export type DealStatusFilter = "active" | "on_hold" | "inactive" | "any";

export interface DealFilterBarInput {
  assignedRepId?: string;
  regionId?: string;
  projectTypeId?: string;
  // Loosely typed on purpose: the predicate is the single validation point. A
  // recognized value applies its predicate, an unrecognized one becomes a
  // no-match sentinel (sql`false`), and absent/empty/all omits — so a bad value
  // can never widen results or produce broken SQL (param contract §3).
  workflowRoute?: string;
  status?: string;
  valueMin?: number;
  valueMax?: number;
  minAgeDays?: number;
  maxAgeDays?: number;
  dateFrom?: string;
  dateTo?: string;
  /**
   * Non-UI flag: exclude on-hold deals from the row set, matching the Won board/summary's reportable
   * filter (COALESCE(on_hold,false)=false). On-hold was the HubSpot-migration parking lot (unvalidated
   * artifacts), so the Won summary excludes it; the Won stage-page/drill-down list opts in here to
   * reconcile to that count. Opt-in — omit to include on-hold (every non-Won caller, unchanged).
   */
  excludeOnHold?: boolean;
}

/** Context shared by the gated/classified predicates (date + stalled). */
// estimatingStageIds is value-filter-specific (the 'estimating' stage values DD over bid), so it lives on
// the filter context rather than the shared date-scope context where it would be meaningless.
export type DealFilterContext = DealDateScopeContext & { estimatingStageIds?: string[] };

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * "Involved as rep or estimator": the deal's assigned rep OR the resolved estimator
 * (deals.estimator_user_id) is the filtered person. The Unassigned sentinel maps to
 * assigned_rep IS NULL ONLY — the estimator clause must NOT widen the Unassigned bucket.
 * For service reps who estimate their own deals (estimator == rep) this returns the same
 * deals as before; for estimator-only people it also surfaces deals they estimated.
 */
export function buildInvolvedRepCondition(repId: string): SQL {
  if (repId === UNASSIGNED_FILTER_SENTINEL) return isNull(deals.assignedRepId);
  return or(eq(deals.assignedRepId, repId), eq(deals.estimatorUserId, repId)) as SQL;
}

/**
 * "Owns it": the deal's assigned rep IS the filtered person. The Unassigned sentinel maps to
 * assigned_rep IS NULL, same as the involved variant.
 *
 * This is what a REP FILTER means — picking a person answers "show me that person's deals", and a deal
 * belongs to whoever owns it. The estimator link is deliberately NOT consulted: `deals.estimator_user_id` is
 * populated far beyond the handful of real estimators (it feeds the estimator report), so an estimator-OR
 * filter shows a rep dozens of deals that are somebody else's book. It also can't reconcile with any surface
 * that groups BY assigned rep — one deal would land on two people's rows and inflate the total.
 *
 * Use buildInvolvedRepCondition / buildAliasedInvolvedRepSql instead wherever the question really is "every
 * deal this person touched" — commissions (estimators genuinely earn a cut) and the estimator report.
 */
export function buildOwnedRepCondition(repId: string): SQL {
  if (repId === UNASSIGNED_FILTER_SENTINEL) return isNull(deals.assignedRepId);
  return eq(deals.assignedRepId, repId);
}

/** assigned rep — OWNER only (see buildOwnedRepCondition), or IS NULL for the Unassigned sentinel. */
export function buildAssignedRepPredicate(input: DealFilterBarInput): SQL | undefined {
  if (!input.assignedRepId) return undefined;
  return buildOwnedRepCondition(input.assignedRepId);
}

/**
 * Raw-SQL variant of buildInvolvedRepCondition for queries that alias the deals table
 * (e.g. "d") and so can't use the unaliased Drizzle `deals` object — mirrors the
 * unaliased/aliased mine-visibility split. `alias` is interpolated raw, so it MUST be a
 * trusted internal identifier (validated below to block injection); `repId` is parameterized.
 */
export function buildAliasedInvolvedRepSql(alias: string, repId: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`Invalid SQL alias for involved-rep predicate: ${alias}`);
  }
  const repCol = sql.raw(`${alias}.assigned_rep_id`);
  if (repId === UNASSIGNED_FILTER_SENTINEL) return sql`${repCol} is null`;
  const estCol = sql.raw(`${alias}.estimator_user_id`);
  return sql`(${repCol} = ${repId} OR ${estCol} = ${repId})`;
}

/**
 * Raw-SQL OWNER-ONLY variant, for aliased queries — the aliased twin of buildOwnedRepCondition, and the one
 * a rep FILTER should use. See that function for why the estimator arm is excluded here.
 */
export function buildAliasedOwnedRepSql(alias: string, repId: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`Invalid SQL alias for owned-rep predicate: ${alias}`);
  }
  const repCol = sql.raw(`${alias}.assigned_rep_id`);
  if (repId === UNASSIGNED_FILTER_SENTINEL) return sql`${repCol} is null`;
  return sql`${repCol} = ${repId}`;
}

/**
 * IN-list ("team" / multi-rep / owner) variant of the involved-rep predicate for aliased raw queries.
 * Emits `(<alias>.assigned_rep_id IN (<ids>) OR <alias>.estimator_user_id IN (<ids>))` so a multi-rep
 * filter surfaces deals any listed person OWNS or ESTIMATED — the IN-list generalization of
 * buildAliasedInvolvedRepSql. The ids are parameterized; `alias` is validated (same identifier-injection
 * guard). Returns undefined for an empty list so the caller OMITS the clause (never an empty IN, which
 * would match nothing). There is NO Unassigned sentinel here: an unassigned deal has NULL assigned_rep_id
 * which no id value matches, so Unassigned is simply not selectable via an id list — matching every
 * existing IN-list owner-filter site's behavior.
 *
 * `cast` preserves each call site's existing literal/column cast so the refactor changes ONLY the added
 * estimator OR-arm, never the assigned-rep arm's emitted SQL:
 *   - "none"   -> col IN ($id, …)         implicit uuid<-text coercion   (sales-tier1)
 *   - "value"  -> col IN ($id::uuid, …)   per-value uuid cast            (analytics-tier4)
 *   - "column" -> col::text IN ($id, …)   column cast to text           (operations-tier3)
 */
export function buildAliasedInvolvedRepInListSql(
  alias: string,
  repIds: readonly string[],
  cast: "none" | "value" | "column" = "none"
): SQL | undefined {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`Invalid SQL alias for involved-rep IN-list predicate: ${alias}`);
  }
  if (repIds.length === 0) return undefined;
  // A fresh value-list per column so each IN gets its own parameters (no shared-fragment aliasing).
  const valueList = () =>
    sql.join(repIds.map((id) => (cast === "value" ? sql`${id}::uuid` : sql`${id}`)), sql`, `);
  const repCol = sql.raw(`${alias}.assigned_rep_id`);
  const estCol = sql.raw(`${alias}.estimator_user_id`);
  if (cast === "column") {
    return sql`(${repCol}::text IN (${valueList()}) OR ${estCol}::text IN (${valueList()}))`;
  }
  return sql`(${repCol} IN (${valueList()}) OR ${estCol} IN (${valueList()}))`;
}

/** region — eq, or IS NULL for the Unassigned sentinel (region is very sparse). */
export function buildRegionPredicate(input: DealFilterBarInput): SQL | undefined {
  if (!input.regionId) return undefined;
  return input.regionId === UNASSIGNED_FILTER_SENTINEL
    ? isNull(deals.regionId)
    : eq(deals.regionId, input.regionId);
}

/** project type — eq. */
export function buildProjectTypePredicate(input: DealFilterBarInput): SQL | undefined {
  if (!input.projectTypeId) return undefined;
  return eq(deals.projectTypeId, input.projectTypeId);
}

/**
 * workflow route — eq; the column stores "normal" | "service" verbatim. Absent /
 * empty / "all" omits; a recognized value applies eq; an unrecognized value is a
 * no-match (sql`false`) so a bad param can never widen results (contract §3).
 */
export function buildWorkflowRoutePredicate(input: DealFilterBarInput): SQL | undefined {
  const value = input.workflowRoute;
  if (value === undefined || value === "" || value === "all") return undefined;
  if (value === "normal" || value === "service") return eq(deals.workflowRoute, value);
  return sql`false`;
}

/**
 * status — ONE control over TWO orthogonal columns (is_active, on_hold). The
 * mapping is explicit so the safety-critical is_active default is never ambiguous.
 *
 * EFFECTIVE-HOLD aware (Codex P2): "On hold" / "Active" key on the EFFECTIVE hold rule (stored on_hold OR —
 * for an OPEN deal — a far-out close target), not the stored flag alone, so a far-out auto-held open deal
 * reads as On-Hold (matching its $0 value + badge) instead of leaking into Active. TERMINAL-aware: a won/lost
 * deal is realized/preserved and never auto-parked, so ctx's won ∪ lost ids exempt it from the far-out leg.
 * Without those ids (ctx default) the rule degrades to open-only — safe only when the population has no
 * terminal rows; the deals list resolves them whenever a status filter is set.
 */
export function buildStatusPredicate(input: DealFilterBarInput, ctx: DealFilterContext = {}): SQL | undefined {
  const value = input.status;
  // Absent / empty / "any" omits (no narrowing). An unrecognized value falls to
  // the default no-match sentinel rather than silently omitting (contract §3).
  if (value === undefined || value === "" || value === "any") return undefined;
  const terminalStageIds = [...(ctx.wonStageIds ?? []), ...(ctx.lostStageIds ?? [])];
  const effectiveHold = aliasedEffectiveOnHoldConditionSql("deals", terminalStageIds);
  switch (value) {
    case "active":
      return and(eq(deals.isActive, true), sql`NOT (${effectiveHold})`);
    case "on_hold":
      // On-Hold is a CURRENT-deals view (a subset of active, paused), so require
      // is_active=true too — else a soft-deleted deal (deleteDeal sets is_active
      // false but leaves on_hold set) would reappear here (Codex #546). A deal
      // both inactive AND on-hold belongs under Inactive, not On-Hold.
      return and(eq(deals.isActive, true), effectiveHold);
    case "inactive":
      return eq(deals.isActive, false);
    default:
      return sql`false`;
  }
}

/**
 * Stage-aware effective deal value, mirroring getEffectiveDealValue (shared/src/types/deal-hold.ts).
 * Row-level branch by stage_id (no pipeline_stage_config join — the deals row carries stage_id):
 *   - estimating stages → awarded > dd > bid (DD outranks bid; 2026-06-18 Adnaan rule);
 *   - Won stages        → awarded-first chain (identical to open since the 2026-06-18 unification —
 *                         retained as a future-divergence hook), REALIZED-safe (stored on_hold only);
 *   - Lost stages       → awarded-first chain, REALIZED-safe — a lost bid's value is PRESERVED for Loss
 *                         Analysis and must NOT be auto-parked to $0 by a far-out forecast date (Codex P2;
 *                         mirrors the client getEffectiveDealValue terminal exemption);
 *   - everything else   → the default OPEN awarded-first chain, which DOES zero a far-out (90+ day) close
 *                         target (auto-park) — UNLESS the row is terminal via its Bid Board mirror (a
 *                         BB-owned deal can be won/lost in bid_board_stage_slug while its CRM stage_id is
 *                         still open), in which case its realized value is preserved (stored-on_hold only;
 *                         Codex P2, matches the client + on-hold predicate).
 * Won/Lost branches zero on stored on_hold only; the open branch additionally zeros far-out auto-held rows.
 * This is the value the list DISPLAYS, so the value filter and the value sort use it too (sort == filter ==
 * display, D-1; Codex #546).
 */
export function aliasedStageAwareEffectiveDealValueSql(
  alias: string,
  wonStageIds: string[],
  estimatingStageIds: string[] = [],
  lostStageIds: string[] = []
): SQL {
  // The open ELSE branch is itself BB-mirror-terminal-aware: a CRM-open deal whose bid_board_stage_slug is
  // already won/lost keeps its realized value instead of being auto-parked by a far-out forecast date.
  const bidBoardTerminal = sql`COALESCE(${sql.raw(`${alias}.bid_board_stage_slug`)}, '') IN (${sql.join(
    TERMINAL_STAGE_SLUGS.map((slug) => sql`${slug}`),
    sql`, `
  )})`;
  const openValue = aliasedTerminalAwareEffectiveDealValueSql(
    alias,
    aliasedDealBestEstimateSql(alias),
    bidBoardTerminal
  );
  const stageId = sql.raw(`${alias}.stage_id`);
  const branches: SQL[] = [];
  if (estimatingStageIds.length > 0) {
    const estIds = sql.join(estimatingStageIds.map((id) => sql`${id}`), sql`, `);
    branches.push(sql`WHEN ${stageId} IN (${estIds}) THEN ${aliasedEffectiveEstimatingDealValueSql(alias)}`);
  }
  if (wonStageIds.length > 0) {
    const wonIds = sql.join(wonStageIds.map((id) => sql`${id}`), sql`, `);
    branches.push(sql`WHEN ${stageId} IN (${wonIds}) THEN ${aliasedEffectiveWonDealValueSql(alias)}`);
  }
  if (lostStageIds.length > 0) {
    const lostIds = sql.join(lostStageIds.map((id) => sql`${id}`), sql`, `);
    branches.push(sql`WHEN ${stageId} IN (${lostIds}) THEN ${aliasedEffectiveLostDealValueSql(alias)}`);
  }
  if (branches.length === 0) return openValue;
  return sql`CASE ${sql.join(branches, sql` `)} ELSE ${openValue} END`;
}

/**
 * Hold-aware effective stage age in days, mirroring getEffectiveStageAgeSeconds
 * (shared/src/types/deal-hold.ts): age since the effective stage-entry date
 * (bid_board_stage_entered_at when present, else stage_entered_at), minus
 * completed hold time accumulated in the current stage, minus the currently-open
 * hold interval. This is the "days in stage" the list DISPLAYS, so the stalled
 * filter uses it (filter == display; Codex #546). NOTE: the deal-stage-page
 * stalled filter still uses raw age and should adopt this helper too — tracked
 * as a follow-up.
 */
export function aliasedEffectiveStageAgeDaysSql(alias: string): SQL {
  const col = (name: string) => sql.raw(`${alias}.${name}`);
  // Bid-board entry ONLY for Bid Board-owned deals (mirrors
  // resolveEffectiveStageEnteredAt; Codex #546) — a CRM-owned deal with a stale
  // non-null bid-board timestamp must still age off stage_entered_at, the same
  // age the list/at-risk display uses.
  const entered = sql`CASE
    WHEN ${col("is_bid_board_owned")} = true AND ${col("bid_board_stage_entered_at")} IS NOT NULL
      THEN ${col("bid_board_stage_entered_at")}
    ELSE ${col("stage_entered_at")}
  END`;
  const elapsed = sql`EXTRACT(EPOCH FROM (now() - ${entered}))`;
  // Completed hold time accrued since this stage was entered (snapshot delta).
  const accumulatedSinceEntry = sql`CASE
    WHEN ${col("on_hold_accumulated_seconds_at_stage_entry")} IS NULL THEN 0
    ELSE GREATEST(0, COALESCE(${col("on_hold_accumulated_seconds")}, 0) - ${col("on_hold_accumulated_seconds_at_stage_entry")})
  END`;
  // The currently-open hold interval, if the deal is on hold right now. Anchored
  // at GREATEST(effective stage entry, hold start) so a hold that began BEFORE the
  // deal entered this stage (or a legacy on_hold_started_at predating entry) only
  // subtracts the portion that overlaps the current stage — mirroring the shared
  // getEffectiveStageAgeSeconds (max(stageEnteredAt, onHoldStartedAt)). Subtracting
  // from on_hold_started_at directly would understate days-in-stage and could omit
  // deals the list shows as stalled (Codex #546).
  const openHold = sql`CASE
    WHEN ${col("on_hold")} AND ${col("on_hold_started_at")} IS NOT NULL
      THEN GREATEST(0, EXTRACT(EPOCH FROM (now() - GREATEST(${entered}, ${col("on_hold_started_at")}))))
    ELSE 0
  END`;
  return sql`FLOOR(GREATEST(0, ${elapsed} - ${accumulatedSinceEntry} - ${openHold}) / 86400)`;
}

/**
 * True when a numeric FilterBar bound was supplied but is not a finite number
 * (e.g. ?valueMin=abc, which arrives as a NaN sentinel from the route). A
 * malformed bound is no-matched (sql`false`) like an unrecognized enum rather than
 * treated as unset, so a bad URL never silently widens results (Codex #546).
 */
function isMalformedNumber(value: number | undefined): boolean {
  return value !== undefined && !Number.isFinite(value);
}

/**
 * value range — BETWEEN on the STAGE-AWARE effective value (estimating → awarded>dd>bid; Won/open →
 * awarded-first), the same number the list displays and sorts by (sort == filter == display, D-1).
 * Uses ctx.wonStageIds + ctx.estimatingStageIds for classification.
 */
export function buildValueRangePredicate(input: DealFilterBarInput, ctx: DealFilterContext = {}): SQL | undefined {
  if (isMalformedNumber(input.valueMin) || isMalformedNumber(input.valueMax)) return sql`false`;
  const min = finiteNumber(input.valueMin);
  const max = finiteNumber(input.valueMax);
  if (min === undefined && max === undefined) return undefined;
  const value = aliasedStageAwareEffectiveDealValueSql(
    "deals",
    ctx.wonStageIds ?? [],
    ctx.estimatingStageIds ?? [],
    ctx.lostStageIds ?? []
  );
  if (min !== undefined && max !== undefined) return sql`${value} BETWEEN ${min} AND ${max}`;
  if (min !== undefined) return sql`${value} >= ${min}`;
  return sql`${value} <= ${max}`;
}

/**
 * stalled / days-in-stage — age since stage_entered_at. GATED: omitted entirely
 * unless the stage-entry date is reliable (ctx.stageEntryDateEnabled), so legacy
 * import-placeholder stage_entered_at values can't produce false stalls.
 */
export function buildStalledPredicate(
  input: DealFilterBarInput,
  ctx: DealFilterContext = {}
): SQL | undefined {
  if (!ctx.stageEntryDateEnabled) return undefined;
  if (isMalformedNumber(input.minAgeDays) || isMalformedNumber(input.maxAgeDays)) return sql`false`;
  const min = finiteNumber(input.minAgeDays);
  const max = finiteNumber(input.maxAgeDays);
  if (min === undefined && max === undefined) return undefined;
  // Hold-aware effective stage age, matching the "days in stage" the list shows
  // (Codex #546) — not raw wall-clock since stage_entered_at.
  const age = aliasedEffectiveStageAgeDaysSql("deals");
  if (min !== undefined && max !== undefined) return sql`${age} BETWEEN ${min} AND ${max}`;
  if (min !== undefined) return sql`${age} >= ${min}`;
  return sql`${age} <= ${max}`;
}

/**
 * outcome-aware date — the canonical platform-wide model (deal-date-scope):
 * Won rows window on the won date, Lost rows on the lost date, open rows on
 * stage entry only when the flag is on (otherwise current-state). Delegates to
 * the shared {@link buildDealOutcomeDateScope} so other surfaces share the axis.
 */
export function buildOutcomeAwareDatePredicate(
  input: DealFilterBarInput,
  ctx: DealFilterContext = {}
): SQL | undefined {
  return buildDealOutcomeDateScope({ from: input.dateFrom, to: input.dateTo }, ctx);
}

/** Exclude on-hold (migration parking-lot) deals — the SAME predicate the Won board/summary uses
 *  (reportableDealFilterSql). Opt-in via input.excludeOnHold; undefined → no narrowing. */
export function buildExcludeOnHoldPredicate(input: DealFilterBarInput): SQL | undefined {
  return input.excludeOnHold ? aliasedActiveDealCountFilterSql("deals") : undefined;
}

export type DealFilterPredicate = (
  input: DealFilterBarInput,
  ctx: DealFilterContext
) => SQL | undefined;

/** The registry: one entry per FilterBar dimension, all AND-combinable. */
export const DEAL_FILTER_PREDICATES: DealFilterPredicate[] = [
  (input) => buildAssignedRepPredicate(input),
  (input) => buildRegionPredicate(input),
  (input) => buildProjectTypePredicate(input),
  (input) => buildWorkflowRoutePredicate(input),
  (input, ctx) => buildStatusPredicate(input, ctx),
  (input, ctx) => buildValueRangePredicate(input, ctx),
  (input, ctx) => buildStalledPredicate(input, ctx),
  (input, ctx) => buildOutcomeAwareDatePredicate(input, ctx),
  (input) => buildExcludeOnHoldPredicate(input),
];

/**
 * Driver: run every predicate, drop the unset (undefined) ones. The caller AND's
 * the result with its existing scope/office/search conditions. Empty input ->
 * empty array -> no narrowing (graceful by construction).
 */
export function buildDealFilterBarConditions(
  input: DealFilterBarInput,
  ctx: DealFilterContext
): SQL[] {
  return DEAL_FILTER_PREDICATES.map((predicate) => predicate(input, ctx)).filter(
    (condition): condition is SQL => condition !== undefined
  );
}
