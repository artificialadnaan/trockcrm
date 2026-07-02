import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export interface QcScorecardsFilters {
  from: string; // yyyy-mm-dd (week_of lower bound)
  to: string; // yyyy-mm-dd (week_of upper bound)
  regionId?: string | null;
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

const MAX_ROWS = 500;

/**
 * Office-scoped QC report: every Field Scorecard whose week falls in [from, to], joined to its deal for the
 * project name/region, with server-side filters (region, superintendent, rating, flagged-only, search)
 * applied BEFORE the row cap. Returns the flat list; the dashboard derives the stat strip + card drill-downs
 * client-side from it (so a KPI card always opens exactly the rows it counts). Newest submission first.
 */
export async function getQcScorecardsReport(
  tenantDb: TenantDb,
  filters: QcScorecardsFilters,
): Promise<{ scorecards: QcScorecardRow[] }> {
  const conditions = [
    sql`sc.is_active = true`,
    sql`sc.week_of >= ${filters.from}`,
    sql`sc.week_of <= ${filters.to}`,
  ];
  if (filters.regionId) conditions.push(sql`d.region_id = ${filters.regionId}::uuid`);
  if (filters.rating) conditions.push(sql`sc.rating = ${filters.rating}`);
  if (filters.flaggedOnly) conditions.push(sql`COALESCE(array_length(sc.critical_deficiencies, 1), 0) > 0`);
  if (filters.superintendent) conditions.push(sql`sc.superintendent_name ILIKE ${`%${filters.superintendent}%`}`);
  if (filters.search) {
    const term = `%${filters.search}%`;
    conditions.push(
      sql`(d.name ILIKE ${term} OR sc.project_number ILIKE ${term} OR sc.superintendent_name ILIKE ${term})`,
    );
  }
  const where = sql.join(conditions, sql` AND `);

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
    FROM field_scorecards sc
    JOIN deals d ON d.id = sc.deal_id
    LEFT JOIN public.region_config rc ON rc.id = d.region_id
    WHERE ${where}
    ORDER BY sc.submitted_at DESC
    LIMIT ${MAX_ROWS}
  `);

  const rows = (((result as any).rows ?? result) as any[]) ?? [];
  return {
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
