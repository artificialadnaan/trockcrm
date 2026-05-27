import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { applyProjectNumberEmailSkipSetting } from "./lib/project-number-notification.js";

export const CANONICAL_PROJECT_NUMBER_REGEX = /^(DFW|ATL)-[0-9]+-[0-9]{5}-[a-z]{2}$/;
const ALLOWED_TENANTS = ["office_dallas", "office_atlanta"] as const;
const DEFAULT_BATCH_SIZE = 100;

export type BackfillTenant = (typeof ALLOWED_TENANTS)[number];
export type TenantChoice = BackfillTenant | "all";
export type BackfillAction = "UPDATE" | "SKIP" | "COLLISION";

export interface BackfillArgs {
  tenants: BackfillTenant[];
  dryRun: boolean;
  execute: boolean;
  limit: number | null;
}

export interface CandidateRow {
  id: string;
  hubspotDealId: string | null;
  preservedProjectNumber: string | null;
}

export interface ExistingProjectNumberRow {
  dealId: string;
  hubspotDealId: string | null;
  projectNumber: string;
}

export interface AuditRow {
  tenant: BackfillTenant;
  dealId: string;
  hubspotDealId: string | null;
  action: BackfillAction;
  reason: string;
  oldValue: string | null;
  newValue: string | null;
  collisionDealId?: string | null;
  collisionHubspotDealId?: string | null;
}

export interface TenantBackfillPlan {
  tenant: BackfillTenant;
  examined: number;
  updates: AuditRow[];
  skips: AuditRow[];
  collisions: AuditRow[];
  rows: AuditRow[];
  reasonBreakdown: Record<string, number>;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function isCanonicalProjectNumber(value: string | null | undefined): boolean {
  return CANONICAL_PROJECT_NUMBER_REGEX.test(String(value ?? "").trim());
}

function cleanPreservedValue(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const args = argv[0] === "backfill-project-numbers" ? argv.slice(1) : argv;
  const tenantArg = args.find((arg) => arg.startsWith("--tenant="));
  if (!tenantArg) {
    throw new Error("--tenant=<office_dallas|office_atlanta|all> is required");
  }

  const tenant = tenantArg.split("=").slice(1).join("=") as TenantChoice;
  const tenants =
    tenant === "all"
      ? [...ALLOWED_TENANTS]
      : ALLOWED_TENANTS.includes(tenant as BackfillTenant)
        ? [tenant as BackfillTenant]
        : null;
  if (!tenants) {
    throw new Error("--tenant must be one of office_dallas, office_atlanta, all");
  }

  const hasDryRun = args.includes("--dry-run");
  const hasExecute = args.includes("--execute");
  if (hasDryRun && hasExecute) {
    throw new Error("Choose either --dry-run or --execute, not both");
  }

  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=").slice(1).join("=")) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }

  return {
    tenants,
    dryRun: !hasExecute,
    execute: hasExecute,
    limit,
  };
}

function addReason(breakdown: Record<string, number>, reason: string): void {
  breakdown[reason] = (breakdown[reason] ?? 0) + 1;
}

export function buildTenantBackfillPlan(input: {
  tenant: BackfillTenant;
  candidates: CandidateRow[];
  existingProjectNumbers: ExistingProjectNumberRow[];
}): TenantBackfillPlan {
  const existingByProjectNumber = new Map(
    input.existingProjectNumbers.map((row) => [row.projectNumber, row])
  );
  const plannedByProjectNumber = new Map<string, AuditRow>();
  const updates: AuditRow[] = [];
  const skips: AuditRow[] = [];
  const collisions: AuditRow[] = [];
  const reasonBreakdown: Record<string, number> = {};

  for (const candidate of input.candidates) {
    const preserved = cleanPreservedValue(candidate.preservedProjectNumber);
    const base = {
      tenant: input.tenant,
      dealId: candidate.id,
      hubspotDealId: candidate.hubspotDealId,
      oldValue: null,
      newValue: preserved,
    };

    if (!preserved) {
      const row: AuditRow = {
        ...base,
        action: "SKIP",
        reason: "no preserved value",
      };
      skips.push(row);
      addReason(reasonBreakdown, row.reason);
      continue;
    }

    if (!isCanonicalProjectNumber(preserved)) {
      const row: AuditRow = {
        ...base,
        action: "SKIP",
        reason: "legacy format",
      };
      skips.push(row);
      addReason(reasonBreakdown, row.reason);
      continue;
    }

    const existing = existingByProjectNumber.get(preserved);
    if (existing) {
      const row: AuditRow = {
        ...base,
        action: "COLLISION",
        reason: "existing project_number collision",
        collisionDealId: existing.dealId,
        collisionHubspotDealId: existing.hubspotDealId,
      };
      collisions.push(row);
      addReason(reasonBreakdown, row.reason);
      continue;
    }

    const duplicate = plannedByProjectNumber.get(preserved);
    if (duplicate) {
      const row: AuditRow = {
        ...base,
        action: "COLLISION",
        reason: "duplicate candidate project_number",
        collisionDealId: duplicate.dealId,
        collisionHubspotDealId: duplicate.hubspotDealId,
      };
      collisions.push(row);
      addReason(reasonBreakdown, row.reason);
      continue;
    }

    const row: AuditRow = {
      ...base,
      action: "UPDATE",
      reason: "canonical preserved project_number",
    };
    updates.push(row);
    plannedByProjectNumber.set(preserved, row);
  }

  return {
    tenant: input.tenant,
    examined: input.candidates.length,
    updates,
    skips,
    collisions,
    rows: [...updates, ...skips, ...collisions],
    reasonBreakdown,
  };
}

function connectionString(): string {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  return selected;
}

async function loadCandidates(
  client: pg.Client,
  tenant: BackfillTenant,
  limit: number | null
): Promise<CandidateRow[]> {
  const quotedTenant = quoteIdent(tenant);
  const limitSql = limit ? `LIMIT ${limit}` : "";
  const result = await client.query<{
    id: string;
    hubspot_deal_id: string | null;
    preserved_project_number: string | null;
  }>(`
    SELECT id,
           hubspot_deal_id,
           hubspot_extra_properties->>'project_number' AS preserved_project_number
      FROM ${quotedTenant}.deals
     WHERE project_number IS NULL
     ORDER BY id ASC
     ${limitSql}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    hubspotDealId: row.hubspot_deal_id,
    preservedProjectNumber: row.preserved_project_number,
  }));
}

async function loadExistingProjectNumbers(
  client: pg.Client,
  tenant: BackfillTenant
): Promise<ExistingProjectNumberRow[]> {
  const quotedTenant = quoteIdent(tenant);
  const result = await client.query<{
    id: string;
    hubspot_deal_id: string | null;
    project_number: string;
  }>(`
    SELECT id,
           hubspot_deal_id,
           project_number
      FROM ${quotedTenant}.deals
     WHERE project_number IS NOT NULL
  `);

  return result.rows.map((row) => ({
    dealId: row.id,
    hubspotDealId: row.hubspot_deal_id,
    projectNumber: row.project_number,
  }));
}

function csvCell(value: unknown): string {
  const raw = value == null ? "" : String(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function writeCsvReport(rows: AuditRow[], timestamp: string): string {
  const auditDir = path.resolve(process.cwd(), "docs/audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const pathname = path.join(auditDir, `project-number-backfill-${timestamp}.csv`);
  const header = [
    "tenant",
    "deal_id",
    "hubspot_deal_id",
    "action",
    "reason",
    "old_value",
    "new_value",
    "collision_deal_id",
    "collision_hubspot_deal_id",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.tenant,
        row.dealId,
        row.hubspotDealId,
        row.action,
        row.reason,
        row.oldValue,
        row.newValue,
        row.collisionDealId ?? null,
        row.collisionHubspotDealId ?? null,
      ].map(csvCell).join(",")
    );
  }
  fs.writeFileSync(pathname, `${lines.join("\n")}\n`);
  return pathname;
}

function summarizePlans(plans: TenantBackfillPlan[]): AuditRow[] {
  const allRows = plans.flatMap((plan) => plan.rows);
  for (const plan of plans) {
    console.log(`\n[${plan.tenant}]`);
    console.log(`  Total candidates examined: ${plan.examined}`);
    console.log(`  Candidates eligible for backfill: ${plan.updates.length}`);
    console.log(`  Candidates skipped: ${plan.skips.length}`);
    console.log(`  Candidates with collisions: ${plan.collisions.length}`);
    console.log("  Skip/collision reason breakdown:");
    console.table(plan.reasonBreakdown);
    console.log("  Eligible sample:");
    console.table(
      plan.updates.slice(0, 10).map((row) => ({
        dealId: row.dealId,
        hubspotDealId: row.hubspotDealId,
        projectNumber: row.newValue,
      }))
    );
    if (plan.collisions.length > 0) {
      console.log("  Collisions:");
      console.table(
        plan.collisions.map((row) => ({
          dealId: row.dealId,
          hubspotDealId: row.hubspotDealId,
          projectNumber: row.newValue,
          existingDealId: row.collisionDealId,
          existingHubspotDealId: row.collisionHubspotDealId,
          reason: row.reason,
        }))
      );
    }
  }

  console.log("\n[overall]");
  console.log(`  Total candidates examined: ${plans.reduce((sum, plan) => sum + plan.examined, 0)}`);
  console.log(`  Candidates eligible for backfill: ${plans.reduce((sum, plan) => sum + plan.updates.length, 0)}`);
  console.log(`  Candidates skipped: ${plans.reduce((sum, plan) => sum + plan.skips.length, 0)}`);
  console.log(`  Candidates with collisions: ${plans.reduce((sum, plan) => sum + plan.collisions.length, 0)}`);
  return allRows;
}

async function confirmExecution(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Type 'y' to execute project_number updates: ");
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

export async function executePlan(client: pg.Client, plan: TenantBackfillPlan): Promise<{
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
              SET project_number = $1,
                  updated_at = NOW()
            WHERE id = $2::uuid
              AND project_number IS NULL`,
          [row.newValue, row.dealId]
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

export async function runBackfill(argv = process.argv.slice(2)): Promise<void> {
  const args = parseBackfillArgs(argv);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const plans: TenantBackfillPlan[] = [];
    for (const tenant of args.tenants) {
      const [candidates, existingProjectNumbers] = await Promise.all([
        loadCandidates(client, tenant, args.limit),
        loadExistingProjectNumbers(client, tenant),
      ]);
      plans.push(buildTenantBackfillPlan({ tenant, candidates, existingProjectNumbers }));
    }

    const auditRows = summarizePlans(plans);
    const auditPath = writeCsvReport(auditRows, timestamp);
    console.log(`\nAudit CSV: ${auditPath}`);

    if (args.dryRun) {
      console.log("\nDRY RUN ONLY: no database writes performed. Pass --execute to update rows.");
      return;
    }

    if (plans.some((plan) => plan.collisions.length > 0)) {
      throw new Error("Refusing to execute while collisions are present");
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

    console.log("\nEXECUTION COMPLETE");
    console.log(`  Rows updated: ${totalUpdated}`);
    console.log(`  Failed batches: ${totalFailedBatches}`);
    console.log(`  Audit CSV: ${auditPath}`);
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  runBackfill().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
