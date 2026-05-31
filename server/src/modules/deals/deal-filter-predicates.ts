import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { deals } from "@trock-crm/shared/schema";
import { aliasedEffectiveDealValueSql } from "../shared/deal-value-sql.js";
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
 * value range — BETWEEN on the on-hold-zeroed best-estimate chain, i.e. the SAME
 * expression the list sorts and displays by (sort == filter == display, D-1).
 */
export function buildValueRangePredicate(input: DealFilterBarInput): SQL | undefined {
  const min = finiteNumber(input.valueMin);
  const max = finiteNumber(input.valueMax);
  if (min === undefined && max === undefined) return undefined;
  const value = aliasedEffectiveDealValueSql("deals");
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
  const age = sql`extract(day from now() - ${deals.stageEnteredAt})`;
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
  (input) => buildValueRangePredicate(input),
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
