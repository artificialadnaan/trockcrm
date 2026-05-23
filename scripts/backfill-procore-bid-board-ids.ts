import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const TENANT_SCHEMAS = ["office_dallas", "office_atlanta", "office_pwauditoffice"] as const;
export const EXPECTED_PROCORE_COMPANY_ID = "598134325683880";

type TenantSchema = (typeof TENANT_SCHEMAS)[number];
type BackfillMode = "dry-run" | "dry-check" | "commit";

export interface BackfillArgs {
  mode: BackfillMode;
}

export interface CrmBackfillCandidate {
  tenantSchema: TenantSchema;
  dealId: string;
  dealName: string | null;
  bidBoardProjectNumber: string;
  projectNumberNorm: string;
  procoreBidId: string | null;
  procoreCompanyId: string | null;
}

export interface SyncHubRfpRow {
  rfpApprovalRequestId: number;
  projectNumber: string;
  projectNumberNorm: string;
  bidboardProjectId: string;
  approvedAt: Date | null;
}

export interface BackfillPlanRow {
  tenantSchema: TenantSchema;
  dealId: string;
  dealName: string | null;
  bidBoardProjectNumber: string;
  projectNumberNorm: string;
  oldProcoreBidId: string | null;
  oldProcoreCompanyId: string | null;
  newProcoreBidId: string;
  newProcoreCompanyId: string;
  sourceRfpApprovalRequestIds: number[];
}

export interface AmbiguousSyncHubMatch {
  projectNumberNorm: string;
  bidBoardProjectNumber: string;
  bidboardProjectIds: string[];
  rfpApprovalRequestIds: number[];
}

export interface ExistingConflict {
  tenantSchema: TenantSchema;
  dealId: string;
  bidBoardProjectNumber: string;
  existingProcoreBidId: string | null;
  existingProcoreCompanyId: string | null;
  proposedProcoreBidId: string;
  proposedProcoreCompanyId: string;
}

export interface BackfillPlan {
  counts: {
    candidateDeals: number;
    willUpdate: number;
    skippedNoSyncHubMatch: number;
    skippedAmbiguousSyncHubMatch: number;
    skippedAmbiguousCrmProjectNumber: number;
    skippedExistingConflict: number;
  };
  willUpdate: BackfillPlanRow[];
  noSyncHubMatches: CrmBackfillCandidate[];
  ambiguousSyncHubMatches: AmbiguousSyncHubMatch[];
  ambiguousCrmProjectNumbers: string[];
  existingConflicts: ExistingConflict[];
}

export interface CrmBaselineCounts {
  nonHoldActive: number;
  alreadyLinkable: number;
  missingEitherId: number;
  missingEitherWithProjectNumber: number;
  missingEitherWithoutProjectNumber: number;
}

export interface BackfillRunReport {
  mode: BackfillMode;
  companyId: string;
  crmBaseline: Record<TenantSchema, CrmBaselineCounts>;
  plan: BackfillPlan;
  backupPath: string | null;
  updatedRows: number;
  verifiedRows: number;
  postCommitVerifiedRows: number;
  committed: boolean;
  rolledBack: boolean;
}

function isNumericText(value: string | null | undefined): value is string {
  return /^\d+$/.test(String(value ?? "").trim());
}

export function normalizeProjectNumber(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function trimText(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseBackfillArgs(argv = process.argv): BackfillArgs {
  const args = argv.slice(2);
  const hasDryRun = args.includes("--dry-run");
  const hasDryCheck = args.includes("--dry-check") || args.includes("--rolled-back-dry-check");
  const hasCommit = args.includes("--commit");
  const selected = [hasDryRun, hasDryCheck, hasCommit].filter(Boolean).length;
  if (selected > 1) {
    throw new Error("Choose exactly one of --dry-run, --dry-check, or --commit");
  }
  if (hasCommit) return { mode: "commit" };
  if (hasDryCheck) return { mode: "dry-check" };
  return { mode: "dry-run" };
}

export function validateSingleCompanySafetyCheck(input: {
  expectedCompanyId?: string;
  configCompanyId: string | null;
  callbackCompanyIds: string[];
}): string[] {
  const expectedCompanyId = input.expectedCompanyId ?? EXPECTED_PROCORE_COMPANY_ID;
  const observed = new Set<string>();
  const configCompanyId = trimText(input.configCompanyId);
  if (configCompanyId) observed.add(configCompanyId);
  for (const value of input.callbackCompanyIds) {
    const trimmed = trimText(value);
    if (trimmed) observed.add(trimmed);
  }
  const observedIds = [...observed].sort();
  if (observedIds.length !== 1 || observedIds[0] !== expectedCompanyId) {
    throw new Error(
      `Single-company safety check failed: expected only ${expectedCompanyId}, observed ${observedIds.join(", ") || "(none)"}`
    );
  }
  return observedIds;
}

function newestFirst(a: SyncHubRfpRow, b: SyncHubRfpRow): number {
  const aTime = a.approvedAt?.getTime() ?? 0;
  const bTime = b.approvedAt?.getTime() ?? 0;
  if (aTime !== bTime) return bTime - aTime;
  return b.rfpApprovalRequestId - a.rfpApprovalRequestId;
}

export function buildBackfillPlan(input: {
  crmDeals: CrmBackfillCandidate[];
  syncHubRows: SyncHubRfpRow[];
  procoreCompanyId: string;
}): BackfillPlan {
  const syncHubByProjectNumber = new Map<string, SyncHubRfpRow[]>();
  for (const row of input.syncHubRows) {
    if (!isNumericText(row.bidboardProjectId)) continue;
    const existing = syncHubByProjectNumber.get(row.projectNumberNorm) ?? [];
    existing.push(row);
    syncHubByProjectNumber.set(row.projectNumberNorm, existing);
  }

  const crmCountsByProjectNumber = new Map<string, number>();
  for (const deal of input.crmDeals) {
    crmCountsByProjectNumber.set(
      deal.projectNumberNorm,
      (crmCountsByProjectNumber.get(deal.projectNumberNorm) ?? 0) + 1
    );
  }
  const ambiguousCrmProjectNumbers = [...crmCountsByProjectNumber.entries()]
    .filter(([, count]) => count > 1)
    .map(([projectNumber]) => projectNumber)
    .sort();
  const ambiguousCrmSet = new Set(ambiguousCrmProjectNumbers);

  const willUpdate: BackfillPlanRow[] = [];
  const noSyncHubMatches: CrmBackfillCandidate[] = [];
  const ambiguousSyncHubMatches: AmbiguousSyncHubMatch[] = [];
  const existingConflicts: ExistingConflict[] = [];
  const seenAmbiguousSyncHub = new Set<string>();
  let skippedAmbiguousCrmProjectNumber = 0;

  for (const deal of input.crmDeals) {
    if (ambiguousCrmSet.has(deal.projectNumberNorm)) {
      skippedAmbiguousCrmProjectNumber++;
      continue;
    }

    const syncHubRows = syncHubByProjectNumber.get(deal.projectNumberNorm) ?? [];
    if (syncHubRows.length === 0) {
      noSyncHubMatches.push(deal);
      continue;
    }

    const distinctBidIds = [...new Set(syncHubRows.map((row) => row.bidboardProjectId.trim()))].sort();
    if (distinctBidIds.length !== 1) {
      if (!seenAmbiguousSyncHub.has(deal.projectNumberNorm)) {
        seenAmbiguousSyncHub.add(deal.projectNumberNorm);
        ambiguousSyncHubMatches.push({
          projectNumberNorm: deal.projectNumberNorm,
          bidBoardProjectNumber: deal.bidBoardProjectNumber,
          bidboardProjectIds: distinctBidIds,
          rfpApprovalRequestIds: syncHubRows
            .map((row) => row.rfpApprovalRequestId)
            .sort((a, b) => a - b),
        });
      }
      continue;
    }

    const newProcoreBidId = distinctBidIds[0]!;
    const currentBidId = trimText(deal.procoreBidId);
    const currentCompanyId = trimText(deal.procoreCompanyId);
    if (
      (currentBidId !== null && currentBidId !== newProcoreBidId) ||
      (currentCompanyId !== null && currentCompanyId !== input.procoreCompanyId)
    ) {
      existingConflicts.push({
        tenantSchema: deal.tenantSchema,
        dealId: deal.dealId,
        bidBoardProjectNumber: deal.bidBoardProjectNumber,
        existingProcoreBidId: currentBidId,
        existingProcoreCompanyId: currentCompanyId,
        proposedProcoreBidId: newProcoreBidId,
        proposedProcoreCompanyId: input.procoreCompanyId,
      });
      continue;
    }

    const sourceRows = [...syncHubRows].sort(newestFirst);
    willUpdate.push({
      tenantSchema: deal.tenantSchema,
      dealId: deal.dealId,
      dealName: deal.dealName,
      bidBoardProjectNumber: deal.bidBoardProjectNumber,
      projectNumberNorm: deal.projectNumberNorm,
      oldProcoreBidId: currentBidId,
      oldProcoreCompanyId: currentCompanyId,
      newProcoreBidId,
      newProcoreCompanyId: input.procoreCompanyId,
      sourceRfpApprovalRequestIds: sourceRows.map((row) => row.rfpApprovalRequestId),
    });
  }

  return {
    counts: {
      candidateDeals: input.crmDeals.length,
      willUpdate: willUpdate.length,
      skippedNoSyncHubMatch: noSyncHubMatches.length,
      skippedAmbiguousSyncHubMatch: ambiguousSyncHubMatches.length,
      skippedAmbiguousCrmProjectNumber,
      skippedExistingConflict: existingConflicts.length,
    },
    willUpdate,
    noSyncHubMatches,
    ambiguousSyncHubMatches,
    ambiguousCrmProjectNumbers,
    existingConflicts,
  };
}

export function buildBackfillUpdateSql(schema: TenantSchema): string {
  return `
    UPDATE ${schema}.deals
       SET procore_bid_id = $1::bigint,
           procore_company_id = $2
     WHERE id = $3::uuid
       AND lower(trim(bid_board_project_number)) = $4
       AND is_active = true
       AND coalesce(on_hold, false) = false
       AND (procore_bid_id IS NULL OR procore_bid_id = $1::bigint)
       AND (procore_company_id IS NULL OR procore_company_id = $2)
       AND (procore_bid_id IS NULL OR procore_company_id IS NULL)
     RETURNING id
  `;
}

function envValueFromFile(filePath: string, key: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const contents = fs.readFileSync(filePath, "utf8");
  const line = contents.split(/\r?\n/).find((entry) => entry.trim().startsWith(`${key}=`));
  if (!line) return null;
  return line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
}

function loadCrmDatabaseUrl(): string {
  const explicit = trimText(process.env.CRM_DATABASE_PUBLIC_URL);
  if (explicit) return explicit;

  const envCandidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../..", ".env"),
  ];
  for (const envPath of envCandidates) {
    const fromFile = envValueFromFile(envPath, "DATABASE_PUBLIC_URL");
    if (fromFile) return fromFile;
  }
  throw new Error("CRM DATABASE_PUBLIC_URL missing. Set CRM_DATABASE_PUBLIC_URL or provide the CRM root .env.");
}

function loadSyncHubDatabaseUrl(): string {
  const selected =
    trimText(process.env.SYNCHUB_DATABASE_URL) ??
    trimText(process.env.DATABASE_PUBLIC_URL) ??
    trimText(process.env.DATABASE_URL);
  if (!selected) {
    throw new Error("SyncHub database URL missing. Run through Railway Postgres env or set SYNCHUB_DATABASE_URL.");
  }
  return selected;
}

async function fetchSingleCompanySafetyData(syncHubClient: pg.Client): Promise<{
  configCompanyId: string | null;
  callbackCompanyIds: string[];
}> {
  const configResult = await syncHubClient.query<{ company_id: string | null }>(`
    SELECT value->>'companyId' AS company_id
      FROM automation_config
     WHERE key = 'procore_config'
     LIMIT 1
  `);
  const callbackResult = await syncHubClient.query<{ company_id: string }>(`
    SELECT DISTINCT btrim(payload->>'procoreCompanyId') AS company_id
      FROM bidboard_callback_outbox
     WHERE payload ? 'procoreCompanyId'
       AND btrim(payload->>'procoreCompanyId') <> ''
     ORDER BY company_id
  `);

  return {
    configCompanyId: configResult.rows[0]?.company_id ?? null,
    callbackCompanyIds: callbackResult.rows.map((row) => row.company_id),
  };
}

async function fetchSyncHubApprovedRfpRows(syncHubClient: pg.Client): Promise<SyncHubRfpRow[]> {
  const result = await syncHubClient.query<{
    id: number;
    project_number: string;
    project_number_norm: string;
    bidboard_project_id: string;
    approved_at: Date | null;
  }>(`
    SELECT id,
           btrim(project_number) AS project_number,
           lower(btrim(project_number)) AS project_number_norm,
           btrim(bidboard_project_id) AS bidboard_project_id,
           approved_at
      FROM rfp_approval_requests
     WHERE status = 'approved'
       AND project_number IS NOT NULL
       AND btrim(project_number) <> ''
       AND bidboard_project_id IS NOT NULL
       AND btrim(bidboard_project_id) ~ '^\\d+$'
     ORDER BY approved_at DESC NULLS LAST, id DESC
  `);

  return result.rows.map((row) => ({
    rfpApprovalRequestId: row.id,
    projectNumber: row.project_number,
    projectNumberNorm: row.project_number_norm,
    bidboardProjectId: row.bidboard_project_id,
    approvedAt: row.approved_at,
  }));
}

async function fetchCrmBaselineCounts(crmClient: pg.Client): Promise<Record<TenantSchema, CrmBaselineCounts>> {
  const counts = {} as Record<TenantSchema, CrmBaselineCounts>;
  for (const schema of TENANT_SCHEMAS) {
    const result = await crmClient.query<{
      non_hold_active: number;
      already_linkable: number;
      missing_either_id: number;
      missing_either_with_project_number: number;
      missing_either_without_project_number: number;
    }>(`
      SELECT count(*) FILTER (
               WHERE is_active = true AND coalesce(on_hold, false) = false
             )::int AS non_hold_active,
             count(*) FILTER (
               WHERE is_active = true
                 AND coalesce(on_hold, false) = false
                 AND procore_company_id IS NOT NULL
                 AND procore_bid_id IS NOT NULL
             )::int AS already_linkable,
             count(*) FILTER (
               WHERE is_active = true
                 AND coalesce(on_hold, false) = false
                 AND (procore_company_id IS NULL OR procore_bid_id IS NULL)
             )::int AS missing_either_id,
             count(*) FILTER (
               WHERE is_active = true
                 AND coalesce(on_hold, false) = false
                 AND (procore_company_id IS NULL OR procore_bid_id IS NULL)
                 AND nullif(trim(bid_board_project_number), '') IS NOT NULL
             )::int AS missing_either_with_project_number,
             count(*) FILTER (
               WHERE is_active = true
                 AND coalesce(on_hold, false) = false
                 AND (procore_company_id IS NULL OR procore_bid_id IS NULL)
                 AND nullif(trim(bid_board_project_number), '') IS NULL
             )::int AS missing_either_without_project_number
        FROM ${schema}.deals
    `);
    const row = result.rows[0]!;
    counts[schema] = {
      nonHoldActive: Number(row.non_hold_active),
      alreadyLinkable: Number(row.already_linkable),
      missingEitherId: Number(row.missing_either_id),
      missingEitherWithProjectNumber: Number(row.missing_either_with_project_number),
      missingEitherWithoutProjectNumber: Number(row.missing_either_without_project_number),
    };
  }
  return counts;
}

async function fetchCrmCandidates(crmClient: pg.Client): Promise<CrmBackfillCandidate[]> {
  const candidates: CrmBackfillCandidate[] = [];
  for (const schema of TENANT_SCHEMAS) {
    const result = await crmClient.query<{
      deal_id: string;
      deal_name: string | null;
      bid_board_project_number: string;
      project_number_norm: string;
      procore_bid_id: string | null;
      procore_company_id: string | null;
    }>(`
      SELECT id::text AS deal_id,
             name AS deal_name,
             btrim(bid_board_project_number) AS bid_board_project_number,
             lower(btrim(bid_board_project_number)) AS project_number_norm,
             procore_bid_id::text AS procore_bid_id,
             procore_company_id
        FROM ${schema}.deals
       WHERE is_active = true
         AND coalesce(on_hold, false) = false
         AND (procore_company_id IS NULL OR procore_bid_id IS NULL)
         AND nullif(trim(bid_board_project_number), '') IS NOT NULL
       ORDER BY bid_board_project_number, id
    `);

    for (const row of result.rows) {
      const projectNumberNorm = normalizeProjectNumber(row.bid_board_project_number);
      if (!projectNumberNorm) continue;
      candidates.push({
        tenantSchema: schema,
        dealId: row.deal_id,
        dealName: row.deal_name,
        bidBoardProjectNumber: row.bid_board_project_number,
        projectNumberNorm,
        procoreBidId: row.procore_bid_id,
        procoreCompanyId: row.procore_company_id,
      });
    }
  }
  return candidates;
}

function backupPayload(planRows: BackfillPlanRow[]) {
  return {
    createdAt: new Date().toISOString(),
    rowCount: planRows.length,
    rows: planRows.map((row) => ({
      tenantSchema: row.tenantSchema,
      dealId: row.dealId,
      dealName: row.dealName,
      bidBoardProjectNumber: row.bidBoardProjectNumber,
      oldProcoreBidId: row.oldProcoreBidId,
      oldProcoreCompanyId: row.oldProcoreCompanyId,
      proposedProcoreBidId: row.newProcoreBidId,
      proposedProcoreCompanyId: row.newProcoreCompanyId,
      sourceRfpApprovalRequestIds: row.sourceRfpApprovalRequestIds,
    })),
  };
}

function writeBackupSnapshot(planRows: BackfillPlanRow[], mode: BackfillMode): string {
  const backupPath = path.join(
    "/private/tmp",
    `trockcrm-procore-id-backfill-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(backupPath, `${JSON.stringify(backupPayload(planRows), null, 2)}\n`, "utf8");
  return backupPath;
}

async function applyBackfillPlan(crmClient: pg.Client, planRows: BackfillPlanRow[]): Promise<number> {
  let updatedRows = 0;
  for (const row of planRows) {
    const updateResult = await crmClient.query(
      buildBackfillUpdateSql(row.tenantSchema),
      [row.newProcoreBidId, row.newProcoreCompanyId, row.dealId, row.projectNumberNorm]
    );
    if (updateResult.rowCount !== 1) {
      throw new Error(`Expected to update 1 row for deal ${row.dealId}, updated ${updateResult.rowCount ?? 0}`);
    }
    updatedRows++;
  }
  return updatedRows;
}

async function verifyBackfilledRows(crmClient: pg.Client, planRows: BackfillPlanRow[]): Promise<number> {
  let verifiedRows = 0;
  for (const row of planRows) {
    const result = await crmClient.query<{ ok: boolean }>(
      `
        SELECT (procore_bid_id = $1::bigint AND procore_company_id = $2) AS ok
          FROM ${row.tenantSchema}.deals
         WHERE id = $3::uuid
         LIMIT 1
      `,
      [row.newProcoreBidId, row.newProcoreCompanyId, row.dealId]
    );
    if (result.rows[0]?.ok !== true) {
      throw new Error(`Post-update verification failed for deal ${row.dealId}`);
    }
    verifiedRows++;
  }
  return verifiedRows;
}

async function fetchSyncHubInputs(syncHubClient: pg.Client): Promise<{
  companyId: string;
  syncHubRows: SyncHubRfpRow[];
}> {
  await syncHubClient.query("BEGIN READ ONLY");
  try {
    const safetyData = await fetchSingleCompanySafetyData(syncHubClient);
    const [companyId] = validateSingleCompanySafetyCheck({
      expectedCompanyId: EXPECTED_PROCORE_COMPANY_ID,
      configCompanyId: safetyData.configCompanyId,
      callbackCompanyIds: safetyData.callbackCompanyIds,
    });
    const syncHubRows = await fetchSyncHubApprovedRfpRows(syncHubClient);
    await syncHubClient.query("ROLLBACK");
    return { companyId, syncHubRows };
  } catch (error) {
    await syncHubClient.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function runBackfill(input: {
  crmClient: pg.Client;
  syncHubRows: SyncHubRfpRow[];
  companyId: string;
  mode: BackfillMode;
}): Promise<BackfillRunReport> {
  const isWriteCheck = input.mode !== "dry-run";
  await input.crmClient.query(isWriteCheck ? "BEGIN" : "BEGIN READ ONLY");
  let backupPath: string | null = null;
  try {
    const crmBaseline = await fetchCrmBaselineCounts(input.crmClient);
    const crmDeals = await fetchCrmCandidates(input.crmClient);
    const plan = buildBackfillPlan({
      crmDeals,
      syncHubRows: input.syncHubRows,
      procoreCompanyId: input.companyId,
    });

    let updatedRows = 0;
    let verifiedRows = 0;
    let postCommitVerifiedRows = 0;
    if (isWriteCheck) {
      backupPath = writeBackupSnapshot(plan.willUpdate, input.mode);
      updatedRows = await applyBackfillPlan(input.crmClient, plan.willUpdate);
      verifiedRows = await verifyBackfilledRows(input.crmClient, plan.willUpdate);
    }

    if (input.mode === "commit") {
      await input.crmClient.query("COMMIT");
      postCommitVerifiedRows = await verifyBackfilledRows(input.crmClient, plan.willUpdate);
    } else {
      await input.crmClient.query("ROLLBACK");
    }

    return {
      mode: input.mode,
      companyId: input.companyId,
      crmBaseline,
      plan,
      backupPath,
      updatedRows,
      verifiedRows,
      postCommitVerifiedRows,
      committed: input.mode === "commit",
      rolledBack: input.mode !== "commit",
    };
  } catch (error) {
    await input.crmClient.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

function printRunReport(report: BackfillRunReport): void {
  const baselineTotals = Object.values(report.crmBaseline).reduce(
    (totals, row) => ({
      nonHoldActive: totals.nonHoldActive + row.nonHoldActive,
      alreadyLinkable: totals.alreadyLinkable + row.alreadyLinkable,
      missingEitherId: totals.missingEitherId + row.missingEitherId,
      missingEitherWithProjectNumber:
        totals.missingEitherWithProjectNumber + row.missingEitherWithProjectNumber,
      missingEitherWithoutProjectNumber:
        totals.missingEitherWithoutProjectNumber + row.missingEitherWithoutProjectNumber,
    }),
    {
      nonHoldActive: 0,
      alreadyLinkable: 0,
      missingEitherId: 0,
      missingEitherWithProjectNumber: 0,
      missingEitherWithoutProjectNumber: 0,
    }
  );

  console.log("=== Procore Bid Board ID Backfill ===");
  console.log(`Mode: ${report.mode}`);
  console.log(`Company ID: ${report.companyId}`);
  console.log(`Committed: ${report.committed ? "yes" : "no"}`);
  console.log(`Rolled back: ${report.rolledBack ? "yes" : "no"}`);
  if (report.backupPath) console.log(`Backup snapshot: ${report.backupPath}`);
  console.log("");
  console.log("CRM baseline totals:");
  console.table(baselineTotals);
  console.log("CRM baseline by tenant:");
  console.table(report.crmBaseline);
  console.log("");
  console.log("Plan counts:");
  console.table(report.plan.counts);
  if (report.mode !== "dry-run") {
    console.log(`Updated rows inside transaction: ${report.updatedRows}`);
    console.log(`Verified rows inside transaction: ${report.verifiedRows}`);
  }
  if (report.mode === "commit") {
    console.log(`Post-commit verified rows: ${report.postCommitVerifiedRows}`);
  }
  console.log("");
  console.log("Ambiguous SyncHub matches sample:");
  console.table(report.plan.ambiguousSyncHubMatches.slice(0, 10));
  console.log("Existing conflicts sample:");
  console.table(report.plan.existingConflicts.slice(0, 10));
  console.log("No SyncHub match sample:");
  console.table(
    report.plan.noSyncHubMatches.slice(0, 10).map((row) => ({
      tenantSchema: row.tenantSchema,
      dealId: row.dealId,
      bidBoardProjectNumber: row.bidBoardProjectNumber,
    }))
  );
}

export async function main(): Promise<void> {
  const args = parseBackfillArgs();
  const crmUrl = loadCrmDatabaseUrl();
  const syncHubUrl = loadSyncHubDatabaseUrl();
  const crmClient = new pg.Client({ connectionString: crmUrl, ssl: { rejectUnauthorized: false } });
  const syncHubClient = new pg.Client({ connectionString: syncHubUrl, ssl: { rejectUnauthorized: false } });

  try {
    await syncHubClient.connect();
    await crmClient.connect();
    const syncHubInputs = await fetchSyncHubInputs(syncHubClient);
    const report = await runBackfill({
      crmClient,
      syncHubRows: syncHubInputs.syncHubRows,
      companyId: syncHubInputs.companyId,
      mode: args.mode,
    });
    printRunReport(report);
  } finally {
    await syncHubClient.end().catch(() => {});
    await crmClient.end().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("FAIL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
