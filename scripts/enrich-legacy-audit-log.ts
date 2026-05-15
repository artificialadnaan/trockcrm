import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const DEFAULT_BATCH_SIZE = 500;
const PROGRESS_LOG_INTERVAL = 5_000;
export const DEFAULT_CUTOFF_AT = "2026-05-15T00:00:00.000Z";
const REPORT_PATH = ".reviews/legacy-audit-enrichment/report.md";

const LOOKUPABLE_TABLES = new Set(["deals", "leads", "properties", "companies", "users"] as const);

export type LookupableTableName = "deals" | "leads" | "properties" | "companies" | "users";
export type SkipReason =
  | "already_enriched"
  | "not_legacy"
  | "office_metadata"
  | "unknown_table"
  | "invalid_record_id"
  | "no_changes";
export type EntityResolution = "found" | "deleted_fallback" | "skipped";
export type ActorResolution = "found" | "missing_actor" | "not_applicable";

export interface LegacyAuditRow {
  id: number;
  tableName: string;
  recordId: string;
  action: string;
  changedBy: string | null;
  actorName: string | null;
  actorSystemProcess: string | null;
  entityNameSnapshot: string | null;
  fieldChangesJsonb: unknown;
  enrichAttemptedAt?: string | null;
  createdAt: string;
}

export interface LegacyAuditEntityRecord {
  tableName: LookupableTableName;
  id: string;
  name?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  displayName?: string | null;
  projectNumber?: string | null;
}

export interface LegacyAuditLookupContext {
  entity: LegacyAuditEntityRecord | null;
  actorName: string | null;
}

export interface LegacyAuditEnrichmentPlan {
  row: LegacyAuditRow;
  update: boolean;
  entityNameSnapshot: string | null;
  actorName: string | null;
  entityResolution: EntityResolution;
  actorResolution: ActorResolution;
  skipReason: SkipReason | null;
}

export interface TableBreakdown {
  total: number;
  rowsToUpdate: number;
  entitySnapshotsSet: number;
  actorNamesSet: number;
  actorRecoverable: number;
  actorUnrecoverable: number;
  deletedFallbacks: number;
  skipped: number;
}

export interface BatchSummary {
  totalRows: number;
  rowsToUpdate: number;
  entitySnapshotsSet: number;
  actorNamesSet: number;
  actorRecoverable: number;
  actorUnrecoverable: number;
  deletedFallbacks: number;
  byTable: Record<string, TableBreakdown>;
  skipped: Record<string, number>;
  samples: string[];
}

export interface EnrichLegacyAuditLogOptions {
  officeName: string;
  batchSize?: number;
  dryRun?: boolean;
  limit?: number | null;
}

export interface EnrichmentTenantResult extends BatchSummary {
  tenant: string;
  examinedRows: number;
  totalCandidateRows: number;
  estimatedExecuteMs: number;
  elapsedMs: number;
}

export interface EnrichmentRunResult {
  tenants: EnrichmentTenantResult[];
  totalExaminedRows: number;
  totalRowsUpdated: number;
  elapsedMs: number;
}

export interface ParsedEnrichmentArgs {
  offices: string[];
  dryRun: boolean;
  batchSize: number;
  limit: number | null;
}

export interface Queryable {
  query: (queryTextOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]) => Promise<{
    rows: any[];
    rowCount?: number;
  }>;
}

function connectionString(): string {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  return selected;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

export function buildStatementName(schemaName: string, base: string): string {
  const hash = crypto.createHash("sha256").update(schemaName).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

function validateOfficeSchema(schemaName: string): string {
  if (!/^office_[a-z0-9_]+$/.test(schemaName)) throw new Error(`Invalid office schema: ${schemaName}`);
  return schemaName;
}

function normalizeText(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function shortenUuid(value: string): string {
  return value.slice(0, 8);
}

function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isLookupableTableName(value: string): value is LookupableTableName {
  return LOOKUPABLE_TABLES.has(value as LookupableTableName);
}

function deletedEntityLabel(tableName: LookupableTableName, recordId: string): string {
  const shortId = shortenUuid(recordId);
  switch (tableName) {
    case "deals":
      return `[Deleted Deal ${shortId}]`;
    case "leads":
      return `[Deleted Lead ${shortId}]`;
    case "properties":
      return `[Deleted Property ${shortId}]`;
    case "companies":
      return `[Deleted Company ${shortId}]`;
    case "users":
      return `[Deleted User ${shortId}]`;
  }
}

export function buildEntityNameSnapshot(entity: LegacyAuditEntityRecord): string | null {
  if (entity.tableName === "deals") {
    const name = normalizeText(entity.name);
    const projectNumber = normalizeText(entity.projectNumber);
    if (!name) return projectNumber;
    return projectNumber ? `${name} (${projectNumber})` : name;
  }

  if (entity.tableName === "properties") {
    const address = normalizeText(entity.address);
    if (address) return address;
    const city = normalizeText(entity.city);
    const state = normalizeText(entity.state);
    if (city && state) return `${city}, ${state}`;
    if (city) return city;
    if (state) return state;
    return normalizeText(entity.name) ?? "Unknown Property";
  }

  if (entity.tableName === "users") {
    return normalizeText(entity.displayName);
  }

  return normalizeText(entity.name);
}

export function isLegacyAuditRowCandidate(row: LegacyAuditRow): boolean {
  if (row.enrichAttemptedAt != null) return false;
  return row.entityNameSnapshot == null
    && row.actorName == null
    && row.actorSystemProcess == null
    && row.fieldChangesJsonb == null;
}

export async function buildLegacyAuditEnrichmentPlan(
  row: LegacyAuditRow,
  lookup: LegacyAuditLookupContext
): Promise<LegacyAuditEnrichmentPlan> {
  if (!isLegacyAuditRowCandidate(row)) {
    return {
      row,
      update: false,
      entityNameSnapshot: row.entityNameSnapshot,
      actorName: row.actorName,
      entityResolution: "skipped",
      actorResolution: "not_applicable",
      skipReason: row.entityNameSnapshot != null || row.actorName != null ? "already_enriched" : "not_legacy",
    };
  }

  if (row.tableName.startsWith("office_")) {
    return {
      row,
      update: false,
      entityNameSnapshot: null,
      actorName: null,
      entityResolution: "skipped",
      actorResolution: "not_applicable",
      skipReason: "office_metadata",
    };
  }

  if (!isLookupableTableName(row.tableName)) {
    return {
      row,
      update: false,
      entityNameSnapshot: null,
      actorName: null,
      entityResolution: "skipped",
      actorResolution: "not_applicable",
      skipReason: "unknown_table",
    };
  }

  if (!isUuid(row.recordId)) {
    return {
      row,
      update: false,
      entityNameSnapshot: null,
      actorName: null,
      entityResolution: "skipped",
      actorResolution: "not_applicable",
      skipReason: "invalid_record_id",
    };
  }

  const actorName = lookup.actorName ?? null;
  const actorResolution: ActorResolution = row.changedBy ? (actorName ? "found" : "missing_actor") : "not_applicable";
  const resolvedSnapshot = lookup.entity ? buildEntityNameSnapshot(lookup.entity) : null;
  const entityNameSnapshot = resolvedSnapshot ?? deletedEntityLabel(row.tableName, row.recordId);
  const entityResolution: EntityResolution = resolvedSnapshot ? "found" : "deleted_fallback";

  return {
    row,
    update: entityNameSnapshot !== null || actorName !== null,
    entityNameSnapshot,
    actorName,
    entityResolution,
    actorResolution,
    skipReason: entityNameSnapshot !== null || actorName !== null ? null : "no_changes",
  };
}

export function buildBatchSummary(plans: LegacyAuditEnrichmentPlan[]): BatchSummary {
  const summary: BatchSummary = {
    totalRows: plans.length,
    rowsToUpdate: 0,
    entitySnapshotsSet: 0,
    actorNamesSet: 0,
    actorRecoverable: 0,
    actorUnrecoverable: 0,
    deletedFallbacks: 0,
    byTable: {},
    skipped: {},
    samples: [],
  };

  for (const plan of plans) {
    summary.byTable[plan.row.tableName] ??= {
      total: 0,
      rowsToUpdate: 0,
      entitySnapshotsSet: 0,
      actorNamesSet: 0,
      actorRecoverable: 0,
      actorUnrecoverable: 0,
      deletedFallbacks: 0,
      skipped: 0,
    };
    const tableSummary = summary.byTable[plan.row.tableName];
    tableSummary.total += 1;
    if (plan.row.changedBy) {
      if (plan.actorResolution === "found") {
        summary.actorRecoverable += 1;
        tableSummary.actorRecoverable += 1;
      } else if (plan.actorResolution === "missing_actor") {
        summary.actorUnrecoverable += 1;
        tableSummary.actorUnrecoverable += 1;
      }
    } else {
      summary.actorUnrecoverable += 1;
      tableSummary.actorUnrecoverable += 1;
    }
    if (plan.update) {
      summary.rowsToUpdate += 1;
      tableSummary.rowsToUpdate += 1;
      if (plan.entityNameSnapshot) {
        summary.entitySnapshotsSet += 1;
        tableSummary.entitySnapshotsSet += 1;
      }
      if (plan.actorName) {
        summary.actorNamesSet += 1;
        tableSummary.actorNamesSet += 1;
      }
      if (plan.entityResolution === "deleted_fallback") {
        summary.deletedFallbacks += 1;
        tableSummary.deletedFallbacks += 1;
      }
      if (summary.samples.length < 10 && plan.entityNameSnapshot) {
        summary.samples.push(`${plan.row.tableName} -> ${plan.entityNameSnapshot}`);
      }
    } else if (plan.skipReason) {
      tableSummary.skipped += 1;
      summary.skipped[plan.skipReason] = (summary.skipped[plan.skipReason] ?? 0) + 1;
    }
  }

  return summary;
}

export function parseEnrichLegacyAuditLogArgs(argv: string[]): ParsedEnrichmentArgs {
  const args = argv[0] === "enrich-legacy-audit-log" ? argv.slice(1) : argv;
  const officeArg = args.find((arg) => arg.startsWith("--office="));
  const all = args.includes("--all");
  if (!officeArg && !all) {
    throw new Error("Choose either --office=<office_dallas> or --all");
  }
  if (officeArg && all) {
    throw new Error("Choose either --office=<office_dallas> or --all, not both");
  }

  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  const batchSizeArg = args.find((arg) => arg.startsWith("--batch-size="));
  const limit = limitArg ? Number(limitArg.split("=").slice(1).join("=")) : null;
  const batchSize = batchSizeArg ? Number(batchSizeArg.split("=").slice(1).join("=")) : DEFAULT_BATCH_SIZE;

  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > 5000) {
    throw new Error("--batch-size must be an integer between 1 and 5000");
  }

  return {
    offices: officeArg ? [validateOfficeSchema(officeArg.split("=").slice(1).join("="))] : [],
    dryRun: args.includes("--dry-run"),
    batchSize,
    limit,
  };
}

export async function listTenantSchemas(client: Queryable): Promise<string[]> {
  const result = await client.query(`
    SELECT nspname
      FROM pg_namespace
     WHERE nspname LIKE 'office\\_%' ESCAPE '\\'
     ORDER BY nspname
  `);
  return result.rows.map((row: { nspname: string }) => validateOfficeSchema(row.nspname));
}

async function countLegacyAuditCandidates(
  client: Queryable,
  schemaName: string,
  cutoffAt: string
): Promise<number> {
  const safeSchema = quoteIdent(schemaName);
  const result = await client.query(
    `
      SELECT COUNT(*)::int AS total
      FROM ${safeSchema}.audit_log
      WHERE created_at < $1::timestamptz
        AND enrich_attempted_at IS NULL
        AND entity_name_snapshot IS NULL
        AND actor_name IS NULL
        AND actor_system_process IS NULL
        AND field_changes_jsonb IS NULL
    `,
    [cutoffAt]
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function fetchLegacyAuditBatch(
  client: Queryable,
  schemaName: string,
  afterId: number,
  batchSize: number,
  cutoffAt: string
): Promise<LegacyAuditRow[]> {
  const safeSchema = quoteIdent(schemaName);
  const result = await client.query(
    `
      SELECT
        id,
        table_name AS "tableName",
        record_id::text AS "recordId",
        action::text AS action,
        changed_by::text AS "changedBy",
        actor_name AS "actorName",
        actor_system_process AS "actorSystemProcess",
        entity_name_snapshot AS "entityNameSnapshot",
        field_changes_jsonb AS "fieldChangesJsonb",
        enrich_attempted_at::text AS "enrichAttemptedAt",
        created_at::text AS "createdAt"
      FROM ${safeSchema}.audit_log
      WHERE id > $1
        AND created_at < $3::timestamptz
        AND enrich_attempted_at IS NULL
        AND entity_name_snapshot IS NULL
        AND actor_name IS NULL
        AND actor_system_process IS NULL
        AND field_changes_jsonb IS NULL
      ORDER BY id ASC
      LIMIT $2
    `,
    [afterId, batchSize, cutoffAt]
  );
  return result.rows as LegacyAuditRow[];
}

async function fetchLegacyAuditBatchForUpdate(
  client: Queryable,
  schemaName: string,
  batchSize: number,
  cutoffAt: string
): Promise<LegacyAuditRow[]> {
  const safeSchema = quoteIdent(schemaName);
  const result = await client.query(
    `
      WITH candidate AS (
        SELECT id
        FROM ${safeSchema}.audit_log
        WHERE created_at < $1::timestamptz
          AND enrich_attempted_at IS NULL
          AND entity_name_snapshot IS NULL
          AND actor_name IS NULL
          AND actor_system_process IS NULL
          AND field_changes_jsonb IS NULL
        ORDER BY id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      SELECT
        al.id,
        al.table_name AS "tableName",
        al.record_id::text AS "recordId",
        al.action::text AS action,
        al.changed_by::text AS "changedBy",
        al.actor_name AS "actorName",
        al.actor_system_process AS "actorSystemProcess",
        al.entity_name_snapshot AS "entityNameSnapshot",
        al.field_changes_jsonb AS "fieldChangesJsonb",
        al.enrich_attempted_at::text AS "enrichAttemptedAt",
        al.created_at::text AS "createdAt"
      FROM ${safeSchema}.audit_log al
      JOIN candidate c ON c.id = al.id
      ORDER BY al.id ASC
    `,
    [cutoffAt, batchSize]
  );
  return result.rows as LegacyAuditRow[];
}

async function lookupEntity(
  client: Queryable,
  schemaName: string,
  row: LegacyAuditRow,
  cache: Map<string, LegacyAuditEntityRecord | null>
): Promise<LegacyAuditEntityRecord | null> {
  const key = `${row.tableName}:${row.recordId}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  if (!isLookupableTableName(row.tableName) || !isUuid(row.recordId)) {
    cache.set(key, null);
    return null;
  }

  const safeSchema = quoteIdent(schemaName);
  let query:
    | { name: string; text: string; values: unknown[] }
    | null = null;

  switch (row.tableName) {
    case "deals":
      query = {
        name: buildStatementName(schemaName, "legacy-audit-enrich-deal"),
        text: `SELECT id::text, name, project_number AS "projectNumber" FROM ${safeSchema}.deals WHERE id = $1::uuid LIMIT 1`,
        values: [row.recordId],
      };
      break;
    case "leads":
      query = {
        name: buildStatementName(schemaName, "legacy-audit-enrich-lead"),
        text: `SELECT id::text, name FROM ${safeSchema}.leads WHERE id = $1::uuid LIMIT 1`,
        values: [row.recordId],
      };
      break;
    case "properties":
      query = {
        name: buildStatementName(schemaName, "legacy-audit-enrich-property"),
        text: `SELECT id::text, address, city, state, name FROM ${safeSchema}.properties WHERE id = $1::uuid LIMIT 1`,
        values: [row.recordId],
      };
      break;
    case "companies":
      query = {
        name: buildStatementName(schemaName, "legacy-audit-enrich-company"),
        text: `SELECT id::text, name FROM ${safeSchema}.companies WHERE id = $1::uuid LIMIT 1`,
        values: [row.recordId],
      };
      break;
    case "users":
      query = {
        name: buildStatementName(schemaName, "legacy-audit-enrich-user-entity"),
        text: `SELECT id::text, display_name AS "displayName" FROM public.users WHERE id = $1::uuid LIMIT 1`,
        values: [row.recordId],
      };
      break;
  }

  const result = query ? await client.query(query) : { rows: [] };
  const entity = (result.rows[0] as Omit<LegacyAuditEntityRecord, "tableName"> | undefined)
    ? { tableName: row.tableName, ...(result.rows[0] as Omit<LegacyAuditEntityRecord, "tableName">) }
    : null;
  cache.set(key, entity);
  return entity;
}

async function lookupActorName(
  client: Queryable,
  schemaName: string,
  changedBy: string | null,
  cache: Map<string, string | null>
): Promise<string | null> {
  if (!changedBy || !isUuid(changedBy)) return null;
  if (cache.has(changedBy)) return cache.get(changedBy) ?? null;
  const result = await client.query({
    name: buildStatementName(schemaName, "legacy-audit-enrich-actor"),
    text: `SELECT display_name AS "displayName" FROM public.users WHERE id = $1::uuid LIMIT 1`,
    values: [changedBy],
  });
  const actorName = normalizeText(result.rows[0]?.displayName);
  cache.set(changedBy, actorName);
  return actorName;
}

async function applyPlans(
  client: Queryable,
  schemaName: string,
  plans: LegacyAuditEnrichmentPlan[]
): Promise<number> {
  if (plans.length === 0) return 0;
  const safeSchema = quoteIdent(schemaName);
  let updatedRows = 0;
  for (const plan of plans) {
    const result = await client.query({
      name: buildStatementName(schemaName, "legacy-audit-enrich-update"),
      text: `
        UPDATE ${safeSchema}.audit_log
           SET entity_name_snapshot = COALESCE(entity_name_snapshot, $1),
               actor_name = COALESCE(actor_name, $2),
               enrich_attempted_at = COALESCE(enrich_attempted_at, NOW())
         WHERE id = $3
           AND enrich_attempted_at IS NULL
           AND entity_name_snapshot IS NULL
           AND actor_name IS NULL
           AND actor_system_process IS NULL
           AND field_changes_jsonb IS NULL
      `,
      values: [plan.entityNameSnapshot, plan.actorName, plan.row.id],
    });
    updatedRows += Number(result.rowCount ?? 0);
  }
  return updatedRows;
}

function mergeSummaries(left: BatchSummary, right: BatchSummary): BatchSummary {
  const byTable = { ...left.byTable };
  const skipped = { ...left.skipped };
  for (const [tableName, count] of Object.entries(right.byTable)) {
    const existing = byTable[tableName] ?? {
      total: 0,
      rowsToUpdate: 0,
      entitySnapshotsSet: 0,
      actorNamesSet: 0,
      actorRecoverable: 0,
      actorUnrecoverable: 0,
      deletedFallbacks: 0,
      skipped: 0,
    };
    byTable[tableName] = {
      total: existing.total + count.total,
      rowsToUpdate: existing.rowsToUpdate + count.rowsToUpdate,
      entitySnapshotsSet: existing.entitySnapshotsSet + count.entitySnapshotsSet,
      actorNamesSet: existing.actorNamesSet + count.actorNamesSet,
      actorRecoverable: existing.actorRecoverable + count.actorRecoverable,
      actorUnrecoverable: existing.actorUnrecoverable + count.actorUnrecoverable,
      deletedFallbacks: existing.deletedFallbacks + count.deletedFallbacks,
      skipped: existing.skipped + count.skipped,
    };
  }
  for (const [reason, count] of Object.entries(right.skipped)) {
    skipped[reason] = (skipped[reason] ?? 0) + count;
  }
  return {
    totalRows: left.totalRows + right.totalRows,
    rowsToUpdate: left.rowsToUpdate + right.rowsToUpdate,
    entitySnapshotsSet: left.entitySnapshotsSet + right.entitySnapshotsSet,
    actorNamesSet: left.actorNamesSet + right.actorNamesSet,
    actorRecoverable: left.actorRecoverable + right.actorRecoverable,
    actorUnrecoverable: left.actorUnrecoverable + right.actorUnrecoverable,
    deletedFallbacks: left.deletedFallbacks + right.deletedFallbacks,
    byTable,
    skipped,
    samples: [...left.samples, ...right.samples].slice(0, 10),
  };
}

export async function enrichLegacyAuditLog(
  client: Queryable,
  options: EnrichLegacyAuditLogOptions
): Promise<EnrichmentTenantResult> {
  const startedAt = Date.now();
  const schemaName = validateOfficeSchema(options.officeName);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const dryRun = options.dryRun ?? false;
  const limit = options.limit ?? null;
  const cutoffAt = DEFAULT_CUTOFF_AT;
  const totalCandidateRows = await countLegacyAuditCandidates(client, schemaName, cutoffAt);
  let dryRunAfterId = 0;
  let examinedRows = 0;
  let processedSinceProgressLog = 0;
  let summary: BatchSummary = {
    totalRows: 0,
    rowsToUpdate: 0,
    entitySnapshotsSet: 0,
    actorNamesSet: 0,
    actorRecoverable: 0,
    actorUnrecoverable: 0,
    deletedFallbacks: 0,
    byTable: {},
    skipped: {},
    samples: [],
  };

  while (true) {
    const remaining = limit == null ? batchSize : Math.min(batchSize, Math.max(limit - examinedRows, 0));
    if (remaining <= 0) break;

    let rows: LegacyAuditRow[] = [];

    if (dryRun) {
      rows = await fetchLegacyAuditBatch(client, schemaName, dryRunAfterId, remaining, cutoffAt);
      if (rows.length === 0) break;
    } else {
      await client.query("BEGIN");
      try {
        rows = await fetchLegacyAuditBatchForUpdate(client, schemaName, remaining, cutoffAt);
        if (rows.length === 0) {
          await client.query("COMMIT");
          break;
        }
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    const entityCache = new Map<string, LegacyAuditEntityRecord | null>();
    const actorCache = new Map<string, string | null>();
    const plans: LegacyAuditEnrichmentPlan[] = [];

    for (const row of rows) {
      const [entity, actorName] = await Promise.all([
        lookupEntity(client, schemaName, row, entityCache),
        lookupActorName(client, schemaName, row.changedBy, actorCache),
      ]);
      plans.push(await buildLegacyAuditEnrichmentPlan(row, { entity, actorName }));
    }

    if (!dryRun) {
      try {
        await applyPlans(client, schemaName, plans);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    const batchSummary = buildBatchSummary(plans);
    summary = mergeSummaries(summary, batchSummary);
    examinedRows += rows.length;
    processedSinceProgressLog += rows.length;
    if (dryRun) {
      dryRunAfterId = rows[rows.length - 1]?.id ?? dryRunAfterId;
    }

    if (processedSinceProgressLog >= PROGRESS_LOG_INTERVAL) {
      const percent = totalCandidateRows > 0 ? ((examinedRows / totalCandidateRows) * 100).toFixed(1) : "100.0";
      const remaining = Math.max(totalCandidateRows - examinedRows, 0);
      console.log(
        `[legacy-audit-enrichment] ${schemaName}: enriched ${summary.rowsToUpdate}/${totalCandidateRows} rows so far (${percent}% complete, est ${remaining} candidate rows remaining)`
      );
      processedSinceProgressLog = 0;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const observedMsPerCandidate = examinedRows > 0 ? elapsedMs / examinedRows : 0;

  return {
    tenant: schemaName,
    examinedRows,
    totalCandidateRows,
    estimatedExecuteMs: observedMsPerCandidate * summary.rowsToUpdate,
    elapsedMs,
    ...summary,
    rowsToUpdate: summary.rowsToUpdate,
  };
}

function formatSummaryMarkdown(result: EnrichmentRunResult, dryRun: boolean): string {
  const lines: string[] = [
    "# Legacy Audit Enrichment Report",
    "",
    `Mode: ${dryRun ? "dry-run" : "execute"}`,
    `Generated: ${new Date().toISOString()}`,
    `Elapsed: ${(result.elapsedMs / 1000).toFixed(1)}s`,
    `Total candidate rows examined: ${result.totalExaminedRows}`,
    `Total rows ${dryRun ? "that would be updated" : "updated"}: ${result.totalRowsUpdated}`,
    "",
    "Phase 1.5 rich rows were not modified. The script only scans rows where `entity_name_snapshot IS NULL`, `actor_name IS NULL`, `actor_system_process IS NULL`, and `field_changes_jsonb IS NULL`.",
    "",
  ];

  for (const tenant of result.tenants) {
    lines.push(`## ${tenant.tenant}`);
    lines.push("");
    lines.push(`- Examined rows: ${tenant.examinedRows}`);
    lines.push(`- Candidate rows matching the legacy filter: ${tenant.totalCandidateRows}`);
    lines.push(`- Rows ${dryRun ? "to update" : "updated"}: ${tenant.rowsToUpdate}`);
    lines.push(`- Entity snapshots ${dryRun ? "to set" : "set"}: ${tenant.entitySnapshotsSet}`);
    lines.push(`- Actor names ${dryRun ? "to set" : "set"}: ${tenant.actorNamesSet}`);
    lines.push(`- Rows with recoverable actor info: ${tenant.actorRecoverable}`);
    lines.push(`- Rows with no recoverable actor info: ${tenant.actorUnrecoverable}`);
    lines.push(`- Deleted-entity fallbacks: ${tenant.deletedFallbacks}`);
    lines.push(`- Estimated ${dryRun ? "execute" : "observed"} runtime at current throughput: ${(tenant.estimatedExecuteMs / 1000).toFixed(1)}s`);
    lines.push(`- Elapsed: ${(tenant.elapsedMs / 1000).toFixed(1)}s`);
    lines.push("");
    lines.push("### Breakdown by table");
    lines.push("");
    for (const [tableName, counts] of Object.entries(tenant.byTable).sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(
        `- ${tableName}: total=${counts.total}, updates=${counts.rowsToUpdate}, entity_snapshots=${counts.entitySnapshotsSet}, actor_names=${counts.actorNamesSet}, actor_recoverable=${counts.actorRecoverable}, actor_unrecoverable=${counts.actorUnrecoverable}, deleted_fallbacks=${counts.deletedFallbacks}, skipped=${counts.skipped}`
      );
    }
    lines.push("");
    lines.push("### Skipped rows");
    lines.push("");
    if (Object.keys(tenant.skipped).length === 0) {
      lines.push("- none");
    } else {
      for (const [reason, count] of Object.entries(tenant.skipped).sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`- ${reason}: ${count}`);
      }
    }
    lines.push("");
    lines.push("### Sample enriched values");
    lines.push("");
    if (tenant.samples.length === 0) {
      lines.push("- none");
    } else {
      for (const sample of tenant.samples) lines.push(`- ${sample}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function writeReport(markdown: string) {
  const reportPath = path.resolve(process.cwd(), REPORT_PATH);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, markdown, "utf8");
  console.log(`[legacy-audit-enrichment] wrote report to ${reportPath}`);
}

export async function runEnrichLegacyAuditLog(argv = process.argv.slice(2)): Promise<EnrichmentRunResult> {
  const parsed = parseEnrichLegacyAuditLogArgs(argv);
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  const startedAt = Date.now();

  try {
    const offices = parsed.offices.length > 0 ? parsed.offices : await listTenantSchemas(client);
    const tenantResults: EnrichmentTenantResult[] = [];

    for (const officeName of offices) {
      console.log(`[legacy-audit-enrichment] starting ${officeName} (${parsed.dryRun ? "dry-run" : "execute"})`);
      tenantResults.push(
        await enrichLegacyAuditLog(client, {
          officeName,
          batchSize: parsed.batchSize,
          dryRun: parsed.dryRun,
          limit: parsed.limit,
        })
      );
    }

    const result: EnrichmentRunResult = {
      tenants: tenantResults,
      totalExaminedRows: tenantResults.reduce((sum, tenant) => sum + tenant.examinedRows, 0),
      totalRowsUpdated: tenantResults.reduce((sum, tenant) => sum + tenant.rowsToUpdate, 0),
      elapsedMs: Date.now() - startedAt,
    };

    const report = formatSummaryMarkdown(result, parsed.dryRun);
    writeReport(report);
    console.log(report);
    return result;
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  runEnrichLegacyAuditLog().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
