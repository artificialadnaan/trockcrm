import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

const ALLOWED_TENANTS = ["office_dallas", "office_atlanta"] as const;
const DEFAULT_BATCH_SIZE = 100;

export type BackfillTenant = (typeof ALLOWED_TENANTS)[number];
export type TenantChoice = BackfillTenant | "all";
export type BackfillAction = "UPDATE" | "SKIP";
export type SourceField = "numeric" | "text" | "none";

export interface BackfillArgs {
  tenants: BackfillTenant[];
  dryRun: boolean;
  execute: boolean;
  includeLegacy: boolean;
  limit: number | null;
}

export interface ProjectTypeConfigRow {
  id: string;
  code: string | null;
  name: string;
  slug: string;
  isActive: boolean;
}

export interface CandidateRow {
  id: string;
  hubspotDealId: string | null;
  hubspotExtraProperties: Record<string, unknown> | null;
}

export interface ProjectTypeDecision {
  action: BackfillAction;
  sourceField: SourceField;
  sourceValue: string | null;
  numericValue: string | null;
  textValue: string | null;
  conflict: boolean;
  resolvedTypeId: string | null;
  resolvedTypeCode: string | null;
  resolvedTypeLabel: string | null;
  reason: string;
}

export interface AuditRow extends ProjectTypeDecision {
  tenant: BackfillTenant;
  dealId: string;
  hubspotDealId: string | null;
}

export interface TenantBackfillPlan {
  tenant: BackfillTenant;
  examined: number;
  updates: AuditRow[];
  skips: AuditRow[];
  conflicts: AuditRow[];
  rows: AuditRow[];
  updateBreakdown: Record<"numeric" | "text", number>;
  skipBreakdown: Record<string, number>;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function cleanValue(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function lookupByActiveCode(projectTypes: ProjectTypeConfigRow[], code: string | null) {
  if (!code) return null;
  return projectTypes.find((projectType) => projectType.isActive && projectType.code === code) ?? null;
}

function lookupByLabel(
  projectTypes: ProjectTypeConfigRow[],
  label: string | null,
  active: boolean
) {
  if (!label) return null;
  const normalized = normalizeLabel(label);
  return (
    projectTypes.find(
      (projectType) => projectType.isActive === active && normalizeLabel(projectType.name) === normalized
    ) ?? null
  );
}

export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const args = argv[0] === "backfill-project-types" ? argv.slice(1) : argv;
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
    includeLegacy: args.includes("--include-legacy"),
    limit,
  };
}

export function resolveProjectTypeDecision(input: {
  projectTypes: ProjectTypeConfigRow[];
  includeLegacy: boolean;
  hubspotExtraProperties: Record<string, unknown> | null;
}): ProjectTypeDecision {
  const numericCode = cleanValue(input.hubspotExtraProperties?.project_types);
  const textLabel = cleanValue(input.hubspotExtraProperties?.project_type);
  const numericMatch = lookupByActiveCode(input.projectTypes, numericCode);
  const activeTextMatch = lookupByLabel(input.projectTypes, textLabel, true);
  const inactiveTextMatch = lookupByLabel(input.projectTypes, textLabel, false);
  const textMatch = activeTextMatch ?? inactiveTextMatch;
  const conflict = Boolean(numericMatch && activeTextMatch && numericMatch.id !== activeTextMatch.id);

  if (numericMatch) {
    return {
      action: "UPDATE",
      sourceField: "numeric",
      sourceValue: numericCode,
      numericValue: numericCode,
      textValue: textLabel,
      conflict,
      resolvedTypeId: numericMatch.id,
      resolvedTypeCode: numericMatch.code,
      resolvedTypeLabel: numericMatch.name,
      reason: "numeric active code match",
    };
  }

  if (activeTextMatch) {
    return {
      action: "UPDATE",
      sourceField: "text",
      sourceValue: textLabel,
      numericValue: numericCode,
      textValue: textLabel,
      conflict: false,
      resolvedTypeId: activeTextMatch.id,
      resolvedTypeCode: activeTextMatch.code,
      resolvedTypeLabel: activeTextMatch.name,
      reason: "text active label match",
    };
  }

  if (inactiveTextMatch && input.includeLegacy) {
    return {
      action: "UPDATE",
      sourceField: "text",
      sourceValue: textLabel,
      numericValue: numericCode,
      textValue: textLabel,
      conflict: false,
      resolvedTypeId: inactiveTextMatch.id,
      resolvedTypeCode: inactiveTextMatch.code,
      resolvedTypeLabel: inactiveTextMatch.name,
      reason: "text inactive match included",
    };
  }

  if (!numericCode && !textLabel) {
    return {
      action: "SKIP",
      sourceField: "none",
      sourceValue: null,
      numericValue: null,
      textValue: null,
      conflict: false,
      resolvedTypeId: null,
      resolvedTypeCode: null,
      resolvedTypeLabel: null,
      reason: "no preserved project type data",
    };
  }

  if (inactiveTextMatch && !input.includeLegacy) {
    return {
      action: "SKIP",
      sourceField: "text",
      sourceValue: textLabel,
      numericValue: numericCode,
      textValue: textLabel,
      conflict: false,
      resolvedTypeId: null,
      resolvedTypeCode: inactiveTextMatch.code,
      resolvedTypeLabel: inactiveTextMatch.name,
      reason: "text matches inactive project type",
    };
  }

  return {
    action: "SKIP",
    sourceField: textLabel ? "text" : "numeric",
    sourceValue: textLabel ?? numericCode,
    numericValue: numericCode,
    textValue: textLabel,
    conflict: false,
    resolvedTypeId: null,
    resolvedTypeCode: null,
    resolvedTypeLabel: null,
    reason: textLabel ? "text label unmapped" : "numeric code unmapped",
  };
}

function increment(breakdown: Record<string, number>, key: string): void {
  breakdown[key] = (breakdown[key] ?? 0) + 1;
}

export function buildTenantBackfillPlan(input: {
  tenant: BackfillTenant;
  projectTypes: ProjectTypeConfigRow[];
  includeLegacy: boolean;
  candidates: CandidateRow[];
}): TenantBackfillPlan {
  const updates: AuditRow[] = [];
  const skips: AuditRow[] = [];
  const conflicts: AuditRow[] = [];
  const updateBreakdown: Record<"numeric" | "text", number> = { numeric: 0, text: 0 };
  const skipBreakdown: Record<string, number> = {};

  for (const candidate of input.candidates) {
    const decision = resolveProjectTypeDecision({
      projectTypes: input.projectTypes,
      includeLegacy: input.includeLegacy,
      hubspotExtraProperties: candidate.hubspotExtraProperties,
    });
    const row: AuditRow = {
      tenant: input.tenant,
      dealId: candidate.id,
      hubspotDealId: candidate.hubspotDealId,
      ...decision,
    };

    if (row.action === "UPDATE") {
      updates.push(row);
      updateBreakdown[row.sourceField === "numeric" ? "numeric" : "text"] += 1;
    } else {
      skips.push(row);
      increment(skipBreakdown, row.reason);
    }

    if (row.conflict) {
      conflicts.push(row);
    }
  }

  return {
    tenant: input.tenant,
    examined: input.candidates.length,
    updates,
    skips,
    conflicts,
    rows: [...updates, ...skips],
    updateBreakdown,
    skipBreakdown,
  };
}

function connectionString(): string {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  return selected;
}

async function loadProjectTypes(client: pg.Client): Promise<ProjectTypeConfigRow[]> {
  const result = await client.query<{
    id: string;
    code: string | null;
    name: string;
    slug: string;
    is_active: boolean;
  }>(`
    SELECT id, code, name, slug, is_active
      FROM public.project_type_config
     ORDER BY display_order, name
  `);

  return result.rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    slug: row.slug,
    isActive: row.is_active,
  }));
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
    hubspot_extra_properties: Record<string, unknown> | null;
  }>(`
    SELECT id,
           hubspot_deal_id,
           hubspot_extra_properties
      FROM ${quotedTenant}.deals
     WHERE project_type_id IS NULL
     ORDER BY id ASC
     ${limitSql}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    hubspotDealId: row.hubspot_deal_id,
    hubspotExtraProperties: row.hubspot_extra_properties,
  }));
}

function csvCell(value: unknown): string {
  const raw = value == null ? "" : String(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function writeCsvReport(rows: AuditRow[], timestamp: string): string {
  const auditDir = path.resolve(process.cwd(), "docs/audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const pathname = path.join(auditDir, `project-type-backfill-${timestamp}.csv`);
  const header = [
    "tenant",
    "deal_id",
    "hubspot_deal_id",
    "source_field",
    "source_value",
    "numeric_value",
    "text_value",
    "conflict",
    "resolved_type_id",
    "resolved_type_code",
    "resolved_type_label",
    "action",
    "reason",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.tenant,
        row.dealId,
        row.hubspotDealId,
        row.sourceField,
        row.sourceValue,
        row.numericValue,
        row.textValue,
        row.conflict ? "yes" : "no",
        row.resolvedTypeId,
        row.resolvedTypeCode,
        row.resolvedTypeLabel,
        row.action,
        row.reason,
      ].map(csvCell).join(",")
    );
  }
  fs.writeFileSync(pathname, `${lines.join("\n")}\n`);
  return pathname;
}

function sampleDealIds(rows: AuditRow[], reason?: string): string {
  return rows
    .filter((row) => !reason || row.reason === reason)
    .slice(0, 5)
    .map((row) => row.dealId)
    .join(", ") || "none";
}

function summarizePlans(plans: TenantBackfillPlan[]): AuditRow[] {
  const allRows = plans.flatMap((plan) => plan.rows);
  for (const plan of plans) {
    console.log(`\n[${plan.tenant}]`);
    console.log(`  Total candidates examined: ${plan.examined}`);
    console.log(`  Eligible for backfill: ${plan.updates.length}`);
    console.log(`    Numeric code: ${plan.updateBreakdown.numeric}`);
    console.log(`    Text label: ${plan.updateBreakdown.text}`);
    console.log(`  Skipped: ${plan.skips.length}`);
    console.log(`    No preserved data: ${plan.skipBreakdown["no preserved project type data"] ?? 0}`);
    console.log(`      sample: ${sampleDealIds(plan.skips, "no preserved project type data")}`);
    console.log(`    Inactive text without --include-legacy: ${plan.skipBreakdown["text matches inactive project type"] ?? 0}`);
    console.log(`      sample: ${sampleDealIds(plan.skips, "text matches inactive project type")}`);
    console.log(`    Text unmapped: ${plan.skipBreakdown["text label unmapped"] ?? 0}`);
    console.log(`    Numeric unmapped: ${plan.skipBreakdown["numeric code unmapped"] ?? 0}`);
    console.log(`  Conflict resolutions (numeric won over text): ${plan.conflicts.length}`);
    console.log("  Conflict sample:");
    console.table(
      plan.conflicts.slice(0, 5).map((row) => ({
        dealId: row.dealId,
        hubspotDealId: row.hubspotDealId,
        numericValue: row.numericValue,
        textValue: row.textValue,
        resolvedType: row.resolvedTypeLabel,
      }))
    );
  }

  console.log("\n[overall]");
  console.log(`  Total candidates examined: ${plans.reduce((sum, plan) => sum + plan.examined, 0)}`);
  console.log(`  Eligible for backfill: ${plans.reduce((sum, plan) => sum + plan.updates.length, 0)}`);
  console.log(`  Skipped: ${plans.reduce((sum, plan) => sum + plan.skips.length, 0)}`);
  console.log(`  Conflict resolutions: ${plans.reduce((sum, plan) => sum + plan.conflicts.length, 0)}`);
  return allRows;
}

async function confirmExecution(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Type 'y' to execute project_type_id updates: ");
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
      for (const row of batch) {
        if (!row.resolvedTypeId) {
          throw new Error(`Refusing NULL project_type_id update for ${plan.tenant}/${row.dealId}`);
        }
        const result = await client.query(
          `UPDATE ${quotedTenant}.deals
              SET project_type_id = $1::uuid,
                  updated_at = NOW()
            WHERE id = $2::uuid
              AND project_type_id IS NULL`,
          [row.resolvedTypeId, row.dealId]
        );
        batchUpdated += result.rowCount ?? 0;
      }
      await client.query("COMMIT");
      updated += batchUpdated;
      console.log(`[${plan.tenant}] committed batch ${index / DEFAULT_BATCH_SIZE + 1} (${batchUpdated}/${batch.length} rows updated)`);
    } catch (error) {
      await client.query("ROLLBACK");
      failedBatches += 1;
      console.error(`[${plan.tenant}] aborted batch ${index / DEFAULT_BATCH_SIZE + 1}; continuing to next batch`);
      console.error(error instanceof Error ? error.message : error);
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
    const projectTypes = await loadProjectTypes(client);
    const plans: TenantBackfillPlan[] = [];
    for (const tenant of args.tenants) {
      const candidates = await loadCandidates(client, tenant, args.limit);
      plans.push(
        buildTenantBackfillPlan({
          tenant,
          projectTypes,
          includeLegacy: args.includeLegacy,
          candidates,
        })
      );
    }

    const auditRows = summarizePlans(plans);
    const auditPath = writeCsvReport(auditRows, timestamp);
    console.log(`\nAudit CSV: ${auditPath}`);

    if (args.dryRun) {
      console.log("\nDRY RUN ONLY: no database writes performed. Pass --execute to update rows.");
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
