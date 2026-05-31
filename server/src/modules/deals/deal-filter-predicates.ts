import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { deals } from "@trock-crm/shared/schema";
import { aliasedEffectiveDealValueSql, aliasedEffectiveWonDealValueSql } from "../shared/deal-value-sql.js";
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
}

/** Context shared by the gated/classified predicates (date + stalled). */
export type DealFilterContext = DealDateScopeContext;

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** assigned rep — eq, or IS NULL for the Unassigned sentinel. */
export function buildAssignedRepPredicate(input: DealFilterBarInput): SQL | undefined {
  if (!input.assignedRepId) return undefined;
  return input.assignedRepId === UNASSIGNED_FILTER_SENTINEL
    ? isNull(deals.assignedRepId)
    : eq(deals.assignedRepId, input.assignedRepId);
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
      return sql`coalesce(${deals.onHold}, false) = true`;
    case "inactive":
      return eq(deals.isActive, false);
    default:
      return sql`false`;
  }
}

/**
 * Stage-aware effective deal value, mirroring getEffectiveDealValue
 * (shared/src/types/deal-hold.ts): Won deals report awarded-first, open deals
 * report best-estimate-first, both on-hold-zeroed. This is the value the list
 * DISPLAYS, so the value filter and the value sort use it too (sort == filter ==
 * display, D-1; Codex #546). Falls back to the open chain when no Won stage ids
 * are resolved (e.g. value filter without classification) — graceful, never
 * broken SQL. Won classification is by stage id so no pipeline_stage_config join
 * is needed (the deals row carries stage_id).
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
  const entered = sql`COALESCE(${col("bid_board_stage_entered_at")}, ${col("stage_entered_at")})`;
  const elapsed = sql`EXTRACT(EPOCH FROM (now() - ${entered}))`;
  // Completed hold time accrued since this stage was entered (snapshot delta).
  const accumulatedSinceEntry = sql`CASE
    WHEN ${col("on_hold_accumulated_seconds_at_stage_entry")} IS NULL THEN 0
    ELSE GREATEST(0, COALESCE(${col("on_hold_accumulated_seconds")}, 0) - ${col("on_hold_accumulated_seconds_at_stage_entry")})
  END`;
  // The currently-open hold interval, if the deal is on hold right now.
  const openHold = sql`CASE
    WHEN ${col("on_hold")} AND ${col("on_hold_started_at")} IS NOT NULL
      THEN GREATEST(0, EXTRACT(EPOCH FROM (now() - ${col("on_hold_started_at")})))
    ELSE 0
  END`;
  return sql`FLOOR(GREATEST(0, ${elapsed} - ${accumulatedSinceEntry} - ${openHold}) / 86400)`;
}

/**
 * value range — BETWEEN on the STAGE-AWARE effective value (awarded-first for Won
 * stages, best-estimate otherwise), the same number the list displays and sorts
 * by (sort == filter == display, D-1). Uses ctx.wonStageIds for classification.
 */
export function buildValueRangePredicate(input: DealFilterBarInput, ctx: DealFilterContext): SQL | undefined {
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
  ctx: DealFilterContext
): SQL | undefined {
  if (!ctx.stageEntryDateEnabled) return undefined;
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
  ctx: DealFilterContext
): SQL | undefined {
  return buildDealOutcomeDateScope({ from: input.dateFrom, to: input.dateTo }, ctx);
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
