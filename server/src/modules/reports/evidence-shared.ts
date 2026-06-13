import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";

// ===================== SHARED DRILL-TO-EVIDENCE PRIMITIVES =====================
// The report-agnostic pieces behind every report's drill-to-evidence (Director Scorecard, Forecast
// Accuracy, Analytics Tier-4). The reconciliation guarantee — SUM/COUNT(evidence rows) === the headline
// number — is the CALLER's job: each report builds its own FROM + JOINs + WHERE to match its aggregate's
// cohort EXACTLY. This module supplies only the parts that are genuinely identical across reports: the row
// shape, the SELECT column projection, the additive dimension joins, the rep-scope predicate, the row->record
// mapper, and the scope resolver. (Unifying the Monday Showcase report's own EvidenceRecord into here is a
// deliberate later step — its gold-standard tests must stay green, so it is left untouched for now.)
//
// The user/office join is INTENTIONALLY *not* shared: Tier-2 (Director/Forecast) INNER-joins users+offices so
// its evidence cohort is row-identical to its INNER-joined aggregate (unassigned deals drop on both sides),
// whereas Tier-4 (Market Mix / Customer Concentration) LEFT-joins users and scopes office via an EXISTS — so
// unassigned deals STAY in the cohort there. Each report writes that join itself, around these shared columns.

type TenantDb = NodePgDatabase<typeof schema>;
type ExecuteRows = { rows: unknown[] } | unknown[];

function rowsFromExecute<T>(result: ExecuteRows): T[] {
  return (Array.isArray(result) ? result : result.rows) as T[];
}

function numberValue(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

/** Drill scope header: office-wide (reconciles to the office figure), a single rep, or a single region
 *  (null repId/regionId = the Unassigned bucket). */
export type EvidenceScope =
  | { kind: "office" }
  | { kind: "rep"; repId: string | null; repName: string }
  | { kind: "region"; regionId: string | null; regionName: string };

/** A single supporting deal row behind a report number. */
export interface ReportEvidenceRecord {
  id: string;
  dealNumber: string | null;
  name: string;
  repId: string | null;
  repName: string;
  stageLabel: string;
  /** this row's contribution in the metric's $ basis. */
  value: number | null;
  /** the canonical date this row sits on for THIS metric (won close / lost date / expected / created). */
  cohortDate: string | null;
  companyName: string | null;
  region: string | null;
  dealType: string | null;
  daysInStage: number | null;
}

export interface ReportEvidenceTotal {
  count: number;
  /** SUM of the rows' value in the metric's basis (a COUNT-based metric reconciles on `count`). */
  value: number | null;
  basisLabel: string | null;
}

/** The raw SQL-row shape returned by a query built with evidenceSelectColumnsSql. */
export interface ReportEvidenceRow {
  id: string;
  deal_number: string | null;
  name: string;
  rep_id: string | null;
  rep_name: string;
  stage_label: string;
  value: string | number | null;
  cohort_date: unknown;
  company_name: string | null;
  region: string | null;
  deal_type: string | null;
  days_in_stage: unknown;
}

/**
 * The shared SELECT column projection for a deal-evidence row: identity + owner/stage/value/cohort-date + the
 * drill columns (company, region, deal type, days-in-stage). References d / psc / u / c / rc / ptc — the
 * caller MUST join those (psc for the stage, u for the rep name, and EVIDENCE_DEAL_DIMENSION_JOINS for c/rc/ptc).
 * `valueSql` is this metric's per-row $ contribution and `cohortDateSql` its canonical date.
 */
export function evidenceSelectColumnsSql(valueSql: SQL, cohortDateSql: SQL): SQL {
  return sql`
    d.id AS id,
    d.deal_number AS deal_number,
    d.name AS name,
    d.assigned_rep_id AS rep_id,
    -- NULLIF(BTRIM(...)) so a blank/whitespace-only display_name yields '' here -> mapEvidenceRow turns it into
    -- "Unknown rep", matching resolveEvidenceRepName's empty-drill fallback (consistent name with OR without rows).
    COALESCE(NULLIF(BTRIM(u.display_name), ''), '') AS rep_name,
    COALESCE(psc.name, '') AS stage_label,
    COALESCE(${valueSql}, 0)::numeric AS value,
    (${cohortDateSql})::date AS cohort_date,
    COALESCE(c.name, '') AS company_name,
    COALESCE(NULLIF(c.region, ''), NULLIF(rc.name, ''), '') AS region,
    COALESCE(NULLIF(ptc.name, ''), NULLIF(d.project_type, ''), '') AS deal_type,
    ((now() AT TIME ZONE 'America/Chicago')::date - (d.stage_entered_at AT TIME ZONE 'America/Chicago')::date)::int AS days_in_stage
  `;
}

/**
 * The additive dimension LEFT JOINs (companies / region_config / project_type_config) that back the
 * company/region/deal-type columns. All are FK->PK 1:1, so they never change the cohort row set — COUNT(rows)
 * and SUM(value) stay exactly the aggregate's.
 */
export const EVIDENCE_DEAL_DIMENSION_JOINS: SQL = sql`
  LEFT JOIN companies c ON c.id = d.company_id
  LEFT JOIN region_config rc ON rc.id = d.region_id
  LEFT JOIN public.project_type_config ptc ON ptc.id = d.project_type_id
`;

/** Optional per-rep narrowing: undefined = office-wide; null = the Unassigned bucket (IS NULL); a string = that rep UUID. */
export function reportEvidenceRepScopeSql(repId?: string | null): SQL {
  if (repId === undefined) return sql``;
  if (repId === null) return sql` AND d.assigned_rep_id IS NULL`;
  return sql` AND d.assigned_rep_id = ${repId}::uuid`;
}

/** Map a raw evidence SQL row to the typed record. */
export function mapEvidenceRow(r: ReportEvidenceRow): ReportEvidenceRecord {
  return {
    id: String(r.id),
    dealNumber: r.deal_number == null ? null : String(r.deal_number),
    name: r.name,
    repId: r.rep_id == null ? null : String(r.rep_id),
    repName: r.rep_name || (r.rep_id ? "Unknown rep" : "Unassigned"),
    stageLabel: r.stage_label,
    value: numberValue(r.value),
    cohortDate: r.cohort_date == null ? null : String(r.cohort_date).slice(0, 10),
    companyName: r.company_name ? String(r.company_name) : null,
    region: r.region ? String(r.region) : null,
    dealType: r.deal_type ? String(r.deal_type) : null,
    daysInStage: r.days_in_stage == null ? null : Number(r.days_in_stage),
  };
}

/** Build the total that EQUALS the headline number (count of rows + sum of their value). */
export function buildEvidenceTotal(records: ReportEvidenceRecord[], basisLabel: string): ReportEvidenceTotal {
  return {
    count: records.length,
    value: records.reduce((sum, rec) => sum + (rec.value ?? 0), 0),
    basisLabel,
  };
}

/** Resolve the drill scope: office-wide when no rep; else the rep (name from the rows, or looked up if empty). */
export async function resolveEvidenceScope(
  db: TenantDb,
  repId: string | null | undefined,
  records: ReportEvidenceRecord[]
): Promise<EvidenceScope> {
  if (repId === undefined) return { kind: "office" };
  const repName = records.find((rec) => rec.repId === (repId ?? null))?.repName ?? (await resolveEvidenceRepName(db, repId));
  return { kind: "rep", repId: repId ?? null, repName };
}

/**
 * Resolve a rep's display name for the scope header when the drill returned no rows. A NULL / blank /
 * whitespace-only display_name normalizes to "Unknown rep" — matching mapEvidenceRow's populated-row fallback,
 * so the scope header is consistent whether or not the drill returned rows.
 */
export async function resolveEvidenceRepName(db: TenantDb, repId: string | null): Promise<string> {
  if (repId == null) return "Unassigned";
  const rows = rowsFromExecute<{ name: string | null }>(
    await db.execute(sql`SELECT NULLIF(BTRIM(display_name), '') AS name FROM users WHERE id = ${repId}::uuid`)
  );
  return rows[0]?.name ?? "Unknown rep";
}
