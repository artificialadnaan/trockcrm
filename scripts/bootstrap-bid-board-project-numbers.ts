import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";

const TENANT_SCHEMAS = ["office_atlanta", "office_dallas", "office_pwauditoffice"] as const;
const AUDIT_TABLE = "bid_board_bootstrap_log";

type TenantSchema = (typeof TENANT_SCHEMAS)[number];

export interface SyncMappingCandidate {
  syncMappingId: number;
  hubspotDealId: string;
  projectNumber: string;
  bidboardProjectId: string | null;
  createdAt: Date;
}

export interface CrmDealMatch {
  tenantSchema: TenantSchema;
  dealId: string;
  hubspotDealId: string;
  bidBoardProjectNumber: string | null;
}

export interface BootstrapPlanRow {
  candidate: SyncMappingCandidate;
  crmDeal: CrmDealMatch;
}

export interface BootstrapReport {
  runId: string;
  dryRun: boolean;
  candidateCount: number;
  willUpdateCount: number;
  skippedAmbiguousHubspotDealIdCount: number;
  skippedAmbiguousProjectNumberCount: number;
  skippedAlreadyPopulatedCount: number;
  skippedNoCrmDealCount: number;
  skippedMultipleCrmDealsCount: number;
  supersededTemporalDuplicateCount: number;
  sanityTotal: number;
  tenantWillUpdate: Record<TenantSchema, number>;
  ambiguousHubspotDealIds: string[];
  ambiguousProjectNumbers: string[];
  noCrmDealHubspotIds: string[];
  alreadyPopulated: Array<{
    tenantSchema: TenantSchema;
    dealId: string;
    hubspotDealId: string;
    existingProjectNumber: string;
    sourceProjectNumber: string;
  }>;
  multipleCrmDeals: Array<{
    hubspotDealId: string;
    matches: Array<{ tenantSchema: TenantSchema; dealId: string }>;
  }>;
  supersededTemporalDuplicates: Array<{
    syncMappingId: number;
    hubspotDealId: string;
    projectNumber: string;
    keptSyncMappingId: number;
  }>;
  planRows: BootstrapPlanRow[];
}

interface ClassifiedCandidates {
  canonical: SyncMappingCandidate[];
  ambiguousHubspotRows: SyncMappingCandidate[];
  ambiguousProjectRows: SyncMappingCandidate[];
  supersededTemporalRows: Array<{
    row: SyncMappingCandidate;
    kept: SyncMappingCandidate;
  }>;
  ambiguousHubspotDealIds: string[];
  ambiguousProjectNumbers: string[];
}

function trimRequired(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function latestFirst(a: SyncMappingCandidate, b: SyncMappingCandidate): number {
  const timeDelta = b.createdAt.getTime() - a.createdAt.getTime();
  if (timeDelta !== 0) return timeDelta;
  return b.syncMappingId - a.syncMappingId;
}

function distinctBy<T>(items: T[], getKey: (item: T) => string): Set<string> {
  const values = new Set<string>();
  for (const item of items) values.add(getKey(item));
  return values;
}

export function classifySyncMappingCandidates(
  candidates: SyncMappingCandidate[]
): ClassifiedCandidates {
  const byHubspot = new Map<string, SyncMappingCandidate[]>();
  const byProjectNumber = new Map<string, SyncMappingCandidate[]>();

  for (const candidate of candidates) {
    const hubspotRows = byHubspot.get(candidate.hubspotDealId) ?? [];
    hubspotRows.push(candidate);
    byHubspot.set(candidate.hubspotDealId, hubspotRows);

    const projectRows = byProjectNumber.get(candidate.projectNumber) ?? [];
    projectRows.push(candidate);
    byProjectNumber.set(candidate.projectNumber, projectRows);
  }

  const ambiguousHubspotDealIds = new Set<string>();
  for (const [hubspotDealId, rows] of byHubspot.entries()) {
    if (distinctBy(rows, (row) => row.projectNumber).size > 1) {
      ambiguousHubspotDealIds.add(hubspotDealId);
    }
  }

  const ambiguousProjectNumbers = new Set<string>();
  for (const [projectNumber, rows] of byProjectNumber.entries()) {
    if (distinctBy(rows, (row) => row.hubspotDealId).size > 1) {
      ambiguousProjectNumbers.add(projectNumber);
    }
  }

  const ambiguousHubspotRows: SyncMappingCandidate[] = [];
  const ambiguousProjectRows: SyncMappingCandidate[] = [];
  const eligibleRows: SyncMappingCandidate[] = [];

  for (const candidate of candidates) {
    if (ambiguousHubspotDealIds.has(candidate.hubspotDealId)) {
      ambiguousHubspotRows.push(candidate);
    } else if (ambiguousProjectNumbers.has(candidate.projectNumber)) {
      ambiguousProjectRows.push(candidate);
    } else {
      eligibleRows.push(candidate);
    }
  }

  const eligibleByDeal = new Map<string, SyncMappingCandidate[]>();
  for (const candidate of eligibleRows) {
    const rows = eligibleByDeal.get(candidate.hubspotDealId) ?? [];
    rows.push(candidate);
    eligibleByDeal.set(candidate.hubspotDealId, rows);
  }

  const canonical: SyncMappingCandidate[] = [];
  const supersededTemporalRows: Array<{ row: SyncMappingCandidate; kept: SyncMappingCandidate }> = [];
  for (const rows of eligibleByDeal.values()) {
    const sorted = [...rows].sort(latestFirst);
    const kept = sorted[0];
    if (!kept) continue;
    canonical.push(kept);
    for (const row of sorted.slice(1)) supersededTemporalRows.push({ row, kept });
  }

  return {
    canonical: canonical.sort(latestFirst),
    ambiguousHubspotRows,
    ambiguousProjectRows,
    supersededTemporalRows,
    ambiguousHubspotDealIds: [...ambiguousHubspotDealIds].sort(),
    ambiguousProjectNumbers: [...ambiguousProjectNumbers].sort(),
  };
}

export function buildBootstrapUpdateSql(schema: TenantSchema): string {
  return `
    UPDATE ${schema}.deals
       SET bid_board_project_number = $1,
           updated_at = NOW()
     WHERE id = $2::uuid
       AND hubspot_deal_id = $3
       AND bid_board_project_number IS NULL
     RETURNING id
  `;
}

export function buildBootstrapAuditInsertSql(schema: TenantSchema): string {
  return `
    INSERT INTO ${schema}.${AUDIT_TABLE} (
      run_id,
      source_sync_mapping_id,
      tenant_schema,
      deal_id,
      hubspot_deal_id,
      bid_board_project_number
    ) VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6)
  `;
}

export function buildBootstrapReport(args: {
  runId: string;
  dryRun: boolean;
  candidateCount: number;
  classified: ClassifiedCandidates;
  crmMatchesByHubspotDealId: Map<string, CrmDealMatch[]>;
}): BootstrapReport {
  const tenantWillUpdate: Record<TenantSchema, number> = {
    office_atlanta: 0,
    office_dallas: 0,
    office_pwauditoffice: 0,
  };
  const planRows: BootstrapPlanRow[] = [];
  const noCrmDealHubspotIds: string[] = [];
  const alreadyPopulated: BootstrapReport["alreadyPopulated"] = [];
  const multipleCrmDeals: BootstrapReport["multipleCrmDeals"] = [];

  let skippedAlreadyPopulatedCount = 0;
  let skippedNoCrmDealCount = 0;
  let skippedMultipleCrmDealsCount = 0;

  for (const candidate of args.classified.canonical) {
    const matches = args.crmMatchesByHubspotDealId.get(candidate.hubspotDealId) ?? [];
    if (matches.length === 0) {
      skippedNoCrmDealCount++;
      noCrmDealHubspotIds.push(candidate.hubspotDealId);
      continue;
    }
    if (matches.length > 1) {
      skippedMultipleCrmDealsCount++;
      multipleCrmDeals.push({
        hubspotDealId: candidate.hubspotDealId,
        matches: matches.map((match) => ({
          tenantSchema: match.tenantSchema,
          dealId: match.dealId,
        })),
      });
      continue;
    }

    const crmDeal = matches[0]!;
    if (crmDeal.bidBoardProjectNumber) {
      skippedAlreadyPopulatedCount++;
      alreadyPopulated.push({
        tenantSchema: crmDeal.tenantSchema,
        dealId: crmDeal.dealId,
        hubspotDealId: crmDeal.hubspotDealId,
        existingProjectNumber: crmDeal.bidBoardProjectNumber,
        sourceProjectNumber: candidate.projectNumber,
      });
      continue;
    }

    tenantWillUpdate[crmDeal.tenantSchema]++;
    planRows.push({ candidate, crmDeal });
  }

  const sanityTotal =
    planRows.length +
    args.classified.ambiguousHubspotRows.length +
    args.classified.ambiguousProjectRows.length +
    skippedAlreadyPopulatedCount +
    skippedNoCrmDealCount +
    skippedMultipleCrmDealsCount +
    args.classified.supersededTemporalRows.length;

  return {
    runId: args.runId,
    dryRun: args.dryRun,
    candidateCount: args.candidateCount,
    willUpdateCount: planRows.length,
    skippedAmbiguousHubspotDealIdCount: args.classified.ambiguousHubspotRows.length,
    skippedAmbiguousProjectNumberCount: args.classified.ambiguousProjectRows.length,
    skippedAlreadyPopulatedCount,
    skippedNoCrmDealCount,
    skippedMultipleCrmDealsCount,
    supersededTemporalDuplicateCount: args.classified.supersededTemporalRows.length,
    sanityTotal,
    tenantWillUpdate,
    ambiguousHubspotDealIds: args.classified.ambiguousHubspotDealIds,
    ambiguousProjectNumbers: args.classified.ambiguousProjectNumbers,
    noCrmDealHubspotIds: [...new Set(noCrmDealHubspotIds)].sort(),
    alreadyPopulated,
    multipleCrmDeals,
    supersededTemporalDuplicates: args.classified.supersededTemporalRows.map(({ row, kept }) => ({
      syncMappingId: row.syncMappingId,
      hubspotDealId: row.hubspotDealId,
      projectNumber: row.projectNumber,
      keptSyncMappingId: kept.syncMappingId,
    })),
    planRows,
  };
}

async function fetchSyncHubCandidates(client: pg.Client): Promise<SyncMappingCandidate[]> {
  const result = await client.query<{
    id: number;
    hubspot_deal_id: string;
    procore_project_number: string;
    bidboard_project_id: string | null;
    created_at: Date;
  }>(`
    SELECT id,
           btrim(hubspot_deal_id) AS hubspot_deal_id,
           btrim(procore_project_number) AS procore_project_number,
           bidboard_project_id,
           created_at
      FROM sync_mappings
     WHERE hubspot_deal_id IS NOT NULL
       AND btrim(hubspot_deal_id) <> ''
       AND procore_project_number IS NOT NULL
       AND btrim(procore_project_number) <> ''
     ORDER BY created_at DESC NULLS LAST, id DESC
  `);

  return result.rows
    .map((row) => {
      const hubspotDealId = trimRequired(row.hubspot_deal_id);
      const projectNumber = trimRequired(row.procore_project_number);
      if (!hubspotDealId || !projectNumber) return null;
      return {
        syncMappingId: row.id,
        hubspotDealId,
        projectNumber,
        bidboardProjectId: row.bidboard_project_id,
        createdAt: row.created_at,
      };
    })
    .filter((row): row is SyncMappingCandidate => row !== null);
}

async function findCrmDealMatches(
  crmClient: pg.Client,
  hubspotDealIds: string[]
): Promise<Map<string, CrmDealMatch[]>> {
  const matches = new Map<string, CrmDealMatch[]>();
  const uniqueIds = [...new Set(hubspotDealIds)].sort();
  for (const tenant of TENANT_SCHEMAS) {
    const result = await crmClient.query<{
      tenant_schema: TenantSchema;
      deal_id: string;
      hubspot_deal_id: string;
      bid_board_project_number: string | null;
    }>(
      `
        SELECT $1::text AS tenant_schema,
               id::text AS deal_id,
               hubspot_deal_id,
               bid_board_project_number
          FROM ${tenant}.deals
         WHERE hubspot_deal_id = ANY($2::text[])
      `,
      [tenant, uniqueIds]
    );

    for (const row of result.rows) {
      const existing = matches.get(row.hubspot_deal_id) ?? [];
      existing.push({
        tenantSchema: row.tenant_schema,
        dealId: row.deal_id,
        hubspotDealId: row.hubspot_deal_id,
        bidBoardProjectNumber: row.bid_board_project_number,
      });
      matches.set(row.hubspot_deal_id, existing);
    }
  }
  return matches;
}

async function ensureAuditTables(crmClient: pg.Client): Promise<void> {
  for (const tenant of TENANT_SCHEMAS) {
    await crmClient.query(`
      CREATE TABLE IF NOT EXISTS ${tenant}.${AUDIT_TABLE} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id UUID NOT NULL,
        source_sync_mapping_id INTEGER NOT NULL,
        tenant_schema TEXT NOT NULL,
        deal_id UUID NOT NULL,
        hubspot_deal_id TEXT NOT NULL,
        bid_board_project_number TEXT NOT NULL,
        written_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await crmClient.query(`
      CREATE INDEX IF NOT EXISTS ${AUDIT_TABLE}_run_id_idx
        ON ${tenant}.${AUDIT_TABLE} (run_id)
    `);
    await crmClient.query(`
      CREATE INDEX IF NOT EXISTS ${AUDIT_TABLE}_deal_id_idx
        ON ${tenant}.${AUDIT_TABLE} (deal_id)
    `);
  }
}

async function applyBootstrapPlan(crmClient: pg.Client, report: BootstrapReport): Promise<number> {
  let updated = 0;
  for (const row of report.planRows) {
    await crmClient.query("BEGIN");
    try {
      const updateResult = await crmClient.query(
        buildBootstrapUpdateSql(row.crmDeal.tenantSchema),
        [row.candidate.projectNumber, row.crmDeal.dealId, row.crmDeal.hubspotDealId]
      );

      if (updateResult.rowCount === 1) {
        await crmClient.query(
          buildBootstrapAuditInsertSql(row.crmDeal.tenantSchema),
          [
            report.runId,
            row.candidate.syncMappingId,
            row.crmDeal.tenantSchema,
            row.crmDeal.dealId,
            row.crmDeal.hubspotDealId,
            row.candidate.projectNumber,
          ]
        );
        updated++;
      }
      await crmClient.query("COMMIT");
    } catch (err) {
      await crmClient.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }
  return updated;
}

function printReport(report: BootstrapReport, appliedCount: number | null): void {
  console.log("=== Bid Board Project Number Bootstrap ===");
  console.log(`Run ID: ${report.runId}`);
  console.log(`Mode: ${report.dryRun ? "DRY RUN" : "LIVE WRITE"}`);
  console.log(`Candidate rows: ${report.candidateCount}`);
  console.log(`Sanity total: ${report.sanityTotal}`);
  console.log("");
  console.log("Categories:");
  console.log(`  Will update: ${report.willUpdateCount}`);
  console.log(`  Skipped ambiguous hubspot_deal_id: ${report.skippedAmbiguousHubspotDealIdCount}`);
  console.log(`  Skipped ambiguous project_number: ${report.skippedAmbiguousProjectNumberCount}`);
  console.log(`  Skipped already populated: ${report.skippedAlreadyPopulatedCount}`);
  console.log(`  Skipped no CRM deal: ${report.skippedNoCrmDealCount}`);
  console.log(`  Skipped multiple CRM deals: ${report.skippedMultipleCrmDealsCount}`);
  console.log(`  Handled temporal superseded rows: ${report.supersededTemporalDuplicateCount}`);
  if (appliedCount !== null) console.log(`  Rows updated: ${appliedCount}`);
  console.log("");
  console.log("Will-update by tenant:");
  console.table(report.tenantWillUpdate);
  console.log("");
  console.log("Ambiguous hubspot_deal_id values:");
  console.log(report.ambiguousHubspotDealIds.join(", ") || "(none)");
  console.log("");
  console.log("Ambiguous project_number values:");
  console.log(report.ambiguousProjectNumbers.join(", ") || "(none)");
  console.log("");
  console.log("No CRM deal for hubspot_deal_id sample:");
  console.log(report.noCrmDealHubspotIds.slice(0, 25).join(", ") || "(none)");
  if (report.noCrmDealHubspotIds.length > 25) {
    console.log(`... ${report.noCrmDealHubspotIds.length - 25} more`);
  }
  console.log("");
  console.log("Already-populated sample:");
  console.table(report.alreadyPopulated.slice(0, 10));
  console.log("");
  console.log("Temporal superseded sample:");
  console.table(report.supersededTemporalDuplicates.slice(0, 10));

  if (report.sanityTotal !== report.candidateCount) {
    throw new Error(
      `Sanity check failed: category total ${report.sanityTotal} != candidate count ${report.candidateCount}`
    );
  }
}

export async function main(): Promise<void> {
  const syncHubUrl = process.env.SYNCHUB_DATABASE_URL;
  const crmUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const dryRun = process.env.DRY_RUN !== "false";
  const runId = randomUUID();

  if (!syncHubUrl) {
    throw new Error("SYNCHUB_DATABASE_URL is required");
  }
  if (!crmUrl) {
    throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  }

  const syncHubClient = new pg.Client({ connectionString: syncHubUrl });
  const crmClient = new pg.Client({ connectionString: crmUrl });

  try {
    await syncHubClient.connect();
    await crmClient.connect();

    const candidates = await fetchSyncHubCandidates(syncHubClient);
    const classified = classifySyncMappingCandidates(candidates);
    const crmMatchesByHubspotDealId = await findCrmDealMatches(
      crmClient,
      classified.canonical.map((candidate) => candidate.hubspotDealId)
    );
    const report = buildBootstrapReport({
      runId,
      dryRun,
      candidateCount: candidates.length,
      classified,
      crmMatchesByHubspotDealId,
    });

    let appliedCount: number | null = null;
    if (!dryRun) {
      await ensureAuditTables(crmClient);
      appliedCount = await applyBootstrapPlan(crmClient, report);
    }

    printReport(report, appliedCount);
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
