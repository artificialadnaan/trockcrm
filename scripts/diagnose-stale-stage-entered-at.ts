import "dotenv/config";
import { pathToFileURL } from "node:url";
import pg from "pg";

const DEFAULT_SAMPLE_SIZE = 50;
const AVELA_DEAL_NUMBER = "DFW-5-02826-AC";
const AVELA_DEAL_NAME = "Avela Real Estate Partners";

export interface Queryable {
  query(
    text: string | { text: string; values?: unknown[] },
    values?: unknown[],
  ): Promise<{ rows: any[] }>;
}

export interface DiagnosticArgs {
  all: boolean;
  office: string | null;
  sampleSize: number;
}

export interface DiagnosticOptions {
  officeName: string;
  sampleSize?: number;
}

export interface DiagnosticDealRow {
  id: string;
  name: string;
  deal_number: string | null;
  stage_id: string;
  stored_stage_entered_at: string | null;
  latest_history_entry: string;
  days_diff: number | null;
  stored_days_in_stage: number | null;
  actual_days_in_stage: number | null;
}

export interface AvelaDiagnosticRow extends DiagnosticDealRow {
  affected: boolean;
}

export interface DiagnosticReport {
  officeName: string;
  affectedCount: number;
  sampleRows: DiagnosticDealRow[];
  avelaDeal: AvelaDiagnosticRow | null;
}

function assertOfficeName(value: string): string {
  if (!/^office_[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error("--office must match office_<name>");
  }
  return value;
}

function quoteIdent(value: string): string {
  return pg.escapeIdentifier(value);
}

function numberFrom(value: unknown): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function textFrom(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapDiagnosticDealRow(row: Record<string, unknown>): DiagnosticDealRow {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    deal_number: textFrom(row.deal_number),
    stage_id: String(row.stage_id),
    stored_stage_entered_at: textFrom(row.stored_stage_entered_at),
    latest_history_entry: String(textFrom(row.latest_history_entry)),
    days_diff: numberFrom(row.days_diff),
    stored_days_in_stage: numberFrom(row.stored_days_in_stage),
    actual_days_in_stage: numberFrom(row.actual_days_in_stage),
  };
}

export function parseDiagnoseArgs(argv: string[]): DiagnosticArgs {
  const args = argv[0]?.endsWith("diagnose-stale-stage-entered-at") ? argv.slice(1) : argv;
  const all = args.includes("--all");
  const officeArg = args.find((arg) => arg.startsWith("--office="));
  const office = officeArg ? assertOfficeName(officeArg.split("=").slice(1).join("=")) : null;
  if (all === Boolean(office)) {
    throw new Error("Specify either --all or --office=office_<name>");
  }

  const sampleSizeArg = args.find((arg) => arg.startsWith("--sample-size="));
  const sampleSize = sampleSizeArg
    ? Number(sampleSizeArg.split("=").slice(1).join("="))
    : DEFAULT_SAMPLE_SIZE;
  if (!Number.isInteger(sampleSize) || sampleSize <= 0 || sampleSize > 500) {
    throw new Error("--sample-size must be an integer between 1 and 500");
  }

  return { all, office, sampleSize };
}

export async function resolveTenantSchemas(
  db: Queryable,
  options: Pick<DiagnosticArgs, "all" | "office">,
): Promise<string[]> {
  if (!options.all) return [assertOfficeName(options.office ?? "")];

  const result = await db.query(
    `SELECT schema_name
       FROM information_schema.schemata
      WHERE schema_name LIKE 'office\\_%' ESCAPE '\\'
      ORDER BY schema_name`,
  );
  return result.rows
    .map((row) => String(row.schema_name))
    .filter((schemaName) => /^office_[a-z][a-z0-9_]*$/.test(schemaName));
}

export async function diagnoseStaleStageEnteredAt(
  db: Queryable,
  options: DiagnosticOptions,
): Promise<DiagnosticReport> {
  const officeName = assertOfficeName(options.officeName);
  const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const schema = quoteIdent(officeName);

  const countResult = await db.query(
    `WITH latest_current_stage_history AS (
       SELECT d.id
         FROM ${schema}.deals d
         JOIN ${schema}.deal_stage_history dsh
           ON dsh.deal_id = d.id
          AND dsh.to_stage_id = d.stage_id
          AND dsh.created_at IS NOT NULL
        GROUP BY d.id, d.stage_entered_at
       HAVING d.stage_entered_at IS NULL OR d.stage_entered_at < MAX(dsh.created_at)
     )
     SELECT COUNT(*)::int AS affected_count
       FROM latest_current_stage_history`,
  );

  const sampleResult = await db.query(
    `WITH stale_deals AS (
       SELECT
         d.id::text,
         d.name,
         d.deal_number,
         d.stage_id::text,
         d.stage_entered_at AS stored_stage_entered_at,
         MAX(dsh.created_at) AS latest_history_entry,
         FLOOR(EXTRACT(EPOCH FROM (MAX(dsh.created_at) - d.stage_entered_at)) / 86400)::int AS days_diff,
         FLOOR(EXTRACT(EPOCH FROM (NOW() - d.stage_entered_at)) / 86400)::int AS stored_days_in_stage,
         FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(dsh.created_at))) / 86400)::int AS actual_days_in_stage
       FROM ${schema}.deals d
       JOIN ${schema}.deal_stage_history dsh
         ON dsh.deal_id = d.id
        AND dsh.to_stage_id = d.stage_id
        AND dsh.created_at IS NOT NULL
      GROUP BY d.id, d.name, d.deal_number, d.stage_id, d.stage_entered_at
     HAVING d.stage_entered_at IS NULL OR d.stage_entered_at < MAX(dsh.created_at)
     )
     SELECT *
       FROM stale_deals
      ORDER BY days_diff DESC NULLS FIRST, stored_days_in_stage DESC NULLS FIRST, deal_number ASC
      LIMIT $1`,
    [sampleSize],
  );

  const avelaResult = await db.query(
    `WITH current_stage_history AS (
       SELECT
         d.id::text,
         d.name,
         d.deal_number,
         d.stage_id::text,
         d.stage_entered_at AS stored_stage_entered_at,
         MAX(dsh.created_at) AS latest_history_entry,
         FLOOR(EXTRACT(EPOCH FROM (MAX(dsh.created_at) - d.stage_entered_at)) / 86400)::int AS days_diff,
         FLOOR(EXTRACT(EPOCH FROM (NOW() - d.stage_entered_at)) / 86400)::int AS stored_days_in_stage,
         FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(dsh.created_at))) / 86400)::int AS actual_days_in_stage,
         (d.stage_entered_at IS NULL OR d.stage_entered_at < MAX(dsh.created_at)) AS affected
       FROM ${schema}.deals d
       JOIN ${schema}.deal_stage_history dsh
         ON dsh.deal_id = d.id
        AND dsh.to_stage_id = d.stage_id
        AND dsh.created_at IS NOT NULL
      WHERE (d.deal_number = $1 OR LOWER(d.name) = LOWER($2))
      GROUP BY d.id, d.name, d.deal_number, d.stage_id, d.stage_entered_at
     )
     SELECT *
       FROM current_stage_history
      ORDER BY affected DESC, latest_history_entry DESC NULLS LAST
      LIMIT 1`,
    [AVELA_DEAL_NUMBER, AVELA_DEAL_NAME],
  );

  const avelaDeal = avelaResult.rows[0]
    ? {
        ...mapDiagnosticDealRow(avelaResult.rows[0]),
        affected: Boolean(avelaResult.rows[0].affected ?? true),
      }
    : null;

  return {
    officeName,
    affectedCount: Number(countResult.rows[0]?.affected_count ?? 0),
    sampleRows: sampleResult.rows.map((row) => mapDiagnosticDealRow(row)),
    avelaDeal,
  };
}

export function renderDiagnosticReport(reports: DiagnosticReport[]): string {
  const total = reports.reduce((sum, report) => sum + report.affectedCount, 0);
  const lines = [
    `Stale stage_entered_at diagnostic`,
    `Total affected deals: ${total}`,
    "",
    "Per-office counts:",
    ...reports.map((report) => `- ${report.officeName}: ${report.affectedCount}`),
  ];

  for (const report of reports) {
    lines.push("", `Top stale deals for ${report.officeName}:`);
    if (report.sampleRows.length === 0) {
      lines.push("- none");
    } else {
      for (const row of report.sampleRows) {
        lines.push(
          `- ${row.deal_number ?? "no-number"} | ${row.name} | stored=${row.stored_days_in_stage ?? "null"}d actual=${row.actual_days_in_stage ?? "null"}d diff=${row.days_diff ?? "null"}d | ${row.stored_stage_entered_at ?? "null"} -> ${row.latest_history_entry}`,
        );
      }
    }

    lines.push(`Avela lookup for ${report.officeName}:`);
    if (!report.avelaDeal) {
      lines.push("- not found with matching current-stage history");
    } else {
      const row = report.avelaDeal;
      lines.push(
        `- ${row.affected ? "affected" : "not affected"} | ${row.deal_number ?? "no-number"} | ${row.name} | stored=${row.stored_days_in_stage ?? "null"}d actual=${row.actual_days_in_stage ?? "null"}d diff=${row.days_diff ?? "null"}d | ${row.stored_stage_entered_at ?? "null"} -> ${row.latest_history_entry}`,
      );
    }
  }

  return lines.join("\n");
}

function connectionString() {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  return selected;
}

async function main() {
  const args = parseDiagnoseArgs(process.argv.slice(2));
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const tenants = await resolveTenantSchemas(client, args);
    const reports: DiagnosticReport[] = [];
    for (const officeName of tenants) {
      reports.push(await diagnoseStaleStageEnteredAt(client, { officeName, sampleSize: args.sampleSize }));
    }
    console.log(renderDiagnosticReport(reports));
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
