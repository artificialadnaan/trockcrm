import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

const ALLOWED_TENANTS = ["office_dallas", "office_atlanta"] as const;
const DEFAULT_BATCH_SIZE = 100;

export type ActiveBackfillTenant = (typeof ALLOWED_TENANTS)[number];
export type TenantChoice = ActiveBackfillTenant | "all";

export interface ActiveBackfillArgs {
  tenants: ActiveBackfillTenant[];
  dryRun: boolean;
  execute: boolean;
}

export interface CandidateRow {
  id: string;
  procoreProjectId: string;
  procoreProjectNumber: string | null;
  name: string;
  currentIsActive: boolean;
  rawSnapshot: Record<string, unknown> | null;
}

export interface ActiveUpdate {
  tenant: ActiveBackfillTenant;
  projectId: string;
  procoreProjectId: string;
  procoreProjectNumber: string | null;
  name: string;
  oldIsActive: boolean;
  newIsActive: boolean;
  reason: string;
}

export interface TenantActivePlan {
  tenant: ActiveBackfillTenant;
  examined: number;
  alreadyCorrect: number;
  updates: ActiveUpdate[];
  skippedNoSnapshot: number;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

// Re-implementation of the inference rule used by buildProjectMirrorFields.
// Kept in lockstep so this script and the live mirror agree on what counts
// as "inactive in Procore". If buildProjectMirrorFields changes, update this.
export function deriveIsActiveFromSnapshot(
  snapshot: Record<string, unknown> | null | undefined
): { isActive: boolean; reason: string } | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  if (typeof snapshot.active === "boolean") {
    return { isActive: snapshot.active, reason: `snapshot.active=${snapshot.active}` };
  }
  if (typeof snapshot.status_name === "string") {
    const statusName = snapshot.status_name;
    return {
      isActive: statusName !== "Inactive",
      reason: `status_name=${JSON.stringify(statusName)}`,
    };
  }
  return null;
}

export function parseActiveBackfillArgs(argv: string[]): ActiveBackfillArgs {
  const args = argv[0] === "backfill-projects-active-flag" ? argv.slice(1) : argv;
  const tenantArg = args.find((arg) => arg.startsWith("--tenant="));
  if (!tenantArg) {
    throw new Error("--tenant=<office_dallas|office_atlanta|all> is required");
  }

  const tenant = tenantArg.split("=").slice(1).join("=") as TenantChoice;
  const tenants =
    tenant === "all"
      ? [...ALLOWED_TENANTS]
      : ALLOWED_TENANTS.includes(tenant as ActiveBackfillTenant)
        ? [tenant as ActiveBackfillTenant]
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

export function buildTenantActivePlan(input: {
  tenant: ActiveBackfillTenant;
  rows: CandidateRow[];
}): TenantActivePlan {
  const updates: ActiveUpdate[] = [];
  let alreadyCorrect = 0;
  let skippedNoSnapshot = 0;

  for (const row of input.rows) {
    const derived = deriveIsActiveFromSnapshot(row.rawSnapshot);
    if (!derived) {
      skippedNoSnapshot += 1;
      continue;
    }
    if (derived.isActive === row.currentIsActive) {
      alreadyCorrect += 1;
      continue;
    }
    updates.push({
      tenant: input.tenant,
      projectId: row.id,
      procoreProjectId: row.procoreProjectId,
      procoreProjectNumber: row.procoreProjectNumber,
      name: row.name,
      oldIsActive: row.currentIsActive,
      newIsActive: derived.isActive,
      reason: derived.reason,
    });
  }

  return {
    tenant: input.tenant,
    examined: input.rows.length,
    alreadyCorrect,
    updates,
    skippedNoSnapshot,
  };
}

function connectionString(): string {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  return selected;
}

async function loadCandidates(client: pg.Client, tenant: ActiveBackfillTenant): Promise<CandidateRow[]> {
  const quotedTenant = quoteIdent(tenant);
  const result = await client.query<{
    id: string;
    procore_project_id: string;
    procore_project_number: string | null;
    name: string;
    is_active: boolean;
    procore_raw_snapshot: Record<string, unknown> | null;
  }>(`
    SELECT id,
           procore_project_id,
           procore_project_number,
           name,
           is_active,
           procore_raw_snapshot
      FROM ${quotedTenant}.projects
     ORDER BY procore_project_id ASC
  `);

  return result.rows.map((row) => ({
    id: row.id,
    procoreProjectId: row.procore_project_id,
    procoreProjectNumber: row.procore_project_number,
    name: row.name,
    currentIsActive: row.is_active,
    rawSnapshot: row.procore_raw_snapshot,
  }));
}

function csvCell(value: unknown): string {
  const raw = value == null ? "" : String(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function writeCsvReport(rows: ActiveUpdate[], timestamp: string): string {
  const auditDir = path.resolve(process.cwd(), "docs/audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const pathname = path.join(auditDir, `projects-inactive-backfill-${timestamp}.csv`);
  const header = [
    "tenant",
    "project_id",
    "procore_project_id",
    "procore_project_number",
    "name",
    "old_is_active",
    "new_is_active",
    "reason",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.tenant,
        row.projectId,
        row.procoreProjectId,
        row.procoreProjectNumber ?? "",
        row.name,
        row.oldIsActive,
        row.newIsActive,
        row.reason,
      ].map(csvCell).join(",")
    );
  }
  fs.writeFileSync(pathname, `${lines.join("\n")}\n`);
  return pathname;
}

function summarizePlans(plans: TenantActivePlan[]): ActiveUpdate[] {
  for (const plan of plans) {
    console.log(`\n[${plan.tenant}]`);
    console.log(`  Rows examined: ${plan.examined}`);
    console.log(`  Already correct: ${plan.alreadyCorrect}`);
    console.log(`  Will mark inactive: ${plan.updates.filter((u) => !u.newIsActive).length}`);
    console.log(`  Will mark active: ${plan.updates.filter((u) => u.newIsActive).length}`);
    console.log(`  Skipped (no snapshot active flag): ${plan.skippedNoSnapshot}`);
    console.table(
      plan.updates.slice(0, 10).map((row) => ({
        projectNumber: row.procoreProjectNumber ?? "",
        oldActive: row.oldIsActive,
        newActive: row.newIsActive,
        reason: row.reason,
      }))
    );
  }

  const updates = plans.flatMap((plan) => plan.updates);
  console.log("\n[overall]");
  console.log(`  Rows examined: ${plans.reduce((sum, plan) => sum + plan.examined, 0)}`);
  console.log(`  Will update: ${updates.length}`);
  console.log(`  Will mark inactive: ${updates.filter((u) => !u.newIsActive).length}`);
  console.log(`  Will mark active: ${updates.filter((u) => u.newIsActive).length}`);
  return updates;
}

async function confirmExecution(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Type 'y' to execute is_active updates: ");
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

export async function executePlan(client: pg.Client, plan: TenantActivePlan): Promise<{
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
      for (const row of batch) {
        const result = await client.query(
          `UPDATE ${quotedTenant}.projects
              SET is_active = $1,
                  updated_at = NOW()
            WHERE id = $2::uuid
              AND is_active = $3`,
          [row.newIsActive, row.projectId, row.oldIsActive]
        );
        batchUpdated += result.rowCount ?? 0;
      }
      await client.query("COMMIT");
      updated += batchUpdated;
      console.log(
        `[${plan.tenant}] committed batch ${index / DEFAULT_BATCH_SIZE + 1} (${batch.length} planned, ${batchUpdated} applied)`
      );
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
    console.error(`  Rows updated: ${input.totalUpdated}`);
    console.error(`  Failed batches: ${input.totalFailedBatches}`);
    console.error(`  Audit CSV: ${input.auditPath}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nEXECUTION COMPLETE");
  console.log(`  Rows updated: ${input.totalUpdated}`);
  console.log(`  Audit CSV: ${input.auditPath}`);
}

export async function runBackfillProjectsActiveFlag(argv = process.argv.slice(2)): Promise<void> {
  const args = parseActiveBackfillArgs(argv);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const plans: TenantActivePlan[] = [];
    for (const tenant of args.tenants) {
      plans.push(buildTenantActivePlan({
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
  runBackfillProjectsActiveFlag().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
