import { and, or, sql, type SQL } from "drizzle-orm";
import { leads } from "@trock-crm/shared/schema";

/**
 * LEAD date-scoping model — the lead variant of {@link ./deal-date-scope.ts}.
 *
 * Leads have NO Won/Lost outcome and carry no value. Their lifecycle is a single
 * `status` enum (open | converted | disqualified), so — unlike deals, which
 * classify each row by membership in resolved Won/Lost stage-id sets — the lead
 * row classifies itself directly off its `status` column. One date window, three
 * outcome axes, picked per row by status:
 *   - converted    -> converted_at::date
 *   - disqualified -> disqualified_at::date
 *   - open         -> entered-current-stage date, COALESCE(stage_entered_at,
 *                     created_at)::date (the contract's fallback for when
 *                     stage-entry is null/unreliable)
 *
 * Why disqualified uses disqualified_at ALONE (no COALESCE to stage_entered_at):
 * disqualification is a status flip (leads/service.ts updateLead, ~1794) that does
 * NOT change the lead's stage — there is no disqualified stage. So a disqualified
 * lead's stage_entered_at points at its last REAL stage (e.g. qualified_lead),
 * unrelated to the disqualification moment; coalescing onto it would mis-date the
 * row, and there is no disqualified-stage entry in lead_stage_history to read
 * instead. disqualified_at is therefore the only correct axis — exactly the column
 * the contract names.
 *
 * KNOWN DATA GAP (flagged to RED, fix tracked separately): as of this writing NO
 * code path populates disqualified_at — the status-flip writes `status` but not the
 * timestamp, and there is no backfill — so disqualified rows currently fall outside
 * every window and display null. That is the SAME never-widen / graceful behavior
 * the deals leaf uses for a null won_closed_date, and it is forward-compatible:
 * once a writer + backfill land, disqualified rows date correctly with NO change
 * here. The contract's "else the stage-entry timestamp" fallback branch was gated
 * on the column NOT existing; it exists, so the predicate uses it directly.
 *
 * filter-axis == display-axis: {@link buildLeadOutcomeDateScope} (the WHERE
 * predicate) and {@link leadDisplayDateExpr} (the SELECTed `displayDate`) consume
 * the SAME LeadDateScopeColumns and the SAME status classification, so the date a
 * surface FILTERS on and the date it DISPLAYS can never diverge.
 *
 * Graceful by construction: an absent window returns undefined (the caller omits
 * the predicate, never narrowing); a row whose own outcome date is null simply
 * fails its window clause (never widened onto another axis). status is compared as
 * text so the same fragment works against the `lead_status` enum column and a plain
 * text column (PGlite probes / future migrations).
 */

export type LeadStatus = "open" | "converted" | "disqualified";

export interface LeadDateScopeColumns {
  /** The lead's status (classifier: open | converted | disqualified). */
  status: SQL;
  /** Converted date axis (leads.converted_at). */
  convertedDate: SQL;
  /** Disqualified date axis (leads.disqualified_at) — stands alone, never coalesced. */
  disqualifiedDate: SQL;
  /** Open date axis: entered-current-stage date, falling back to created_at. */
  openDate: SQL;
}

/** Column fragments for an UNALIASED `leads` table query (drizzle column refs). */
export function leadDateScopeColumns(): LeadDateScopeColumns {
  return {
    status: sql`${leads.status}`,
    convertedDate: sql`${leads.convertedAt}::date`,
    disqualifiedDate: sql`${leads.disqualifiedAt}::date`,
    openDate: sql`COALESCE(${leads.stageEnteredAt}, ${leads.createdAt})::date`,
  };
}

/** Column fragments for a raw-SQL query that aliases the leads table (e.g. `l`). */
export function aliasedLeadDateScopeColumns(alias: string): LeadDateScopeColumns {
  const col = (name: string) => sql.raw(`${alias}.${name}`);
  return {
    status: sql`${col("status")}`,
    convertedDate: sql`${col("converted_at")}::date`,
    disqualifiedDate: sql`${col("disqualified_at")}::date`,
    openDate: sql`COALESCE(${col("stage_entered_at")}, ${col("created_at")})::date`,
  };
}

export interface LeadDateWindow {
  /** Inclusive lower bound, YYYY-MM-DD. */
  from?: string;
  /** Upper bound, YYYY-MM-DD; applied exclusively as `< to + 1 day`. */
  to?: string;
}

export interface LeadDateScopeContext {
  /** Column source; defaults to the unaliased `leads` table. */
  columns?: LeadDateScopeColumns;
}

/** Inclusive-from / exclusive-next-day-to window on a date expression. */
function dateWithinWindow(dateExpr: SQL, from: string | undefined, to: string | undefined): SQL | undefined {
  const parts: SQL[] = [];
  if (from) parts.push(sql`${dateExpr} >= ${from}::date`);
  if (to) parts.push(sql`${dateExpr} < (${to}::date + interval '1 day')`);
  if (parts.length === 0) return undefined;
  return and(...parts);
}

/** `status = '<value>'`, compared as text so the enum column and a text column both work. */
function statusEquals(statusExpr: SQL, value: LeadStatus): SQL {
  return sql`${statusExpr}::text = ${value}`;
}

/**
 * Build the outcome-aware date predicate for the given window. Returns undefined
 * when no window is set (caller omits it). See the module docstring for the model.
 *
 * Each of the three lead statuses is windowed on its OWN date axis and OR'd
 * together. The three status clauses are mutually exclusive (status is a single
 * enum) and exhaustive, so an unrecognized status matches none of them — excluded,
 * never widened.
 */
export function buildLeadOutcomeDateScope(
  window: LeadDateWindow,
  ctx: LeadDateScopeContext
): SQL | undefined {
  const from = window.from?.trim() || undefined;
  const to = window.to?.trim() || undefined;
  if (!from && !to) return undefined;

  const columns = ctx.columns ?? leadDateScopeColumns();

  const convertedWindow = dateWithinWindow(columns.convertedDate, from, to);
  const disqualifiedWindow = dateWithinWindow(columns.disqualifiedDate, from, to);
  const openWindow = dateWithinWindow(columns.openDate, from, to);

  const clauses: SQL[] = [];
  if (convertedWindow) {
    clauses.push(and(statusEquals(columns.status, "converted"), convertedWindow) as SQL);
  }
  if (disqualifiedWindow) {
    clauses.push(and(statusEquals(columns.status, "disqualified"), disqualifiedWindow) as SQL);
  }
  if (openWindow) {
    clauses.push(and(statusEquals(columns.status, "open"), openWindow) as SQL);
  }

  if (clauses.length === 0) return undefined;
  return or(...clauses);
}

/**
 * The DISPLAYED date for a lead row, by status — the companion to
 * {@link buildLeadOutcomeDateScope}. Returns ONE CASE expression giving each row
 * the date the UI should show for it:
 *   converted    -> converted_at
 *   disqualified -> disqualified_at
 *   open         -> entered-stage date (fallback created_at)
 *
 * This is the load-bearing half of "filter-axis == display-axis": it consumes the
 * SAME LeadDateScopeColumns and the SAME status classification as the filter, so
 * the date a surface FILTERS on and the date it DISPLAYS move together. Surfaces
 * SELECT this expression as `displayDate` and render it next to the row.
 *
 * Unlike the filter, this never throws: an unrecognized status yields NULL (rather
 * than crashing a list render), and per row it yields NULL only when that row's own
 * outcome date column is NULL; the caller decides how to render NULL.
 */
export function leadDisplayDateExpr(ctx: LeadDateScopeContext): SQL {
  const columns = ctx.columns ?? leadDateScopeColumns();
  return sql`CASE
    WHEN ${statusEquals(columns.status, "converted")} THEN ${columns.convertedDate}
    WHEN ${statusEquals(columns.status, "disqualified")} THEN ${columns.disqualifiedDate}
    WHEN ${statusEquals(columns.status, "open")} THEN ${columns.openDate}
    ELSE NULL
  END`;
}
