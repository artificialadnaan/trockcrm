import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, pipelineStageConfig, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { UserRole } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import {
  aliasedActiveDealCountFilterSql,
  aliasedEffectiveDealValueSql,
  aliasedReportableDealFilterSql,
  aliasedWonHsClosedWonDateSql,
} from "../shared/deal-value-sql.js";
import { aliasedHasUsableWonDateSql } from "../deals/service.js";
import { LOST_STAGE_SLUGS, WON_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";

const WON_STAGE_SLUG_SET = new Set<string>(WON_STAGE_SLUGS);

// Decision 1 (Won-date unification): a custom report whose cohort is filtered to WON stage(s)
// ONLY is "Won-measuring" — its deal_count / total_value ARE won count / won revenue. For such a
// report the period axis (the from/to range AND the month/week time-bucket) is FORCED onto the
// canonical deals.won_closed_date, regardless of the user's selected date field, so a Won total is
// never reported on a non-Won basis (e.g. updated_at, which counts touched-in-period as won-in-
// period). "Deals CREATED this period that are now Won" stays a distinct report (a non-Won-only
// stage filter, or no stage filter, keeps the user's chosen date field). A mixed won+lost/open
// stage filter is NOT Won-scoped — the cohort isn't a Won total, so the user's axis is preserved.
function isWonScopedReport(filters: Record<string, unknown>): boolean {
  const stages = listFilter(filters.stage);
  return stages.length > 0 && stages.every((slug) => WON_STAGE_SLUG_SET.has(slug));
}

type TenantDb = NodePgDatabase<typeof schema>;

export type ReportDimension =
  | "stage"
  | "rep"
  | "region"
  | "source"
  | "deal_type"
  | "month"
  | "week"
  | "age_in_stage_bucket";

export type ReportMeasure =
  | "deal_count"
  | "total_value"
  | "avg_value"
  | "win_rate"
  | "avg_cycle_time"
  | "avg_age_in_stage";

export type ReportDateField =
  | "created_at"
  | "updated_at"
  | "expected_close_date"
  | "actual_close_date"
  | "contract_signed_at"
  | "contract_signed_date";

export interface ReportBuilderInput {
  dimensions: string[];
  measures: string[];
  filters?: Record<string, unknown>;
  dateField: string;
  role: UserRole;
  userId: string;
}

export interface ReportBuilderColumn {
  key: string;
  label: string;
  kind: "dimension" | "measure";
}

export interface ReportBuilderResult {
  columns: ReportBuilderColumn[];
  rows: Record<string, unknown>[];
  notes?: string[];
}

const DIMENSION_LABELS: Record<ReportDimension, string> = {
  stage: "Stage",
  rep: "Rep",
  region: "Region",
  source: "Source",
  deal_type: "Deal Type",
  month: "Month",
  week: "Week",
  age_in_stage_bucket: "Age in Stage",
};

const MEASURE_LABELS: Record<ReportMeasure, string> = {
  deal_count: "Deal Count",
  total_value: "Total Value",
  avg_value: "Avg Value",
  win_rate: "Win Rate",
  avg_cycle_time: "Avg Cycle Time",
  avg_age_in_stage: "Avg Age in Stage",
};

const DATE_FIELDS: Record<ReportDateField, ReturnType<typeof sql>> = {
  created_at: sql`d.created_at::date`,
  updated_at: sql`d.updated_at::date`,
  expected_close_date: sql`d.expected_close_date`,
  actual_close_date: sql`d.actual_close_date`,
  contract_signed_at: sql`COALESCE(d.contract_signed_at::date, d.contract_signed_date)`,
  contract_signed_date: sql`COALESCE(d.contract_signed_at::date, d.contract_signed_date)`,
};

function dealValueSql() {
  return aliasedEffectiveDealValueSql("d");
}

function dimensionSql(dimension: ReportDimension, dateFieldSql: ReturnType<typeof sql>) {
  switch (dimension) {
    case "stage":
      return sql`COALESCE(psc.name, 'Unstaged')`;
    case "rep":
      return sql`COALESCE(u.display_name, 'Unassigned')`;
    case "region":
      return sql`COALESCE(d.region_classification, d.region_id::text, 'Unassigned')`;
    case "source":
      return sql`COALESCE(NULLIF(d.source, ''), 'Unknown')`;
    case "deal_type":
      return sql`COALESCE(d.pipeline_type_snapshot::text, d.workflow_route::text, 'normal')`;
    case "month":
      return sql`TO_CHAR(DATE_TRUNC('month', ${dateFieldSql}), 'YYYY-MM')`;
    case "week":
      return sql`TO_CHAR(DATE_TRUNC('week', ${dateFieldSql}), 'IYYY-IW')`;
    case "age_in_stage_bucket":
      return sql`
        CASE
          WHEN CURRENT_DATE - d.stage_entered_at::date < 7 THEN '0-6 days'
          WHEN CURRENT_DATE - d.stage_entered_at::date < 14 THEN '7-13 days'
          WHEN CURRENT_DATE - d.stage_entered_at::date < 30 THEN '14-29 days'
          WHEN CURRENT_DATE - d.stage_entered_at::date < 60 THEN '30-59 days'
          ELSE '60+ days'
        END
      `;
  }
}

function measureSql(measure: ReportMeasure) {
  const value = dealValueSql();
  switch (measure) {
    case "deal_count":
      return sql`COUNT(DISTINCT d.id) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")})::int`;
    case "total_value":
      return sql`COALESCE(SUM(${value}), 0)::numeric`;
    case "avg_value":
      return sql`COALESCE(AVG(${value}) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")}), 0)::numeric`;
    case "win_rate":
      return sql`
        COALESCE(
          COUNT(*) FILTER (
            WHERE psc.slug IN (${sql.join(WON_STAGE_SLUGS.map((slug) => sql`${slug}`), sql`, `)})
              AND ${aliasedActiveDealCountFilterSql("d")}
          )::numeric
          / NULLIF(COUNT(*) FILTER (
            WHERE psc.slug IN (${sql.join([...WON_STAGE_SLUGS, ...LOST_STAGE_SLUGS].map((slug) => sql`${slug}`), sql`, `)})
              AND ${aliasedActiveDealCountFilterSql("d")}
          ), 0)
          * 100,
          0
        )::numeric
      `;
    case "avg_cycle_time":
      return sql`COALESCE(AVG(d.actual_close_date - d.created_at::date) FILTER (WHERE d.actual_close_date IS NOT NULL AND ${aliasedActiveDealCountFilterSql("d")}), 0)::numeric`;
    case "avg_age_in_stage":
      return sql`COALESCE(AVG(CURRENT_DATE - d.stage_entered_at::date) FILTER (WHERE ${aliasedActiveDealCountFilterSql("d")}), 0)::numeric`;
  }
}

function assertAllowed<T extends string>(values: string[], allowed: Record<T, unknown>, label: string): T[] {
  const invalid = values.filter((value) => !(value in allowed));
  if (invalid.length > 0) {
    throw new AppError(400, `Invalid ${label}: ${invalid.join(", ")}`);
  }
  return values as T[];
}

export function effectiveReportRepId(input: Pick<ReportBuilderInput, "role" | "userId" | "filters">): string | undefined {
  if (input.role === "rep") return input.userId;
  const repFilter = input.filters?.rep;
  if (Array.isArray(repFilter) && typeof repFilter[0] === "string" && repFilter[0]) return repFilter[0];
  if (typeof repFilter === "string" && repFilter) return repFilter;
  return undefined;
}

function listFilter(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function textArrayFilter(values: string[]) {
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

function buildFilters(input: ReportBuilderInput, dateFieldSql: ReturnType<typeof sql>, wonScoped = false) {
  const filters = input.filters ?? {};
  const clauses: ReturnType<typeof sql>[] = [
    sql`d.is_active = true`,
    sql`COALESCE(d.is_test_data, false) = false`,
    aliasedReportableDealFilterSql("d"),
  ];
  // Won-scoped reports window on won_closed_date; require it usable so the totals reconcile to the
  // canonical Won card (a Won-stage deal with no usable won date is not won-in-period).
  if (wonScoped) clauses.push(aliasedHasUsableWonDateSql("d"));
  const repId = effectiveReportRepId(input);
  if (repId) clauses.push(sql`d.assigned_rep_id = ${repId}`);

  const stages = listFilter(filters.stage);
  if (stages.length > 0) clauses.push(sql`psc.slug = ANY(${textArrayFilter(stages)})`);

  const sources = listFilter(filters.source);
  if (sources.length > 0) clauses.push(sql`d.source = ANY(${textArrayFilter(sources)})`);

  const regions = listFilter(filters.region);
  if (regions.length > 0) clauses.push(sql`COALESCE(d.region_classification, d.region_id::text) = ANY(${textArrayFilter(regions)})`);

  const dealTypes = listFilter(filters.deal_type);
  if (dealTypes.length > 0) clauses.push(sql`COALESCE(d.pipeline_type_snapshot::text, d.workflow_route::text) = ANY(${textArrayFilter(dealTypes)})`);

  if (typeof filters.from === "string" && filters.from) clauses.push(sql`${dateFieldSql} >= ${filters.from}`);
  if (typeof filters.to === "string" && filters.to) clauses.push(sql`${dateFieldSql} <= ${filters.to}`);

  return clauses.length > 0 ? sql`WHERE ${sql.join(clauses, sql` AND `)}` : sql``;
}

function normalizeRow(row: Record<string, unknown>, measures: ReportMeasure[]) {
  const normalized: Record<string, unknown> = { ...row };
  for (const measure of measures) {
    normalized[measure] = Number(row[measure] ?? 0);
  }
  return normalized;
}

export async function runReportBuilder(
  tenantDb: TenantDb,
  input: ReportBuilderInput
): Promise<ReportBuilderResult> {
  const dimensions = assertAllowed<ReportDimension>(input.dimensions, DIMENSION_LABELS, "dimension");
  const measures = assertAllowed<ReportMeasure>(input.measures, MEASURE_LABELS, "measure");
  const dateField = assertAllowed<ReportDateField>([input.dateField], DATE_FIELDS, "dateField")[0];
  if (dimensions.length === 0) throw new AppError(400, "At least one dimension is required");
  if (measures.length === 0) throw new AppError(400, "At least one measure is required");

  const filters = input.filters ?? {};
  const invalidFilters = Object.keys(filters).filter(
    (key) => !["stage", "rep", "region", "source", "deal_type", "from", "to"].includes(key)
  );
  if (invalidFilters.length > 0) {
    throw new AppError(400, `Invalid filter: ${invalidFilters.join(", ")}`);
  }

  // Decision 1: a Won-stage-only cohort forces the period axis onto the canonical won_closed_date,
  // overriding the user's selected date field, so Won count/value are never on a non-Won basis.
  const wonScoped = isWonScopedReport(filters);
  const dateFieldSql = wonScoped ? aliasedWonHsClosedWonDateSql("d") : DATE_FIELDS[dateField];
  const dimensionEntries = dimensions.map((dimension) => ({
    key: dimension,
    expression: dimensionSql(dimension, dateFieldSql),
  }));
  const measureEntries = measures.map((measure) => ({
    key: measure,
    expression: measureSql(measure),
  }));

  const selectList = sql.join(
    [
      ...dimensionEntries.map((entry) => sql`${entry.expression} AS ${sql.identifier(entry.key)}`),
      ...measureEntries.map((entry) => sql`${entry.expression} AS ${sql.identifier(entry.key)}`),
    ],
    sql`, `
  );
  const groupBy = sql.join(dimensionEntries.map((entry) => entry.expression), sql`, `);
  const whereClause = buildFilters(input, dateFieldSql, wonScoped);

  const result = await tenantDb.execute(sql`
    SELECT ${selectList}
    FROM ${deals} d
    LEFT JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    LEFT JOIN ${users} u ON u.id = d.assigned_rep_id
    ${whereClause}
    GROUP BY ${groupBy}
    ORDER BY ${groupBy}
    LIMIT 500
  `);

  const rows = ((result as any).rows ?? result).map((row: Record<string, unknown>) => normalizeRow(row, measures));
  const notes = wonScoped
    ? [
        `Won-scoped report (stage filter is Won-only): the period axis is the canonical won close date (won_closed_date)${
          dateField ? `, not the selected "${dateField}"` : ""
        }, so Won count/value reconcile to the Won card.`,
      ]
    : [];
  return {
    columns: [
      ...dimensions.map((dimension) => ({ key: dimension, label: DIMENSION_LABELS[dimension], kind: "dimension" as const })),
      ...measures.map((measure) => ({ key: measure, label: MEASURE_LABELS[measure], kind: "measure" as const })),
    ],
    rows,
    ...(notes.length > 0 ? { notes } : {}),
  };
}
