import { and, or, sql, type SQL } from "drizzle-orm";
import { deals } from "@trock-crm/shared/schema";

/**
 * CANONICAL PLATFORM-WIDE deal date-scoping model.
 *
 * One date window, three outcome axes, classified per row by its stage:
 *   - Won rows  -> the won/signed date: COALESCE(contract_signed_at::date,
 *                  contract_signed_date)              (reliable now)
 *   - Lost rows -> lost_at::date                       (reliable now)
 *   - Open rows -> entered-current-stage date (stage_entered_at::date), applied
 *                  ONLY when the stage-entry date is reliable
 *                  (stageEntryDateEnabled / FEATURE_STAGE_ENTRY_DATE). When the
 *                  flag is off, open rows are NOT date-bounded — they pass through
 *                  as current-state and are labeled honestly by the UI, never
 *                  silently dropped (design .audit/shared-filterbar-design.md §5).
 *
 * This is the single source of truth for "filter a deal list by date" so the
 * filter axis matches the displayed date axis on every surface (deals list, rep
 * drill-down, board, reports) — fixing the platform-wide "filtered by created
 * date but shown by close date" mismatch. The deals list (getDeals) consumes it
 * via the FilterBar predicate registry; other surfaces adopt the same function
 * (use {@link aliasedDealDateScopeColumns} for raw-SQL queries that alias deals).
 *
 * Graceful by construction: an empty Won/Lost stage-id set degrades to a `false`
 * membership sentinel (never an invalid `IN ()`); an absent window returns
 * undefined (the caller omits it — no narrowing).
 */

export interface DealDateScopeColumns {
  /** The deal's current stage id (for Won/Lost classification). */
  stageId: SQL;
  /** Won/signed date axis. */
  wonDate: SQL;
  /** Lost date axis. */
  lostDate: SQL;
  /** Entered-current-stage date axis (open rows, flag-gated). */
  stageEntryDate: SQL;
}

/** Column fragments for an UNALIASED `deals` table query (drizzle column refs). */
export function dealDateScopeColumns(): DealDateScopeColumns {
  return {
    stageId: sql`${deals.stageId}`,
    wonDate: sql`COALESCE(${deals.contractSignedAt}::date, ${deals.contractSignedDate})`,
    lostDate: sql`${deals.lostAt}::date`,
    stageEntryDate: sql`${deals.stageEnteredAt}::date`,
  };
}

/** Column fragments for a raw-SQL query that aliases the deals table (e.g. `d`). */
export function aliasedDealDateScopeColumns(alias: string): DealDateScopeColumns {
  const col = (name: string) => sql.raw(`${alias}.${name}`);
  return {
    stageId: sql`${col("stage_id")}`,
    wonDate: sql`COALESCE(${col("contract_signed_at")}::date, ${col("contract_signed_date")})`,
    lostDate: sql`${col("lost_at")}::date`,
    stageEntryDate: sql`${col("stage_entered_at")}::date`,
  };
}

export interface DealDateWindow {
  /** Inclusive lower bound, YYYY-MM-DD. */
  from?: string;
  /** Upper bound, YYYY-MM-DD; applied exclusively as `< to + 1 day`. */
  to?: string;
}

export interface DealDateScopeContext {
  /** Stage ids classified as Won. Empty/undefined => no row is treated as Won. */
  wonStageIds?: string[];
  /** Stage ids classified as Lost. Empty/undefined => no row is treated as Lost. */
  lostStageIds?: string[];
  /** When true, open rows are bounded by stage_entry date; otherwise they pass through. */
  stageEntryDateEnabled?: boolean;
  /** Column source; defaults to the unaliased `deals` table. */
  columns?: DealDateScopeColumns;
}

/** `stageId IN (...)`, or a `false` sentinel for an empty/missing set (never `IN ()`). */
function stageMembership(stageId: SQL, ids: string[] | undefined): SQL {
  if (!ids || ids.length === 0) return sql`false`;
  return sql`${stageId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
}

/** Inclusive-from / exclusive-next-day-to window on a date expression. */
function dateWithinWindow(dateExpr: SQL, from: string | undefined, to: string | undefined): SQL | undefined {
  const parts: SQL[] = [];
  if (from) parts.push(sql`${dateExpr} >= ${from}::date`);
  if (to) parts.push(sql`${dateExpr} < (${to}::date + interval '1 day')`);
  if (parts.length === 0) return undefined;
  return and(...parts);
}

/**
 * Build the outcome-aware date predicate for the given window. Returns undefined
 * when no window is set (caller omits it). See the module docstring for the model.
 */
export function buildDealOutcomeDateScope(
  window: DealDateWindow,
  ctx: DealDateScopeContext
): SQL | undefined {
  const from = window.from?.trim() || undefined;
  const to = window.to?.trim() || undefined;
  if (!from && !to) return undefined;

  // A date window requires at least one resolved outcome class. If BOTH the Won
  // and Lost stage-id sets are empty, every row falls to the open branch
  // (openMatch = NOT(false OR false) = TRUE), so the window would silently match
  // ALL rows and out-of-window Won/Lost deals would leak in. That is a pipeline
  // stage-config failure (the canonical WON/LOST slug sets always resolve in a
  // healthy install), NOT user input — so fail loudly here rather than return a
  // mis-filtered result. Protects every surface that adopts this function.
  const hasWon = (ctx.wonStageIds?.length ?? 0) > 0;
  const hasLost = (ctx.lostStageIds?.length ?? 0) > 0;
  if (!hasWon && !hasLost) {
    throw new Error(
      "buildDealOutcomeDateScope: a date window was requested but no Won or Lost stage ids resolved — " +
        "cannot classify deal outcomes for date filtering (check pipeline_stage_config)."
    );
  }

  const columns = ctx.columns ?? dealDateScopeColumns();
  const wonMatch = stageMembership(columns.stageId, ctx.wonStageIds);
  const lostMatch = stageMembership(columns.stageId, ctx.lostStageIds);
  const openMatch = sql`NOT (${or(wonMatch, lostMatch)})`;

  const wonWindow = dateWithinWindow(columns.wonDate, from, to);
  const lostWindow = dateWithinWindow(columns.lostDate, from, to);
  const openWindow = dateWithinWindow(columns.stageEntryDate, from, to);

  const clauses: SQL[] = [];
  if (wonWindow) clauses.push(and(wonMatch, wonWindow) as SQL);
  if (lostWindow) clauses.push(and(lostMatch, lostWindow) as SQL);
  // Flag off: open rows are current-state — included regardless of the window
  // (honest, never silently dropped). Flag on: bounded by stage-entry date.
  clauses.push(
    ctx.stageEntryDateEnabled && openWindow ? (and(openMatch, openWindow) as SQL) : openMatch
  );

  return or(...clauses);
}
