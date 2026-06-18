import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { deals } from "@trock-crm/shared/schema";
import {
  aliasedActiveDealCountFilterSql,
  aliasedEffectiveDealValueSql,
  aliasedEffectiveWonDealValueSql,
} from "../shared/deal-value-sql.js";
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
export type DealFilterContext = DealDateScopeContext;

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

/** assigned rep — matches assigned_rep OR estimator (id-or-id), or IS NULL for the Unassigned sentinel. */
export function buildAssignedRepPredicate(input: DealFilterBarInput): SQL | undefined {
  if (!input.assignedRepId) return undefined;
  return buildInvolvedRepCondition(input.assignedRepId);
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
 */
export function buildStatusPredicate(input: DealFilterBarInput): SQL | undefined {
  const value = input.status;
  // Absent / empty / "any" omits (no narrowing). An unrecognized value falls to
  // the default no-match sentinel rather than silently omitting (contract §3).
  if (value === undefined || value === "" || value === "any") return undefined;
  switch (value) {
    case "active":
      return and(eq(deals.isActive, true), sql`coalesce(${deals.onHold}, false) = false`);
    case "on_hold":
      // On-Hold is a CURRENT-deals view (a subset of active, paused), so require
      // is_active=true too — else a soft-deleted deal (deleteDeal sets is_active
      // false but leaves on_hold set) would reappear here (Codex #546). A deal
      // both inactive AND on-hold belongs under Inactive, not On-Hold.
      return and(eq(deals.isActive, true), sql`coalesce(${deals.onHold}, false) = true`);
    case "inactive":
      return eq(deals.isActive, false);
    default:
      return sql`false`;
  }
}

/**
 * Stage-aware effective deal value, mirroring getEffectiveDealValue
 * (shared/src/types/deal-hold.ts). As of the 2026-06-18 awarded-first unification both the
 * Won and open chains resolve through the SAME DEAL_VALUE_PRIORITY_CHAIN
 * (awarded > bid_board > bid > dd), so the stage_id CASE branches below are byte-identical —
 * the split is retained only as a future-divergence hook (and is harmless). Both are
 * on-hold-zeroed. This is the value the list DISPLAYS, so the value filter and the value sort
 * use it too (sort == filter == display, D-1; Codex #546). Won classification is by stage id
 * so no pipeline_stage_config join is needed (the deals row carries stage_id).
 */
export function aliasedStageAwareEffectiveDealValueSql(alias: string, wonStageIds: string[]): SQL {
  const openValue = aliasedEffectiveDealValueSql(alias);
  if (wonStageIds.length === 0) return openValue;
  const wonValue = aliasedEffectiveWonDealValueSql(alias);
  const stageId = sql.raw(`${alias}.stage_id`);
  const ids = sql.join(wonStageIds.map((id) => sql`${id}`), sql`, `);
  return sql`CASE WHEN ${stageId} IN (${ids}) THEN ${wonValue} ELSE ${openValue} END`;
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
 * value range — BETWEEN on the STAGE-AWARE effective value (awarded-first for Won
 * stages, best-estimate otherwise), the same number the list displays and sorts
 * by (sort == filter == display, D-1). Uses ctx.wonStageIds for classification.
 */
export function buildValueRangePredicate(input: DealFilterBarInput, ctx: DealFilterContext = {}): SQL | undefined {
  if (isMalformedNumber(input.valueMin) || isMalformedNumber(input.valueMax)) return sql`false`;
  const min = finiteNumber(input.valueMin);
  const max = finiteNumber(input.valueMax);
  if (min === undefined && max === undefined) return undefined;
  const value = aliasedStageAwareEffectiveDealValueSql("deals", ctx.wonStageIds ?? []);
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
  (input) => buildStatusPredicate(input),
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
