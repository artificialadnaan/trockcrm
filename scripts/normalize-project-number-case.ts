import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { applyProjectNumberEmailSkipSetting } from "./lib/project-number-notification.js";

const ALLOWED_TENANTS = ["office_dallas", "office_atlanta"] as const;
const NORMALIZABLE_PREFIX_REGEX = /^(dfw|atl)-/i;
const CANONICAL_PREFIX_REGEX = /^(DFW|ATL)-/;
const DEFAULT_BATCH_SIZE = 100;

export type NormalizeTenant = (typeof ALLOWED_TENANTS)[number];
export type TenantChoice = NormalizeTenant | "all";
export type NormalizedColumn = "deal_number" | "project_number";

export interface NormalizeArgs {
  tenants: NormalizeTenant[];
  dryRun: boolean;
  execute: boolean;
}

export interface CandidateRow {
  dealId: string;
  dealNumber: string | null;
  projectNumber: string | null;
}

export interface NormalizationUpdate {
  tenant: NormalizeTenant;
  dealId: string;
  column: NormalizedColumn;
  oldValue: string;
  newValue: string;
}

export interface TenantNormalizationPlan {
  tenant: NormalizeTenant;
  examined: number;
  updates: NormalizationUpdate[];
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function normalizeProjectNumberPrefix(value: string | null | undefined): string | null {
  if (value == null) return null;
  const text = String(value);
  const separator = text.indexOf("-");
  if (separator < 0) return text;
  const prefix = text.slice(0, separator);
  if (!/^(dfw|atl)$/i.test(prefix)) return text;
  return `${prefix.toUpperCase()}${text.slice(separator)}`;
}

function needsNormalization(value: string | null | undefined): value is string {
  const text = String(value ?? "");
  return NORMALIZABLE_PREFIX_REGEX.test(text) && !CANONICAL_PREFIX_REGEX.test(text);
}

export function parseNormalizeArgs(argv: string[]): NormalizeArgs {
  const args = argv[0] === "normalize-project-number-case" ? argv.slice(1) : argv;
  const tenantArg = args.find((arg) => arg.startsWith("--tenant="));
  if (!tenantArg) {
    throw new Error("--tenant=<office_dallas|office_atlanta|all> is required");
  }

  const tenant = tenantArg.split("=").slice(1).join("=") as TenantChoice;
  const tenants =
    tenant === "all"
      ? [...ALLOWED_TENANTS]
      : ALLOWED_TENANTS.includes(tenant as NormalizeTenant)
        ? [tenant as NormalizeTenant]
        : null;
  if (!tenants) {
    throw new Error("--tenant must be one of office_dallas, office_atlanta, all");
  }

  const hasDryRun = args.includes("--dry-run");
  const hasExecute = args.includes("--execute");
  if (hasDryRun && hasExecute) {
    throw new Error("Choose either --dry-run or --execute, not both");
  }

  return {
    tenants,
    dryRun: !hasExecute,
    execute: hasExecute,
  };
}

export function buildTenantNormalizationPlan(input: {
  tenant: NormalizeTenant;
  rows: CandidateRow[];
}): TenantNormalizationPlan {
  const updates: NormalizationUpdate[] = [];

  for (const row of input.rows) {
    for (const column of ["deal_number", "project_number"] as const) {
      const oldValue = column === "deal_number" ? row.dealNumber : row.projectNumber;
      if (!needsNormalization(oldValue)) continue;
      const newValue = normalizeProjectNumberPrefix(oldValue);
      if (!newValue || newValue === oldValue) continue;
      updates.push({
        tenant: input.tenant,
        dealId: row.dealId,
        column,
        oldValue,
        newValue,
      });
    }
  }

  return {
    tenant: input.tenant,
    examined: input.rows.length,
    updates,
  };
}

function connectionString(): string {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  return selected;
}

async function loadCandidates(client: pg.Client, tenant: NormalizeTenant): Promise<CandidateRow[]> {
  const quotedTenant = quoteIdent(tenant);
  const result = await client.query<{
    id: string;
    deal_number: string | null;
    project_number: string | null;
  }>(`
    SELECT id,
           deal_number,
           project_number
      FROM ${quotedTenant}.deals
     WHERE (deal_number ~* '^(dfw|atl)-' AND deal_number !~ '^(DFW|ATL)-')
        OR (project_number ~* '^(dfw|atl)-' AND project_number !~ '^(DFW|ATL)-')
     ORDER BY id ASC
  `);

  return result.rows.map((row) => ({
    dealId: row.id,
    dealNumber: row.deal_number,
    projectNumber: row.project_number,
  }));
}

function csvCell(value: unknown): string {
  const raw = value == null ? "" : String(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function writeCsvReport(rows: NormalizationUpdate[], timestamp: string): string {
  const auditDir = path.resolve(process.cwd(), "docs/audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const pathname = path.join(auditDir, `project-number-case-normalize-${timestamp}.csv`);
  const header = ["tenant", "deal_id", "column", "old_value", "new_value"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.tenant,
        row.dealId,
        row.column,
        row.oldValue,
        row.newValue,
      ].map(csvCell).join(",")
    );
  }
  fs.writeFileSync(pathname, `${lines.join("\n")}\n`);
  return pathname;
}

function summarizePlans(plans: TenantNormalizationPlan[]): NormalizationUpdate[] {
  for (const plan of plans) {
    console.log(`\n[${plan.tenant}]`);
    console.log(`  Rows examined: ${plan.examined}`);
    console.log(`  Values to normalize: ${plan.updates.length}`);
    console.table(
      plan.updates.slice(0, 10).map((row) => ({
        dealId: row.dealId,
        column: row.column,
        oldValue: row.oldValue,
        newValue: row.newValue,
      }))
    );
  }

  const updates = plans.flatMap((plan) => plan.updates);
  console.log("\n[overall]");
  console.log(`  Rows examined: ${plans.reduce((sum, plan) => sum + plan.examined, 0)}`);
  console.log(`  Values to normalize: ${updates.length}`);
  return updates;
}

async function confirmExecution(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Type 'y' to execute project number case updates: ");
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

export async function executePlan(client: pg.Client, plan: TenantNormalizationPlan): Promise<{
  updated: number;
  failedBatches: number;
}> {
  let updated = 0;
  let failedBatches = 0;
  const quotedTenant = quoteIdent(plan.tenant);

  for (let index = 0; index < plan.updates.length; index += DEFAULT_BATCH_SIZE) {
    const batch = plan.updates.slice(index, index + DEFAULT_BATCH_SIZE);
    let batchUpdated = 0;
    await client.query("BEGIN");
    try {
      await applyProjectNumberEmailSkipSetting(client);
      for (const row of batch) {
        const result = await client.query(
          `UPDATE ${quotedTenant}.deals
              SET ${quoteIdent(row.column)} = $1,
                  updated_at = NOW()
            WHERE id = $2::uuid
              AND ${quoteIdent(row.column)} = $3`,
          [row.newValue, row.dealId, row.oldValue]
        );
        batchUpdated += result.rowCount ?? 0;
      }
      await client.query("COMMIT");
      updated += batchUpdated;
      console.log(`[${plan.tenant}] committed batch ${index / DEFAULT_BATCH_SIZE + 1} (${batch.length} planned updates)`);
    } catch (error) {
      await client.query("ROLLBACK");
      failedBatches += 1;
      console.error(`[${plan.tenant}] aborted batch ${index / DEFAULT_BATCH_SIZE + 1}; prior batches remain committed`);
      console.error(error instanceof Error ? error.message : error);
      break;
    }
  }

  return { updated, failedBatches };
}

export function reportExecutionSummary(input: {
  dryRun: boolean;
  totalUpdated: number;
  totalFailedBatches: number;
  auditPath: string;
}): void {
  if (input.dryRun) {
    console.log("\nDRY RUN ONLY: no database writes performed. Pass --execute to update rows.");
    if (input.totalFailedBatches > 0) {
      console.log(`  Failed batches: ${input.totalFailedBatches}`);
    }
    return;
  }

  if (input.totalFailedBatches > 0) {
    console.error("\nEXECUTION COMPLETED WITH FAILURES");
    console.error(`  Values updated: ${input.totalUpdated}`);
    console.error(`  Failed batches: ${input.totalFailedBatches}`);
    console.error("  Some rows were not normalized. Review CSV audit and re-run.");
    console.error(`  Audit CSV: ${input.auditPath}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nEXECUTION COMPLETE");
  console.log(`  Values updated: ${input.totalUpdated}`);
  console.log(`  Failed batches: ${input.totalFailedBatches}`);
  console.log(`  Audit CSV: ${input.auditPath}`);
}

export async function runNormalizeProjectNumberCase(argv = process.argv.slice(2)): Promise<void> {
  const args = parseNormalizeArgs(argv);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const plans: TenantNormalizationPlan[] = [];
    for (const tenant of args.tenants) {
      plans.push(buildTenantNormalizationPlan({
        tenant,
        rows: await loadCandidates(client, tenant),
      }));
    }

    const updates = summarizePlans(plans);
    const auditPath = writeCsvReport(updates, timestamp);
    console.log(`\nAudit CSV: ${auditPath}`);

    if (args.dryRun) {
      reportExecutionSummary({
        dryRun: true,
        totalUpdated: 0,
        totalFailedBatches: 0,
        auditPath,
      });
      return;
    }

    if (!(await confirmExecution())) {
      console.log("Execution cancelled. No database writes performed.");
      return;
    }

    let totalUpdated = 0;
    let totalFailedBatches = 0;
    for (const plan of plans) {
      const result = await executePlan(client, plan);
      totalUpdated += result.updated;
      totalFailedBatches += result.failedBatches;
    }

    reportExecutionSummary({
      dryRun: false,
      totalUpdated,
      totalFailedBatches,
      auditPath,
    });
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  runNormalizeProjectNumberCase().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
