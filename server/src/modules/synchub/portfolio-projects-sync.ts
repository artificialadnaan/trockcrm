import type { Client } from "pg";
import {
  isPortfolioProjectBoardStage,
  normalizePortfolioProjectStage,
} from "@trock-crm/shared/types";
import { getProcoreCompanyOfficeMappings } from "./procore-project-stage-relay-service.js";

/**
 * Portfolio Projects sync core (SyncHub → CRM).
 * ============================================
 *
 * Reads SyncHub's `public.procore_projects` (estimated/total value + last_synced_at) and
 * writes the CRM's per-office `office_*.portfolio_projects` rows. Two operations:
 *   - SEED   (`runPortfolioProjectsSeed`)            — insert board-relevant projects;
 *   - REFRESH (`runPortfolioProjectValueRefresh`)    — update total_value / value_synced_at.
 *
 * This module is the single source of truth for that logic. It is imported by BOTH:
 *   - the manual CLI `scripts/seed-portfolio-projects-from-synchub.ts` (re-exports it), and
 *   - the worker cron `worker/src/jobs/portfolio-value-refresh.ts` (dynamic-imports the
 *     compiled `server/dist/...`), which runs the refresh every 4 hours.
 *
 * `value_synced_at` is stamped from SyncHub's `last_synced_at` (falling back to
 * `updated_at`) — i.e. true data freshness from Procore, NEVER the run time. The board's
 * 7-day staleness flag therefore reflects when the value was actually current.
 *
 * @module modules/synchub/portfolio-projects-sync
 */

export type Mode = "dry-run" | "commit";

type QueryClient = Pick<Client, "query">;

type OfficeRow = {
  id: string;
  slug: string;
};

export type ProcoreCompanyOfficeMapping = {
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

type ExistingValueRow = ExistingRow & {
  totalValue: string | null;
  valueSyncedAt: string | null;
};

type InsertedRow = {
  procoreProjectId: string;
  projectNumber: string | null;
  name: string;
  currentStageNormalized: string;
  schemaName: string;
};

export type SyncHubValueFreshnessSummary = {
  totalRows: number;
  withTotalValue: number;
  withEstimatedValue: number;
  minLastSyncedAt: string | null;
  maxLastSyncedAt: string | null;
  within1Day: number;
  within7Days: number;
  within30Days: number;
  olderThan30Days: number;
  nullLastSyncedAt: number;
};

export type PortfolioSeedResult = {
  mode: Mode;
  seedTime: string;
  source: {
    activeRowsRead: number;
    boardRelevantCandidates: number;
    excludedRows: number;
    freshness: {
      activeRows: SyncHubValueFreshnessSummary;
      boardRelevantRows: SyncHubValueFreshnessSummary;
    };
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

export type PortfolioProjectValueRefreshResult = {
  mode: Mode;
  refreshedAt: string;
  source: {
    activeRowsRead: number;
    boardRelevantCandidates: number;
    excludedRows: number;
    freshness: {
      activeRows: SyncHubValueFreshnessSummary;
      boardRelevantRows: SyncHubValueFreshnessSummary;
    };
  };
  crm: {
    matched: number;
    alreadyCurrent: number;
    wouldUpdate: number;
    updated: number;
    missingOfficeSkipped: number;
    missingPortfolioProjectSkipped: number;
  };
  byOffice: Record<string, { matched: number; alreadyCurrent: number; wouldUpdate: number; updated: number }>;
  samples: {
    updates: Array<{
      procoreProjectId: string;
      projectNumber: string | null;
      name: string;
      schemaName: string;
      previousTotalValue: string | null;
      nextTotalValue: string | null;
      previousValueSyncedAt: string | null;
      nextValueSyncedAt: string | null;
    }>;
    missingPortfolioProjects: InsertedRow[];
    excluded: SkippedSourceRow[];
  };
};

function quoteIdent(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
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

export async function fetchSyncHubActiveProjects(client: QueryClient, limit: number | null): Promise<SyncHubProcoreProjectRow[]> {
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

async function findExistingPortfolioProjectValue(input: {
  client: QueryClient;
  schemaName: string;
  candidate: PortfolioSeedCandidate;
  valueColumnsReady: boolean;
}): Promise<ExistingValueRow | null> {
  const tableName = `${quoteIdent(input.schemaName)}.portfolio_projects`;
  const result = await input.client.query(
    `SELECT procore_project_id, project_number, name, current_stage, current_stage_entered_at
            ${input.valueColumnsReady ? ", total_value, value_synced_at" : ""}
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
    totalValue: input.valueColumnsReady ? normalizeMoney(row.total_value) : null,
    valueSyncedAt: input.valueColumnsReady && row.value_synced_at ? new Date(row.value_synced_at).toISOString() : null,
  };
}

async function portfolioProjectValueColumnsReady(client: QueryClient, schemaName: string) {
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'portfolio_projects'
        AND column_name IN ('total_value', 'value_synced_at')`,
    [schemaName]
  );
  const columns = new Set(result.rows.map((row: any) => row.column_name));
  return columns.has("total_value") && columns.has("value_synced_at");
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

function normalizeMoney(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return parsed.toFixed(2);
}

function normalizeTimestamp(value: unknown): string | null {
  if (value == null) return null;
  const parsed = new Date(value as string | Date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function candidateValueSyncedAt(candidate: PortfolioSeedCandidate): string | null {
  return normalizeTimestamp(candidate.source.last_synced_at ?? candidate.source.updated_at);
}

function candidateTotalValue(candidate: PortfolioSeedCandidate): string | null {
  return normalizeMoney(candidate.source.total_value);
}

function valueNeedsRefresh(existing: ExistingValueRow, candidate: PortfolioSeedCandidate) {
  return existing.totalValue !== candidateTotalValue(candidate)
    || existing.valueSyncedAt !== candidateValueSyncedAt(candidate);
}

export function summarizeSyncHubValueFreshness(
  rows: SyncHubProcoreProjectRow[],
  now = new Date()
): SyncHubValueFreshnessSummary {
  const timestamps = rows
    .map((row) => normalizeTimestamp(row.last_synced_at))
    .filter((value): value is string => Boolean(value));
  const sortedTimestamps = [...timestamps].sort();
  const nowMs = now.getTime();
  const within = (days: number) => timestamps.filter((value) => {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) && nowMs - timestamp <= days * 24 * 60 * 60 * 1000;
  }).length;

  return {
    totalRows: rows.length,
    withTotalValue: rows.filter((row) => normalizeMoney(row.total_value) != null).length,
    withEstimatedValue: rows.filter((row) => normalizeMoney(row.estimated_value) != null).length,
    minLastSyncedAt: sortedTimestamps[0] ?? null,
    maxLastSyncedAt: sortedTimestamps.at(-1) ?? null,
    within1Day: within(1),
    within7Days: within(7),
    within30Days: within(30),
    olderThan30Days: timestamps.length - within(30),
    nullLastSyncedAt: rows.length - timestamps.length,
  };
}

function sourceFreshness(sourceRows: SyncHubProcoreProjectRow[], candidates: PortfolioSeedCandidate[]) {
  return {
    activeRows: summarizeSyncHubValueFreshness(sourceRows),
    boardRelevantRows: summarizeSyncHubValueFreshness(candidates.map((candidate) => candidate.source)),
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
        is_board_relevant, total_value, value_synced_at, first_seen_at, last_stage_event_key, raw_snapshot,
        created_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7::timestamptz, true, $8::numeric, $9::timestamptz,
        $7::timestamptz, $10, $11::jsonb, $7::timestamptz, $7::timestamptz)
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
      candidateTotalValue(input.candidate),
      candidateValueSyncedAt(input.candidate),
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
      freshness: sourceFreshness(sourceRows, candidates),
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

function ensureRefreshOfficeBucket(result: PortfolioProjectValueRefreshResult, schemaName: string) {
  result.byOffice[schemaName] ??= { matched: 0, alreadyCurrent: 0, wouldUpdate: 0, updated: 0 };
  return result.byOffice[schemaName];
}

async function updatePortfolioProjectValue(input: {
  client: QueryClient;
  schemaName: string;
  candidate: PortfolioSeedCandidate;
}) {
  const tableName = `${quoteIdent(input.schemaName)}.portfolio_projects`;
  const result = await input.client.query(
    `UPDATE ${tableName}
        SET total_value = $3::numeric,
            value_synced_at = $4::timestamptz,
            updated_at = NOW()
      WHERE procore_company_id = $1
        AND procore_project_id = $2
        AND (
          total_value IS DISTINCT FROM $3::numeric
          OR value_synced_at IS DISTINCT FROM $4::timestamptz
        )
      RETURNING id`,
    [
      input.candidate.procoreCompanyId,
      input.candidate.procoreProjectId,
      candidateTotalValue(input.candidate),
      candidateValueSyncedAt(input.candidate),
    ]
  );
  return result.rows.length;
}

export async function runPortfolioProjectValueRefresh(input: {
  mode: Mode;
  crmClient: QueryClient;
  syncHubClient: QueryClient;
  refreshedAt?: Date;
  limit?: number | null;
  mappings?: ProcoreCompanyOfficeMapping[];
}): Promise<PortfolioProjectValueRefreshResult> {
  const refreshedAt = input.refreshedAt ?? new Date();
  const sourceRows = await fetchSyncHubActiveProjects(input.syncHubClient, input.limit ?? null);
  const { candidates, excluded } = splitSeedCandidates(sourceRows);
  const offices = await fetchActiveOffices(input.crmClient);
  const mappings = input.mappings ?? getProcoreCompanyOfficeMappings();
  const valueColumnsReadyBySchema = new Map<string, boolean>();

  const result: PortfolioProjectValueRefreshResult = {
    mode: input.mode,
    refreshedAt: refreshedAt.toISOString(),
    source: {
      activeRowsRead: sourceRows.length,
      boardRelevantCandidates: candidates.length,
      excludedRows: excluded.length,
      freshness: sourceFreshness(sourceRows, candidates),
    },
    crm: {
      matched: 0,
      alreadyCurrent: 0,
      wouldUpdate: 0,
      updated: 0,
      missingOfficeSkipped: 0,
      missingPortfolioProjectSkipped: 0,
    },
    byOffice: {},
    samples: {
      updates: [],
      missingPortfolioProjects: [],
      excluded: excluded.slice(0, 20),
    },
  };

  if (input.mode === "commit") {
    await input.crmClient.query("BEGIN");
  }

  try {
    for (const candidate of candidates) {
      const officeResolution = resolveOfficeSchema({
        procoreCompanyId: candidate.procoreCompanyId,
        offices,
        mappings,
      });
      if (!officeResolution) {
        result.crm.missingOfficeSkipped += 1;
        continue;
      }

      const officeBucket = ensureRefreshOfficeBucket(result, officeResolution.schemaName);
      let valueColumnsReady = valueColumnsReadyBySchema.get(officeResolution.schemaName);
      if (valueColumnsReady == null) {
        valueColumnsReady = await portfolioProjectValueColumnsReady(input.crmClient, officeResolution.schemaName);
        valueColumnsReadyBySchema.set(officeResolution.schemaName, valueColumnsReady);
      }
      if (input.mode === "commit" && !valueColumnsReady) {
        throw new Error(
          `Missing total_value/value_synced_at on ${officeResolution.schemaName}.portfolio_projects; run migration 0136 before commit.`
        );
      }
      const existing = await findExistingPortfolioProjectValue({
        client: input.crmClient,
        schemaName: officeResolution.schemaName,
        candidate,
        valueColumnsReady,
      });
      if (!existing) {
        result.crm.missingPortfolioProjectSkipped += 1;
        samplePush(result.samples.missingPortfolioProjects, {
          procoreProjectId: candidate.procoreProjectId,
          projectNumber: candidate.projectNumber,
          name: candidate.name,
          currentStageNormalized: candidate.currentStageNormalized,
          schemaName: officeResolution.schemaName,
        });
        continue;
      }

      result.crm.matched += 1;
      officeBucket.matched += 1;

      if (!valueNeedsRefresh(existing, candidate)) {
        result.crm.alreadyCurrent += 1;
        officeBucket.alreadyCurrent += 1;
        continue;
      }

      const updateSample = {
        procoreProjectId: candidate.procoreProjectId,
        projectNumber: candidate.projectNumber,
        name: candidate.name,
        schemaName: officeResolution.schemaName,
        previousTotalValue: existing.totalValue,
        nextTotalValue: candidateTotalValue(candidate),
        previousValueSyncedAt: existing.valueSyncedAt,
        nextValueSyncedAt: candidateValueSyncedAt(candidate),
      };

      if (input.mode === "dry-run") {
        result.crm.wouldUpdate += 1;
        officeBucket.wouldUpdate += 1;
        samplePush(result.samples.updates, updateSample);
        continue;
      }

      const updated = await updatePortfolioProjectValue({
        client: input.crmClient,
        schemaName: officeResolution.schemaName,
        candidate,
      });
      result.crm.updated += updated;
      officeBucket.updated += updated;
      if (updated > 0) {
        samplePush(result.samples.updates, updateSample);
      } else {
        result.crm.alreadyCurrent += 1;
        officeBucket.alreadyCurrent += 1;
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

/**
 * Resolve the SyncHub Postgres connection string from the environment, in priority order:
 *   SYNCHUB_DATABASE_PUBLIC_URL → SYNCHUB_DATABASE_URL → SYNCHUB_DATABASE_URI →
 *   (only when this process is running INSIDE the SyncHub Railway project)
 *   DATABASE_PUBLIC_URL → DATABASE_URL.
 *
 * Returns "" when no SyncHub URL is configured. The CRM worker runs in the CRM Railway
 * project, so it must have SYNCHUB_DATABASE_PUBLIC_URL or SYNCHUB_DATABASE_URL set for
 * the cross-DB value refresh to run.
 */
export function resolveSyncHubDatabaseUrl(): string {
  const runningInSyncHubRailway =
    process.env.RAILWAY_PROJECT_NAME === "T-Rock-Sync-Hub"
    || process.env.RAILWAY_SERVICE_NAME === "trocksynchubv3"
    || process.env.RAILWAY_SERVICE_NAME === "Postgres";

  return (
    process.env.SYNCHUB_DATABASE_PUBLIC_URL?.trim()
    || process.env.SYNCHUB_DATABASE_URL?.trim()
    || process.env.SYNCHUB_DATABASE_URI?.trim()
    || (runningInSyncHubRailway
      ? process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim() || ""
      : "")
  );
}

/**
 * True when the resolved SyncHub URL is the same connection string as the CRM URL — a
 * misconfiguration we refuse to run on. The CLI guards this directly (it holds both
 * connection strings); the worker can't, because its CRM side is a pre-built pool, so it
 * compares the SyncHub URL against the worker's DATABASE_URL via this helper. Defends
 * against accidentally pointing the cross-DB read at the CRM database itself.
 */
export function syncHubUrlMatchesCrm(
  syncHubUrl: string | null | undefined,
  crmUrl: string | null | undefined
): boolean {
  const syncHub = syncHubUrl?.trim();
  const crm = crmUrl?.trim();
  return Boolean(syncHub) && Boolean(crm) && syncHub === crm;
}

export type GuardedRefreshOutcome =
  | { ok: true; result: PortfolioProjectValueRefreshResult }
  | { ok: false; error: unknown };

/**
 * Run a portfolio value refresh without ever throwing. A failure (e.g. the SyncHub DB is
 * temporarily unreachable) is logged and swallowed so the worker keeps running and simply
 * retries on the next scheduled interval. Used by the worker cron.
 */
export async function runPortfolioValueRefreshGuarded(deps: {
  execute: () => Promise<PortfolioProjectValueRefreshResult>;
  log?: (message: string) => void;
  logError?: (message: string, error: unknown) => void;
}): Promise<GuardedRefreshOutcome> {
  try {
    const result = await deps.execute();
    const { matched, updated, alreadyCurrent, missingPortfolioProjectSkipped, missingOfficeSkipped } = result.crm;
    deps.log?.(
      `matched=${matched} updated=${updated} alreadyCurrent=${alreadyCurrent} `
      + `missingPortfolioProjectSkipped=${missingPortfolioProjectSkipped} missingOfficeSkipped=${missingOfficeSkipped}`
    );
    return { ok: true, result };
  } catch (error) {
    deps.logError?.("portfolio value refresh failed (will retry next interval)", error);
    return { ok: false, error };
  }
}
