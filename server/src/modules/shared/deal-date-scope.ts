import { and, or, sql, type SQL } from "drizzle-orm";
import { deals } from "@trock-crm/shared/schema";

/**
 * Canonical Won-close date — the protected 191 / $9,778,045.90 basis. Prefers the
 * authoritative HubSpot close-won timestamp, falling back to the CRM
 * contract-signed date for deals predating that field. Byte-identical to the
 * wonClosedDateExpr the getDeals Won-period drill-down uses (which self-documents
 * as "Mirrors getWonCloseSummary exactly"). Adopting this date-scope function for
 * Won therefore cannot move the basis (GREY audit §5 / Codex #546). `col` maps a
 * column name to its SQL fragment (aliased or unaliased).
 */
function canonicalWonCloseDateSql(col: (name: string) => SQL): SQL {
  return sql`COALESCE(
    NULLIF(${col("hubspot_extra_properties")}->>'hs_closed_won_date', '')::date,
    ${col("contract_signed_at")}::date,
    ${col("contract_signed_date")}
  )`;
}

/**
 * CANONICAL PLATFORM-WIDE deal date-scoping model.
 *
 * One date window, three outcome axes, classified per row by its stage:
 *   - Won rows  -> the CANONICAL won-close date (canonicalWonCloseDateSql):
 *                  COALESCE(NULLIF(hs_closed_won_date,'')::date,
 *                  contract_signed_at::date, contract_signed_date) — the SAME
 *                  expression getWonCloseSummary / the getDeals Won drill-down use,
 *                  i.e. the protected 191 / $9,778,045.90 basis. The
 *                  hs_closed_won_date primary is what makes it canonical; a plain
 *                  contract_signed COALESCE (the old value here) silently diverged
 *                  from the basis. GREY audit §5 / Codex #546.
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
    // Canonical Won-close basis (matches getWonCloseSummary / the getDeals Won
    // drill-down), NOT a bare contract_signed chain — so adopting this function
    // for Won never moves the protected 191 / $9,778,045.90 total.
    wonDate: canonicalWonCloseDateSql((name) => sql.raw(`"deals"."${name}"`)),
    lostDate: sql`${deals.lostAt}::date`,
    stageEntryDate: sql`${deals.stageEnteredAt}::date`,
  };
}

/** Column fragments for a raw-SQL query that aliases the deals table (e.g. `d`). */
export function aliasedDealDateScopeColumns(alias: string): DealDateScopeColumns {
  const col = (name: string) => sql.raw(`${alias}.${name}`);
  return {
    stageId: sql`${col("stage_id")}`,
    // Canonical Won-close basis (see dealDateScopeColumns) for the aliased table.
    wonDate: canonicalWonCloseDateSql((name) => sql.raw(`${alias}.${name}`)),
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

  // A date window needs at least one resolved outcome class to classify rows.
  // If BOTH the Won and Lost stage-id sets are empty (a pipeline_stage_config
  // misconfiguration — the canonical WON/LOST slug sets resolve in a healthy
  // install), every row would fall to the open branch and the window would match
  // ALL rows. Rather than 500 a date-filtered endpoint (Codex #546) or silently
  // apply a mis-classified window, SKIP the date predicate: return undefined so
  // the caller omits it and still returns rows (date simply isn't applied —
  // honest degradation, since the filter can't be correct without classification).
  const hasWon = (ctx.wonStageIds?.length ?? 0) > 0;
  const hasLost = (ctx.lostStageIds?.length ?? 0) > 0;
  if (!hasWon && !hasLost) return undefined;

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

/**
 * The DISPLAYED date for a deal row, by outcome — the companion to
 * {@link buildDealOutcomeDateScope}. Returns ONE CASE expression giving each row
 * the date the UI should show for it:
 *   Won rows  -> won/signed date    (columns.wonDate)
 *   Lost rows -> lost date          (columns.lostDate)
 *   open rows -> entered-stage date (columns.stageEntryDate)
 *
 * This is the load-bearing half of "filter-axis == display-axis": it consumes the
 * SAME DealDateScopeColumns and the SAME Won/Lost stage-id classification as the
 * filter, so the date a surface FILTERS on and the date it DISPLAYS can never
 * diverge — change the column source once (DealDateScopeColumns) and both the
 * filter and the display move together. Surfaces SELECT this expression (e.g. as
 * `display_date`) and render it next to the row; GREY's platform date audit wires
 * it into each list query so every surface shows the column it filtered.
 *
 * Unlike the filter, this does NOT throw on empty classification: a display
 * expression must never crash a list render. With no Won/Lost ids every row
 * resolves to its stage-entry date (callers always resolve the canonical sets, so
 * in practice the filter's loud failure fires first). Per row it yields NULL only
 * when that row's own outcome date column is NULL; the caller decides how to
 * render NULL.
 */
export function dealDisplayDateExpr(ctx: DealDateScopeContext): SQL {
  const columns = ctx.columns ?? dealDateScopeColumns();
  const wonMatch = stageMembership(columns.stageId, ctx.wonStageIds);
  const lostMatch = stageMembership(columns.stageId, ctx.lostStageIds);
  return sql`CASE
    WHEN ${wonMatch} THEN ${columns.wonDate}
    WHEN ${lostMatch} THEN ${columns.lostDate}
    ELSE ${columns.stageEntryDate}
  END`;
}
