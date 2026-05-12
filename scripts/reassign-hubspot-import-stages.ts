import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

const ALLOWED_TENANTS = ["office_dallas", "office_atlanta", "office_pwauditoffice"] as const;
const IMPORT_SOURCE = "hubspot_missing_deals_import_2026_05_11";

const OPPORTUNITY_STAGE_ID = "03ab1b79-9412-43ec-82b4-624e0a60fd19";
const DD_STAGE_ID = "0416a7db-1e5a-4d0a-88a2-bc5f1480755c";

export type ReassignTenant = (typeof ALLOWED_TENANTS)[number];

export interface ReassignArgs {
  tenants: ReassignTenant[];
  dryRun: boolean;
  execute: boolean;
}

export interface ReassignCandidate {
  dealId: string;
  dealNumber: string | null;
  projectNumber: string | null;
  currentStageId: string;
  hubspotStageName: string | null;
  hubspotDealId: string | null;
}

export type ReassignAction = "move_to_dd" | "skip_already_correct" | "skip_unmapped" | "skip_idempotent";

export interface ReassignPlanRow {
  tenant: ReassignTenant;
  candidate: ReassignCandidate;
  action: ReassignAction;
  targetStageId: string | null;
  reason: string;
}

export interface ReassignPlan {
  tenant: ReassignTenant;
  examined: number;
  rows: ReassignPlanRow[];
}

const HUBSPOT_STAGE_TO_DD = new Set(["pipe line", "rfp"]);

export function planReassignment(input: {
  tenant: ReassignTenant;
  candidates: ReassignCandidate[];
}): ReassignPlan {
  const rows: ReassignPlanRow[] = [];
  for (const candidate of input.candidates) {
    if (candidate.currentStageId !== OPPORTUNITY_STAGE_ID) {
      rows.push({
        tenant: input.tenant,
        candidate,
        action: "skip_already_correct",
        targetStageId: null,
        reason: `current stage ${candidate.currentStageId} is not opportunity; respecting import-script routing`,
      });
      continue;
    }

    const normalizedHubspotStage = candidate.hubspotStageName?.trim().toLowerCase() ?? "";
    if (HUBSPOT_STAGE_TO_DD.has(normalizedHubspotStage)) {
      rows.push({
        tenant: input.tenant,
        candidate,
        action: "move_to_dd",
        targetStageId: DD_STAGE_ID,
        reason: `HubSpot stage '${candidate.hubspotStageName}' maps to Due Diligence`,
      });
    } else {
      rows.push({
        tenant: input.tenant,
        candidate,
        action: "skip_unmapped",
        targetStageId: null,
        reason: `HubSpot stage '${candidate.hubspotStageName ?? "(missing)"}' has no mapping rule; leaving in Opportunity for manual review`,
      });
    }
  }
  return { tenant: input.tenant, examined: input.candidates.length, rows };
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function connectionString(): string {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  return selected;
}

export function parseReassignArgs(argv: string[]): ReassignArgs {
  const args = argv[0] === "reassign-hubspot-import-stages" ? argv.slice(1) : argv;
  const tenantArg = args.find((arg) => arg.startsWith("--tenant="));
  if (!tenantArg) throw new Error("--tenant=<office_dallas|office_atlanta|office_pwauditoffice|all> is required");
  const tenantValue = tenantArg.split("=").slice(1).join("=");
  const tenants =
    tenantValue === "all"
      ? [...ALLOWED_TENANTS]
      : ALLOWED_TENANTS.includes(tenantValue as ReassignTenant)
        ? [tenantValue as ReassignTenant]
        : null;
  if (!tenants) throw new Error(`--tenant must be one of ${ALLOWED_TENANTS.join(", ")}, all`);

  const hasDryRun = args.includes("--dry-run");
  const hasExecute = args.includes("--execute");
  if (hasDryRun && hasExecute) throw new Error("Choose either --dry-run or --execute, not both");

  return { tenants, dryRun: !hasExecute, execute: hasExecute };
}

async function loadCandidates(client: pg.Client, tenant: ReassignTenant): Promise<ReassignCandidate[]> {
  const quoted = quoteIdent(tenant);
  const result = await client.query<{
    id: string;
    deal_number: string | null;
    project_number: string | null;
    stage_id: string;
    hubspot_stage_name: string | null;
    hubspot_deal_id: string | null;
  }>(`
    SELECT id,
           deal_number,
           project_number,
           stage_id,
           hubspot_extra_properties->>'hubspot_stage_name' AS hubspot_stage_name,
           hubspot_deal_id
      FROM ${quoted}.deals
     WHERE source = $1
       AND COALESCE(hubspot_extra_properties->'phase_b_reassignment'->>'reassigned_at', '') = ''
     ORDER BY id ASC
  `, [IMPORT_SOURCE]);

  return result.rows.map((row) => ({
    dealId: row.id,
    dealNumber: row.deal_number,
    projectNumber: row.project_number,
    currentStageId: row.stage_id,
    hubspotStageName: row.hubspot_stage_name,
    hubspotDealId: row.hubspot_deal_id,
  }));
}

function csvCell(value: unknown): string {
  const raw = value == null ? "" : String(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function writeAuditCsv(rows: ReassignPlanRow[], timestamp: string): string {
  const auditDir = path.resolve(process.cwd(), "docs/audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const pathname = path.join(auditDir, `hubspot-stage-reassignment-${timestamp}.csv`);
  const header = [
    "tenant",
    "deal_id",
    "deal_number",
    "project_number",
    "hubspot_deal_id",
    "hubspot_stage_name",
    "current_stage_id",
    "action",
    "target_stage_id",
    "reason",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.tenant,
        row.candidate.dealId,
        row.candidate.dealNumber,
        row.candidate.projectNumber,
        row.candidate.hubspotDealId,
        row.candidate.hubspotStageName,
        row.candidate.currentStageId,
        row.action,
        row.targetStageId,
        row.reason,
      ].map(csvCell).join(",")
    );
  }
  fs.writeFileSync(pathname, `${lines.join("\n")}\n`);
  return pathname;
}

function summarizePlans(plans: ReassignPlan[]): ReassignPlanRow[] {
  for (const plan of plans) {
    const breakdown = plan.rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.action] = (acc[row.action] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`\n[${plan.tenant}]`);
    console.log(`  Examined: ${plan.examined}`);
    for (const [action, count] of Object.entries(breakdown)) {
      console.log(`  ${action}: ${count}`);
    }
    const moves = plan.rows.filter((row) => row.action === "move_to_dd");
    if (moves.length > 0) {
      console.table(
        moves.slice(0, 25).map((row) => ({
          dealId: row.candidate.dealId,
          dealNumber: row.candidate.dealNumber,
          hubspotStageName: row.candidate.hubspotStageName,
          targetStageId: row.targetStageId,
        }))
      );
    }
  }
  return plans.flatMap((plan) => plan.rows);
}

async function confirmExecution(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Type 'y' to execute HubSpot import stage reassignment: ");
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

export async function executePlan(client: pg.Client, plan: ReassignPlan): Promise<{
  updated: number;
  failedRows: number;
}> {
  const quoted = quoteIdent(plan.tenant);
  let updated = 0;
  let failedRows = 0;
  const reassignedAt = new Date().toISOString();

  for (const row of plan.rows) {
    if (row.action !== "move_to_dd" || !row.targetStageId) continue;

    try {
      await client.query("BEGIN");

      const updateResult = await client.query(
        `UPDATE ${quoted}.deals
            SET stage_id = $1,
                stage_entered_at = NOW(),
                updated_at = NOW(),
                hubspot_extra_properties = COALESCE(hubspot_extra_properties, '{}'::jsonb)
                  || jsonb_build_object(
                       'phase_b_reassignment',
                       jsonb_build_object(
                         'from_stage_id', stage_id::text,
                         'to_stage_id', $1::text,
                         'reassigned_at', $2::text,
                         'reason', $3::text
                       )
                     )
          WHERE id = $4::uuid
            AND stage_id = $5::uuid`,
        [row.targetStageId, reassignedAt, row.reason, row.candidate.dealId, row.candidate.currentStageId]
      );

      const rowsAffected = updateResult.rowCount ?? 0;
      if (rowsAffected === 0) {
        await client.query("ROLLBACK");
        console.warn(
          `[${plan.tenant}] deal ${row.candidate.dealId} not updated (current stage may have changed since plan)`
        );
        continue;
      }

      await client.query(
        `INSERT INTO ${quoted}.deal_stage_history
           (deal_id, from_stage_id, to_stage_id, changed_by, change_reason, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, NULL,
                 'phase_b_hubspot_import_reassignment: ' || $4, NOW())`,
        [row.candidate.dealId, row.candidate.currentStageId, row.targetStageId, row.reason]
      );

      await client.query("COMMIT");
      updated += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      failedRows += 1;
      console.error(`[${plan.tenant}] failed deal ${row.candidate.dealId}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return { updated, failedRows };
}

export async function runReassignHubspotImportStages(argv = process.argv.slice(2)): Promise<void> {
  const args = parseReassignArgs(argv);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const plans: ReassignPlan[] = [];
    for (const tenant of args.tenants) {
      const candidates = await loadCandidates(client, tenant);
      plans.push(planReassignment({ tenant, candidates }));
    }

    const allRows = summarizePlans(plans);
    const auditPath = writeAuditCsv(allRows, timestamp);
    console.log(`\nAudit CSV: ${auditPath}`);

    if (args.dryRun) {
      console.log("\nDRY RUN ONLY: no database writes performed. Pass --execute to apply.");
      return;
    }

    const confirmed = await confirmExecution();
    if (!confirmed) {
      console.log("Execution cancelled.");
      return;
    }

    let totalUpdated = 0;
    let totalFailed = 0;
    for (const plan of plans) {
      const result = await executePlan(client, plan);
      totalUpdated += result.updated;
      totalFailed += result.failedRows;
    }

    console.log("\nEXECUTION COMPLETE");
    console.log(`  Deals reassigned: ${totalUpdated}`);
    console.log(`  Failed rows: ${totalFailed}`);
    console.log(`  Audit CSV: ${auditPath}`);
    if (totalFailed > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  runReassignHubspotImportStages().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
