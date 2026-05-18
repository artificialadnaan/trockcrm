import "dotenv/config";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_DRY_RUN_SAMPLE_SIZE = 10;

export interface Queryable {
  query(
    text: string | { text: string; values?: unknown[] },
    values?: unknown[],
  ): Promise<{ rows: any[] }>;
}

export interface BackfillArgs {
  all: boolean;
  office: string | null;
  dryRun: boolean;
  batchSize: number;
}

export interface BackfillOptions {
  officeName: string;
  dryRun?: boolean;
  batchSize?: number;
  logPath?: string | null;
}

export interface BackfillChangeRow {
  tenant: string;
  dealId: string;
  stageId: string;
  dealNumber: string | null;
  name: string;
  oldValue: string | null;
  newValue: string;
  executedAt: string;
}

export interface BackfillReport {
  officeName: string;
  dryRun: boolean;
  wouldUpdateCount: number;
  updatedCount: number;
  batches: number;
  changes: BackfillChangeRow[];
  logPath: string | null;
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

function textFrom(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapChangeRow(tenant: string, row: Record<string, unknown>): BackfillChangeRow {
  return {
    tenant,
    dealId: String(row.id),
    stageId: String(row.stage_id),
    dealNumber: textFrom(row.deal_number),
    name: String(row.name ?? ""),
    oldValue: textFrom(row.old_value),
    newValue: String(textFrom(row.new_value)),
    executedAt: new Date().toISOString(),
  };
}

function csvEscape(value: string | null): string {
  const text = value ?? "";
  return `"${text.replace(/"/g, '""')}"`;
}

function writeCsvLog(logPath: string, rows: BackfillChangeRow[]) {
  if (rows.length === 0) return;
  const exists = fs.existsSync(logPath);
  const header = "tenant,deal_id,stage_id,deal_number,name,old_value,new_value,executed_at\n";
  const body = rows
    .map((row) =>
      [
        row.tenant,
        row.dealId,
        row.stageId,
        row.dealNumber,
        row.name,
        row.oldValue,
        row.newValue,
        row.executedAt,
      ].map(csvEscape).join(","),
    )
    .join("\n");
  fs.appendFileSync(logPath, `${exists ? "" : header}${body}\n`, "utf8");
}

function defaultLogPath() {
  return `/tmp/stage-entered-at-backfill-${new Date().toISOString().slice(0, 10)}.csv`;
}

export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const args = argv[0]?.endsWith("backfill-stale-stage-entered-at") ? argv.slice(1) : argv;
  const all = args.includes("--all");
  const officeArg = args.find((arg) => arg.startsWith("--office="));
  const office = officeArg ? assertOfficeName(officeArg.split("=").slice(1).join("=")) : null;
  if (all === Boolean(office)) {
    throw new Error("Specify either --all or --office=office_<name>");
  }

  const batchSizeArg = args.find((arg) => arg.startsWith("--batch-size="));
  const batchSize = batchSizeArg
    ? Number(batchSizeArg.split("=").slice(1).join("="))
    : DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > 5000) {
    throw new Error("--batch-size must be an integer between 1 and 5000");
  }

  return {
    all,
    office,
    dryRun: args.includes("--dry-run"),
    batchSize,
  };
}

export async function resolveTenantSchemas(
  db: Queryable,
  options: Pick<BackfillArgs, "all" | "office">,
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

async function loadDryRunCandidates(
  db: Queryable,
  officeName: string,
  sampleSize: number,
): Promise<BackfillChangeRow[]> {
  const schema = quoteIdent(officeName);
  const result = await db.query(
    `WITH stale_deals AS (
       SELECT
         d.id::text,
         d.stage_id::text,
         d.deal_number,
         d.name,
         d.stage_entered_at AS old_value,
         MAX(dsh.created_at) AS new_value
       FROM ${schema}.deals d
       JOIN ${schema}.deal_stage_history dsh
         ON dsh.deal_id = d.id
        AND dsh.to_stage_id = d.stage_id
        AND dsh.created_at IS NOT NULL
      GROUP BY d.id, d.deal_number, d.name, d.stage_entered_at
     HAVING d.stage_entered_at IS NULL OR d.stage_entered_at < MAX(dsh.created_at)
     )
     SELECT *
       FROM stale_deals
      ORDER BY new_value DESC, id ASC
      LIMIT $1`,
    [sampleSize],
  );
  return result.rows.map((row) => mapChangeRow(officeName, row));
}

async function countCandidates(db: Queryable, officeName: string): Promise<number> {
  const schema = quoteIdent(officeName);
  const result = await db.query(
    `WITH stale_deals AS (
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
       FROM stale_deals`,
  );
  return Number(result.rows[0]?.affected_count ?? 0);
}

async function updateBatch(
  db: Queryable,
  officeName: string,
  batchSize: number,
): Promise<BackfillChangeRow[]> {
  const schema = quoteIdent(officeName);
  const result = await db.query(
    `WITH stale_deals AS (
       SELECT
         d.id,
         d.stage_id,
         d.deal_number,
         d.name,
         d.stage_entered_at AS old_value,
         MAX(dsh.created_at) AS new_value
       FROM ${schema}.deals d
       JOIN ${schema}.deal_stage_history dsh
         ON dsh.deal_id = d.id
        AND dsh.to_stage_id = d.stage_id
        AND dsh.created_at IS NOT NULL
      GROUP BY d.id, d.deal_number, d.name, d.stage_entered_at
     HAVING d.stage_entered_at IS NULL OR d.stage_entered_at < MAX(dsh.created_at)
      ORDER BY MAX(dsh.created_at) DESC, d.id
      LIMIT $1
     )
     UPDATE ${schema}.deals AS d
        SET stage_entered_at = stale_deals.new_value
       FROM stale_deals
      WHERE d.id = stale_deals.id
        AND (d.stage_entered_at IS NULL OR d.stage_entered_at < stale_deals.new_value)
     RETURNING
       d.id::text,
       stale_deals.stage_id::text,
       stale_deals.deal_number,
       stale_deals.name,
       stale_deals.old_value,
       stale_deals.new_value`,
    [batchSize],
  );
  return result.rows.map((row) => mapChangeRow(officeName, row));
}

export async function backfillStaleStageEnteredAt(
  db: Queryable,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const officeName = assertOfficeName(options.officeName);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const dryRun = options.dryRun ?? false;
  const logPath = options.logPath === undefined ? defaultLogPath() : options.logPath;

  if (dryRun) {
    const [wouldUpdateCount, changes] = await Promise.all([
      countCandidates(db, officeName),
      loadDryRunCandidates(db, officeName, DEFAULT_DRY_RUN_SAMPLE_SIZE),
    ]);
    return {
      officeName,
      dryRun: true,
      wouldUpdateCount,
      updatedCount: 0,
      batches: 0,
      changes,
      logPath: null,
    };
  }

  const allChanges: BackfillChangeRow[] = [];
  let batches = 0;
  while (true) {
    await db.query("BEGIN");
    try {
      const changes = await updateBatch(db, officeName, batchSize);
      await db.query("COMMIT");
      batches += 1;
      if (changes.length === 0) break;
      allChanges.push(...changes);
      if (logPath) writeCsvLog(logPath, changes);
      if (changes.length < batchSize) break;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }

  return {
    officeName,
    dryRun: false,
    wouldUpdateCount: 0,
    updatedCount: allChanges.length,
    batches,
    changes: allChanges,
    logPath,
  };
}

export function renderBackfillReport(reports: BackfillReport[]): string {
  const dryRun = reports.every((report) => report.dryRun);
  const totalWouldUpdate = reports.reduce((sum, report) => sum + report.wouldUpdateCount, 0);
  const totalUpdated = reports.reduce((sum, report) => sum + report.updatedCount, 0);
  const officeCount = reports.length;
  const lines = [
    dryRun
      ? `Would update ${totalWouldUpdate} deals across ${officeCount} offices.`
      : `Updated ${totalUpdated} deals across ${officeCount} offices.`,
    "",
    "Per-office results:",
    ...reports.map((report) =>
      report.dryRun
        ? `- ${report.officeName}: would update ${report.wouldUpdateCount}`
        : `- ${report.officeName}: updated ${report.updatedCount} in ${report.batches} batch(es)${report.logPath ? `, log ${report.logPath}` : ""}`,
    ),
    "",
    dryRun ? "Top dry-run changes:" : "Changed rows:",
  ];

  const rows = reports.flatMap((report) => report.changes).slice(0, dryRun ? 10 : 50);
  if (rows.length === 0) {
    lines.push("- none");
  } else {
    for (const row of rows) {
      lines.push(
        `- ${row.tenant} | ${row.dealNumber ?? "no-number"} | ${row.name} | ${row.oldValue ?? "null"} -> ${row.newValue}`,
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
  const args = parseBackfillArgs(process.argv.slice(2));
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const tenants = await resolveTenantSchemas(client, args);
    const reports: BackfillReport[] = [];
    for (const officeName of tenants) {
      reports.push(
        await backfillStaleStageEnteredAt(client, {
          officeName,
          dryRun: args.dryRun,
          batchSize: args.batchSize,
        }),
      );
    }
    console.log(renderBackfillReport(reports));
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
