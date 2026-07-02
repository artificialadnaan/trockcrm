import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { WON_STAGE_SLUGS, LOST_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";

type TenantDb = NodePgDatabase<typeof schema>;

const textArray = (values: readonly string[]) =>
  sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;

export interface QcScorecardsFilters {
  from: string; // yyyy-mm-dd (week_of lower bound)
  to: string; // yyyy-mm-dd (week_of upper bound)
  region?: string | null; // region NAME (matches region_config.name)
  superintendent?: string | null;
  rating?: string | null;
  flaggedOnly?: boolean;
  search?: string | null;
}

export interface QcScorecardRow {
  scorecardId: string;
  dealId: string;
  projectName: string;
  projectNumber: string | null;
  regionName: string | null;
  superintendentName: string | null;
  totalScore: number;
  rating: string;
  deficiencyCount: number;
  weekOf: string;
  submittedAt: string;
  submittedByName: string | null;
  pdfAvailable: boolean;
}

// High enough to be non-binding for a single office's week window (a real office rarely has this many
// scorecards in a few weeks). If it's ever hit, `truncated` lets the UI say so instead of silently dropping.
const MAX_ROWS = 1000;

/**
 * Office-scoped QC report: every Field Scorecard whose week falls in [from, to], joined to its deal for the
 * project name/region, with server-side filters (region, superintendent, rating, flagged-only, search)
 * applied BEFORE the row cap. Returns the flat list; the dashboard derives the stat strip + card drill-downs
 * client-side from it (so a KPI card always opens exactly the rows it counts). Newest submission first.
 */
export async function getQcScorecardsReport(
  tenantDb: TenantDb,
  filters: QcScorecardsFilters,
): Promise<{ scorecards: QcScorecardRow[]; truncated: boolean; regions: string[]; superintendents: string[] }> {
  // Live/won projects only — mirror the field list's activeProjectWhere off the same WON/LOST slug source of
  // truth: active deal, not terminal (or a Won-family stage), never Lost. Keeps archived/Lost projects out.
  const stageSlug = sql`COALESCE(psc.slug, d.bid_board_stage_slug, '')`;
  const FROM = sql`
    FROM field_scorecards sc
    JOIN deals d ON d.id = sc.deal_id
    LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
    LEFT JOIN public.region_config rc ON rc.id = d.region_id
  `;
  // The WINDOW predicate = live-project gate + week range. It bounds BOTH the filter-option lists (so the
  // dropdowns stay fully populated) AND the row list. The interactive filters are added ON TOP for the rows.
  const windowConditions = [
    sql`sc.is_active = true`,
    sql`d.is_active = true`,
    sql`(COALESCE(psc.is_terminal, false) = false OR ${stageSlug} = ANY(${textArray(WON_STAGE_SLUGS)}))`,
    // A deal is Lost if EITHER its CRM stage slug OR its Bid Board mirror slug is Lost — a BB-owned deal can
    // be closed_lost in bid_board_stage_slug while its CRM stage_id is still open (see deal-filter-
    // predicates). Checking only the COALESCE'd slug (psc.slug first) would let that stale row through.
    sql`COALESCE(psc.slug, '') <> ALL(${textArray(LOST_STAGE_SLUGS)})`,
    sql`COALESCE(d.bid_board_stage_slug, '') <> ALL(${textArray(LOST_STAGE_SLUGS)})`,
    sql`sc.week_of >= ${filters.from}`,
    sql`sc.week_of <= ${filters.to}`,
  ];
  const rowConditions = [...windowConditions];
  // Interactive filters applied SERVER-SIDE (before the cap) so a match older than the most-recent cap
  // window is never dropped.
  if (filters.region) rowConditions.push(sql`rc.name = ${filters.region}`);
  if (filters.rating) rowConditions.push(sql`sc.rating = ${filters.rating}`);
  if (filters.flaggedOnly) rowConditions.push(sql`COALESCE(array_length(sc.critical_deficiencies, 1), 0) > 0`);
  // Exact match, not a contains-ILIKE: the dropdown options are verbatim names from this same column, so a
  // substring predicate would over-match (selecting "Ann" would also return "Joann", "Sam Reyes" → "…Jr").
  if (filters.superintendent) rowConditions.push(sql`sc.superintendent_name = ${filters.superintendent}`);
  if (filters.search) {
    const term = `%${filters.search}%`;
    rowConditions.push(
      sql`(d.name ILIKE ${term} OR sc.project_number ILIKE ${term} OR sc.superintendent_name ILIKE ${term})`,
    );
  }

  // Distinct region + superintendent options across the WHOLE window (independent of the interactive
  // filters), so selecting one filter never empties the other dropdown.
  const optResult = await tenantDb.execute(sql`
    SELECT
      COALESCE(array_agg(DISTINCT rc.name) FILTER (WHERE rc.name IS NOT NULL), '{}') AS "regions",
      COALESCE(array_agg(DISTINCT sc.superintendent_name) FILTER (WHERE sc.superintendent_name IS NOT NULL), '{}') AS "superintendents"
    ${FROM}
    WHERE ${sql.join(windowConditions, sql` AND `)}
  `);
  const optRow = (((optResult as any).rows ?? optResult) as any[])[0] ?? {};

  const result = await tenantDb.execute(sql`
    SELECT
      sc.id AS "scorecardId",
      sc.deal_id AS "dealId",
      d.name AS "projectName",
      sc.project_number AS "projectNumber",
      rc.name AS "regionName",
      sc.superintendent_name AS "superintendentName",
      sc.total_score AS "totalScore",
      sc.rating AS "rating",
      COALESCE(array_length(sc.critical_deficiencies, 1), 0) AS "deficiencyCount",
      sc.week_of::text AS "weekOf",
      sc.submitted_at AS "submittedAt",
      sc.submitted_by_name AS "submittedByName",
      (sc.pdf_r2_key IS NOT NULL) AS "pdfAvailable"
    ${FROM}
    WHERE ${sql.join(rowConditions, sql` AND `)}
    ORDER BY sc.submitted_at DESC
    LIMIT ${MAX_ROWS + 1}
  `);

  // Fetch one extra row so an exact-MAX_ROWS match isn't mislabeled as truncated. If the sentinel row came
  // back, drop it and flag truncated; otherwise nothing was cut.
  const allRows = (((result as any).rows ?? result) as any[]) ?? [];
  const truncated = allRows.length > MAX_ROWS;
  const rows = truncated ? allRows.slice(0, MAX_ROWS) : allRows;
  return {
    truncated,
    regions: (optRow.regions ?? []).slice().sort(),
    superintendents: (optRow.superintendents ?? []).slice().sort(),
    scorecards: rows.map((r) => ({
      scorecardId: String(r.scorecardId),
      dealId: String(r.dealId),
      projectName: r.projectName ?? "Untitled project",
      projectNumber: r.projectNumber ?? null,
      regionName: r.regionName ?? null,
      superintendentName: r.superintendentName ?? null,
      totalScore: Number(r.totalScore ?? 0),
      rating: String(r.rating),
      deficiencyCount: Number(r.deficiencyCount ?? 0),
      weekOf: typeof r.weekOf === "string" ? r.weekOf : String(r.weekOf),
      submittedAt: r.submittedAt instanceof Date ? r.submittedAt.toISOString() : String(r.submittedAt),
      submittedByName: r.submittedByName ?? null,
      pdfAvailable: r.pdfAvailable === true || r.pdfAvailable === "t" || r.pdfAvailable === 1,
    })),
  };
}
