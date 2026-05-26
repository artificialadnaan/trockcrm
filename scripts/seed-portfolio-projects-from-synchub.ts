import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  isPortfolioProjectBoardStage,
  normalizePortfolioProjectStage,
} from "../shared/src/types/portfolio-project-stages.js";
import {
  getProcoreCompanyOfficeMappings,
} from "../server/src/modules/synchub/procore-project-stage-relay-service.js";

type Mode = "dry-run" | "commit";

type QueryClient = Pick<Client, "query">;

type Args = {
  mode: Mode;
  limit: number | null;
};

type OfficeRow = {
  id: string;
  slug: string;
};

type ProcoreCompanyOfficeMapping = {
  procoreCompanyId: string;
  officeSchema: string;
};

export type SyncHubProcoreProjectRow = {
  procore_id: string;
  project_number: string | null;
  name: string | null;
  display_name: string | null;
  stage: string | null;
  project_stage_name: string | null;
  active: boolean | null;
  company_id: string | null;
  company_name: string | null;
  estimated_value: string | null;
  total_value: string | null;
  last_synced_at: Date | string | null;
  procore_updated_at: Date | string | null;
  updated_at: Date | string | null;
  properties: Record<string, unknown> | null;
};

export type PortfolioSeedCandidate = {
  procoreCompanyId: string;
  procoreProjectId: string;
  projectNumber: string | null;
  name: string;
  currentStage: string;
  currentStageNormalized: string;
  source: SyncHubProcoreProjectRow;
};

type SkippedSourceRow = {
  procoreProjectId: string | null;
  projectNumber: string | null;
  name: string | null;
  stage: string | null;
  normalizedStage: string;
  reason: string;
};

type ExistingRow = {
  procoreProjectId: string;
  projectNumber: string | null;
  name: string;
  currentStage: string;
  currentStageEnteredAt: string | null;
  schemaName: string;
};

type InsertedRow = {
  procoreProjectId: string;
  projectNumber: string | null;
  name: string;
  currentStageNormalized: string;
  schemaName: string;
};

export type PortfolioSeedResult = {
  mode: Mode;
  seedTime: string;
  source: {
    activeRowsRead: number;
    boardRelevantCandidates: number;
    excludedRows: number;
  };
  crm: {
    existingSkipped: number;
    wouldInsert: number;
    inserted: number;
    missingOfficeSkipped: number;
    insertConflictsSkipped: number;
  };
  byStage: Record<string, number>;
  byOffice: Record<string, { existingSkipped: number; wouldInsert: number; inserted: number }>;
  samples: {
    candidates: InsertedRow[];
    existingSkipped: ExistingRow[];
    excluded: SkippedSourceRow[];
  };
};

const USAGE = `Usage:
  node --import tsx scripts/seed-portfolio-projects-from-synchub.ts --dry-run [--limit=1000]
  node --import tsx scripts/seed-portfolio-projects-from-synchub.ts --commit [--limit=1000]

Exactly one mode flag is required.

Connection strings:
  CRM: CRM_DATABASE_URL, or DATABASE_PUBLIC_URL from the CRM .env.
  SyncHub: SYNCHUB_DATABASE_PUBLIC_URL / SYNCHUB_DATABASE_URL, or Railway-injected
           DATABASE_PUBLIC_URL / DATABASE_URL when RAILWAY_PROJECT_NAME is T-Rock-Sync-Hub.`;

function parseArgs(argv: string[]): Args {
  const hasDryRun = argv.includes("--dry-run");
  const hasCommit = argv.includes("--commit");
  if ([hasDryRun, hasCommit].filter(Boolean).length !== 1) {
    throw new Error(`Specify exactly one of --dry-run or --commit.\n${USAGE}`);
  }

  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : null;
  if (limit != null && (!Number.isInteger(limit) || limit <= 0 || limit > 10_000)) {
    throw new Error("--limit must be an integer between 1 and 10000");
  }

  return {
    mode: hasCommit ? "commit" : "dry-run",
    limit,
  };
}

function findCrmEnvPath() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../..", ".env"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function readCrmEnvFile() {
  const envPath = findCrmEnvPath();
  if (!envPath) return {};
  return dotenv.parse(fs.readFileSync(envPath));
}

function resolveConnectionStrings(crmEnv: Record<string, string>) {
  const crmDatabaseUrl =
    process.env.CRM_DATABASE_URL?.trim()
    || crmEnv.DATABASE_PUBLIC_URL?.trim()
    || crmEnv.CRM_DATABASE_URL?.trim()
    || "";

  const runningInSyncHubRailway =
    process.env.RAILWAY_PROJECT_NAME === "T-Rock-Sync-Hub"
    || process.env.RAILWAY_SERVICE_NAME === "trocksynchubv3"
    || process.env.RAILWAY_SERVICE_NAME === "Postgres";

  const syncHubDatabaseUrl =
    process.env.SYNCHUB_DATABASE_PUBLIC_URL?.trim()
    || process.env.SYNCHUB_DATABASE_URL?.trim()
    || process.env.SYNCHUB_DATABASE_URI?.trim()
    || (runningInSyncHubRailway
      ? process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim() || ""
      : "");

  if (!crmDatabaseUrl) {
    throw new Error("Missing CRM database URL. Set CRM_DATABASE_URL or ensure CRM .env has DATABASE_PUBLIC_URL.");
  }
  if (!syncHubDatabaseUrl) {
    throw new Error(
      "Missing SyncHub database URL. Set SYNCHUB_DATABASE_PUBLIC_URL/SYNCHUB_DATABASE_URL, "
      + "or run this script under Railway against the T-Rock-Sync-Hub Postgres service."
    );
  }
  if (crmDatabaseUrl === syncHubDatabaseUrl) {
    throw new Error("CRM and SyncHub database URLs resolved to the same value; refusing to run.");
  }

  return { crmDatabaseUrl, syncHubDatabaseUrl };
}

function quoteIdent(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

function schemaNameForOfficeSlug(slug: string) {
  return `office_${slug}`;
}

function getNestedString(value: unknown, pathParts: string[]): string | null {
  let current = value;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  if (current == null) return null;
  const text = String(current).trim();
  return text || null;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

export function toPortfolioSeedCandidate(row: SyncHubProcoreProjectRow): PortfolioSeedCandidate | SkippedSourceRow {
  const rawStage = firstString(row.project_stage_name, row.stage);
  const normalizedStage = normalizePortfolioProjectStage(rawStage);
  const baseSkipped = {
    procoreProjectId: firstString(row.procore_id),
    projectNumber: firstString(row.project_number),
    name: firstString(row.name, row.display_name),
    stage: rawStage,
    normalizedStage,
  };

  if (row.active !== true) {
    return { ...baseSkipped, reason: "inactive" };
  }
  if (!rawStage || !isPortfolioProjectBoardStage(rawStage)) {
    return { ...baseSkipped, reason: "non_board_relevant_stage" };
  }

  const procoreProjectId = firstString(row.procore_id);
  if (!procoreProjectId) {
    return { ...baseSkipped, reason: "missing_procore_project_id" };
  }

  const procoreCompanyId = firstString(
    row.company_id,
    getNestedString(row.properties, ["company", "id"])
  );
  if (!procoreCompanyId) {
    return { ...baseSkipped, reason: "missing_procore_company_id" };
  }

  const name = firstString(row.name, row.display_name, row.project_number, procoreProjectId);
  if (!name) {
    return { ...baseSkipped, reason: "missing_project_name" };
  }

  return {
    procoreCompanyId,
    procoreProjectId,
    projectNumber: firstString(row.project_number),
    name,
    currentStage: rawStage,
    currentStageNormalized: normalizedStage,
    source: row,
  };
}

export function splitSeedCandidates(rows: SyncHubProcoreProjectRow[]) {
  const candidates: PortfolioSeedCandidate[] = [];
  const excluded: SkippedSourceRow[] = [];
  for (const row of rows) {
    const result = toPortfolioSeedCandidate(row);
    if ("reason" in result) excluded.push(result);
    else candidates.push(result);
  }
  return { candidates, excluded };
}

function resolveOfficeSchema(input: {
  procoreCompanyId: string;
  offices: OfficeRow[];
  mappings: ProcoreCompanyOfficeMapping[];
}) {
  const schemas = [
    ...new Set(
      input.mappings
        .filter((mapping) => mapping.procoreCompanyId === input.procoreCompanyId)
        .map((mapping) => mapping.officeSchema)
    ),
  ];
  if (schemas.length !== 1) return null;

  const schemaName = schemas[0];
  const slug = schemaName.startsWith("office_") ? schemaName.slice("office_".length) : schemaName;
  const office = input.offices.find((row) => row.slug === slug);
  return office ? { schemaName, office } : null;
}

async function fetchSyncHubActiveProjects(client: QueryClient, limit: number | null): Promise<SyncHubProcoreProjectRow[]> {
  const limitSql = limit == null ? "" : " LIMIT $1";
  const result = await client.query(
    `SELECT procore_id, project_number, name, display_name, stage, project_stage_name,
            active, company_id, company_name, estimated_value, total_value,
            last_synced_at, procore_updated_at, updated_at, properties
       FROM public.procore_projects
      WHERE active = true
      ORDER BY procore_id ASC${limitSql}`,
    limit == null ? [] : [limit]
  );
  return result.rows as SyncHubProcoreProjectRow[];
}

async function fetchActiveOffices(client: QueryClient): Promise<OfficeRow[]> {
  const result = await client.query(
    "SELECT id, slug FROM public.offices WHERE is_active = true ORDER BY created_at ASC"
  );
  return result.rows as OfficeRow[];
}

async function findExistingPortfolioProject(input: {
  client: QueryClient;
  schemaName: string;
  candidate: PortfolioSeedCandidate;
}): Promise<ExistingRow | null> {
  const tableName = `${quoteIdent(input.schemaName)}.portfolio_projects`;
  const result = await input.client.query(
    `SELECT procore_project_id, project_number, name, current_stage, current_stage_entered_at
       FROM ${tableName}
      WHERE procore_company_id = $1
        AND procore_project_id = $2
      LIMIT 1`,
    [input.candidate.procoreCompanyId, input.candidate.procoreProjectId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    procoreProjectId: row.procore_project_id,
    projectNumber: row.project_number ?? null,
    name: row.name,
    currentStage: row.current_stage,
    currentStageEnteredAt: row.current_stage_entered_at
      ? new Date(row.current_stage_entered_at).toISOString()
      : null,
    schemaName: input.schemaName,
  };
}

function rawSnapshot(candidate: PortfolioSeedCandidate, seedTime: Date) {
  return {
    source: "synchub_procore_projects_seed",
    seededAt: seedTime.toISOString(),
    synchub: {
      procoreId: candidate.procoreProjectId,
      projectNumber: candidate.projectNumber,
      name: candidate.name,
      stage: candidate.source.stage,
      projectStageName: candidate.source.project_stage_name,
      active: candidate.source.active,
      companyId: candidate.procoreCompanyId,
      companyName: candidate.source.company_name,
      estimatedValue: candidate.source.estimated_value,
      totalValue: candidate.source.total_value,
      lastSyncedAt: candidate.source.last_synced_at,
      procoreUpdatedAt: candidate.source.procore_updated_at,
      updatedAt: candidate.source.updated_at,
    },
    rawProperties: candidate.source.properties ?? {},
  };
}

async function insertPortfolioProject(input: {
  client: QueryClient;
  schemaName: string;
  candidate: PortfolioSeedCandidate;
  seedTime: Date;
}) {
  const tableName = `${quoteIdent(input.schemaName)}.portfolio_projects`;
  const eventKey = [
    "portfolio-seed",
    input.candidate.procoreCompanyId,
    input.candidate.procoreProjectId,
    input.candidate.currentStageNormalized,
  ].join(":");

  const result = await input.client.query(
    `INSERT INTO ${tableName}
       (procore_company_id, procore_project_id, project_number, name,
        current_stage, current_stage_normalized, current_stage_entered_at,
        is_board_relevant, first_seen_at, last_stage_event_key, raw_snapshot,
        created_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7::timestamptz, true,
        $7::timestamptz, $8, $9::jsonb, $7::timestamptz, $7::timestamptz)
     ON CONFLICT (procore_company_id, procore_project_id) DO NOTHING
     RETURNING id`,
    [
      input.candidate.procoreCompanyId,
      input.candidate.procoreProjectId,
      input.candidate.projectNumber,
      input.candidate.name,
      input.candidate.currentStage,
      input.candidate.currentStageNormalized,
      input.seedTime.toISOString(),
      eventKey,
      JSON.stringify(rawSnapshot(input.candidate, input.seedTime)),
    ]
  );
  return result.rows[0]?.id ?? null;
}

function incrementStage(result: PortfolioSeedResult, stage: string) {
  result.byStage[stage] = (result.byStage[stage] ?? 0) + 1;
}

function ensureOfficeBucket(result: PortfolioSeedResult, schemaName: string) {
  result.byOffice[schemaName] ??= { existingSkipped: 0, wouldInsert: 0, inserted: 0 };
  return result.byOffice[schemaName];
}

function samplePush<T>(items: T[], item: T, limit = 20) {
  if (items.length < limit) items.push(item);
}

export async function runPortfolioProjectsSeed(input: {
  mode: Mode;
  crmClient: QueryClient;
  syncHubClient: QueryClient;
  seedTime?: Date;
  limit?: number | null;
  mappings?: ProcoreCompanyOfficeMapping[];
}): Promise<PortfolioSeedResult> {
  const seedTime = input.seedTime ?? new Date();
  const sourceRows = await fetchSyncHubActiveProjects(input.syncHubClient, input.limit ?? null);
  const { candidates, excluded } = splitSeedCandidates(sourceRows);
  const offices = await fetchActiveOffices(input.crmClient);
  const mappings = input.mappings ?? getProcoreCompanyOfficeMappings();

  const result: PortfolioSeedResult = {
    mode: input.mode,
    seedTime: seedTime.toISOString(),
    source: {
      activeRowsRead: sourceRows.length,
      boardRelevantCandidates: candidates.length,
      excludedRows: excluded.length,
    },
    crm: {
      existingSkipped: 0,
      wouldInsert: 0,
      inserted: 0,
      missingOfficeSkipped: 0,
      insertConflictsSkipped: 0,
    },
    byStage: {},
    byOffice: {},
    samples: {
      candidates: [],
      existingSkipped: [],
      excluded: excluded.slice(0, 20),
    },
  };

  if (input.mode === "commit") {
    await input.crmClient.query("BEGIN");
  }

  try {
    for (const candidate of candidates) {
      incrementStage(result, candidate.currentStageNormalized);
      const officeResolution = resolveOfficeSchema({
        procoreCompanyId: candidate.procoreCompanyId,
        offices,
        mappings,
      });
      if (!officeResolution) {
        result.crm.missingOfficeSkipped += 1;
        continue;
      }

      const officeBucket = ensureOfficeBucket(result, officeResolution.schemaName);
      const existing = await findExistingPortfolioProject({
        client: input.crmClient,
        schemaName: officeResolution.schemaName,
        candidate,
      });
      if (existing) {
        result.crm.existingSkipped += 1;
        officeBucket.existingSkipped += 1;
        samplePush(result.samples.existingSkipped, existing);
        continue;
      }

      const insertSample = {
        procoreProjectId: candidate.procoreProjectId,
        projectNumber: candidate.projectNumber,
        name: candidate.name,
        currentStageNormalized: candidate.currentStageNormalized,
        schemaName: officeResolution.schemaName,
      };

      if (input.mode === "dry-run") {
        result.crm.wouldInsert += 1;
        officeBucket.wouldInsert += 1;
        samplePush(result.samples.candidates, insertSample);
        continue;
      }

      const insertedId = await insertPortfolioProject({
        client: input.crmClient,
        schemaName: officeResolution.schemaName,
        candidate,
        seedTime,
      });
      if (insertedId) {
        result.crm.inserted += 1;
        officeBucket.inserted += 1;
        samplePush(result.samples.candidates, insertSample);
      } else {
        result.crm.insertConflictsSkipped += 1;
      }
    }

    if (input.mode === "commit") {
      await input.crmClient.query("COMMIT");
    }
  } catch (error) {
    if (input.mode === "commit") {
      await input.crmClient.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  }

  return result;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const crmEnv = readCrmEnvFile();
  const { crmDatabaseUrl, syncHubDatabaseUrl } = resolveConnectionStrings(crmEnv);

  const crmClient = new Client({
    connectionString: crmDatabaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  const syncHubClient = new Client({
    connectionString: syncHubDatabaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await syncHubClient.connect();
  await crmClient.connect();
  try {
    const result = await runPortfolioProjectsSeed({
      mode: args.mode,
      limit: args.limit,
      crmClient,
      syncHubClient,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await crmClient.end();
    await syncHubClient.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
