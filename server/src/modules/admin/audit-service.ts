import { sql, SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { redactAuditFieldChangesForRole, type FormattedAuditFieldChange } from "../audit/field-formatters.js";
import type { UserRole } from "@trock-crm/shared/types";

type TenantDb = NodePgDatabase<typeof schema>;

export interface AuditLogFilter {
  entityType?: string;
  actorQuery?: string;
  action?: string;
  fromDate?: string;
  toDate?: string;
  expand?: string;
  cursor?: string;
  page?: number;
  limit?: number;
}

export interface AuditLogRow {
  id: number;
  actorLabel: string;
  actorType: "user" | "system";
  action: string;
  entityType: string;
  entityName: string;
  entitySecondaryId: string | null;
  occurredAt: string;
  summary: string | null;
  fieldChanges: FormattedAuditFieldChange[];
  visibilityScope: "internal" | "customer_safe" | "role_restricted";
}

export interface AuditLogSingleEntry extends AuditLogRow {
  type: "single";
  actorSystemProcess: string | null;
  recordId: string | null;
}

export interface AuditLogGroupEntry {
  type: "group";
  id: string;
  processName: string;
  startTime: string;
  endTime: string;
  totalCount: number;
  distinctEntityCount: number;
  entityType: string;
  action: string;
  previewEntities: Array<{ name: string; snapshot: string | null }>;
  childEntries: AuditLogSingleEntry[];
}

export type AuditLogFeedItem = AuditLogSingleEntry | AuditLogGroupEntry;

export interface AuditLogFeedResult {
  rows: AuditLogFeedItem[];
  hasMore: boolean;
  nextCursor?: string | null;
  total?: number;
}

export interface AuditLogCountResult {
  total: number | null;
}

interface GroupAuditOptions {
  minGroupSize?: number;
  maxGapSeconds?: number;
  childPreviewLimit?: number;
}

const DEFAULT_BATCH_GROUP_MIN_SIZE = 5;
const DEFAULT_BATCH_GROUP_GAP_SECONDS = Number(process.env.AUDIT_BATCH_GROUP_GAP_SECONDS ?? 120);
const DEFAULT_BATCH_GROUP_CHILD_PREVIEW_LIMIT = 10;
const MAX_AUDIT_LOG_RAW_WINDOW = 1000;

interface AuditGroupToken {
  processName: string;
  entityType: string;
  action: string;
  startTime: string;
  endTime: string;
}

interface AuditCursor {
  createdAt: string;
  id: number;
}

function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeAuditCursor(cursor: string | undefined): AuditCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<AuditCursor>;
    if (!parsed.createdAt || typeof parsed.id !== "number" || !Number.isFinite(parsed.id)) return null;
    const date = new Date(parsed.createdAt);
    if (Number.isNaN(date.getTime())) return null;
    return { createdAt: date.toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

function encodeAuditGroupId(token: AuditGroupToken): string {
  return `batch:${Buffer.from(JSON.stringify(token), "utf8").toString("base64url")}`;
}

function decodeAuditGroupId(groupId: string): AuditGroupToken | null {
  if (!groupId.startsWith("batch:")) return null;
  try {
    const payload = Buffer.from(groupId.slice("batch:".length), "base64url").toString("utf8");
    const parsed = JSON.parse(payload) as Partial<AuditGroupToken>;
    if (!parsed.processName || !parsed.startTime || !parsed.endTime) return null;
    return {
      processName: parsed.processName,
      entityType: parsed.entityType ?? "",
      action: parsed.action ?? "",
      startTime: parsed.startTime,
      endTime: parsed.endTime,
    };
  } catch {
    return null;
  }
}

export function groupAuditLogRows(
  rows: AuditLogSingleEntry[],
  options: GroupAuditOptions = {}
): AuditLogFeedItem[] {
  const minGroupSize = options.minGroupSize ?? DEFAULT_BATCH_GROUP_MIN_SIZE;
  const maxGapMs = (options.maxGapSeconds ?? DEFAULT_BATCH_GROUP_GAP_SECONDS) * 1000;
  const childPreviewLimit = options.childPreviewLimit ?? DEFAULT_BATCH_GROUP_CHILD_PREVIEW_LIMIT;
  const output: AuditLogFeedItem[] = [];
  let current: AuditLogSingleEntry[] = [];

  function flushCurrent() {
    if (current.length === 0) return;
    if (current.length < minGroupSize) {
      output.push(...current);
      current = [];
      return;
    }

    const processName = current[0].actorSystemProcess!;
    const times = current.map((entry) => new Date(entry.occurredAt).getTime());
    const startTime = new Date(Math.min(...times)).toISOString();
    const endTime = new Date(Math.max(...times)).toISOString();
    const distinctKeys = new Set(current.map((entry) => entry.recordId ?? `${entry.entityName}:${entry.entitySecondaryId ?? ""}`));
    const previewEntities = current.slice(0, 5).map((entry) => ({
      name: entry.entityName,
      snapshot: entry.entitySecondaryId,
    }));

    output.push({
      type: "group",
      id: encodeAuditGroupId({ processName, entityType: current[0].entityType, action: current[0].action, startTime, endTime }),
      processName,
      startTime,
      endTime,
      totalCount: current.length,
      distinctEntityCount: distinctKeys.size,
      entityType: current[0].entityType,
      action: current[0].action,
      previewEntities,
      childEntries: current.slice(0, childPreviewLimit),
    });
    current = [];
  }

  for (const row of rows) {
    if (!row.actorSystemProcess) {
      flushCurrent();
      output.push(row);
      continue;
    }

    const previous = current[current.length - 1];
    const sameProcess = previous?.actorSystemProcess === row.actorSystemProcess;
    const sameEntityAndAction = previous?.entityType === row.entityType && previous?.action === row.action;
    const gap = previous
      ? Math.abs(new Date(previous.occurredAt).getTime() - new Date(row.occurredAt).getTime())
      : 0;

    if (!previous || (sameProcess && sameEntityAndAction && gap <= maxGapMs)) {
      current.push(row);
    } else {
      flushCurrent();
      current.push(row);
    }
  }

  flushCurrent();
  return output;
}

export async function getAuditLog(
  tenantDb: TenantDb,
  userRole: UserRole,
  filter: AuditLogFilter = {}
): Promise<AuditLogFeedResult> {
  if (filter.expand) {
    const limit = Math.min(filter.limit ?? 500, 1000);
    const page = Math.max(filter.page ?? 1, 1);
    const offset = (page - 1) * limit;
    const expanded = await getAuditLogGroupChildren(tenantDb, userRole, filter);
    return {
      rows: expanded.rows,
      hasMore: offset + expanded.rows.length < expanded.total,
      total: expanded.total,
    };
  }

  const limit = Math.max(1, Math.min(filter.limit ?? 50, 200));
  // Fetch a bounded raw window, then apply duplicate suppression and system-batch
  // grouping inside that window. This keeps each page off the full audit table.
  const rawWindowLimit = Math.min(Math.max(limit * 25, limit + 1), MAX_AUDIT_LOG_RAW_WINDOW);
  const cursor = decodeAuditCursor(filter.cursor);
  const where = buildAuditLogWhere(filter, { includeDedup: false });
  const dataResult = await tenantDb.execute(buildBoundedFeedDataSql(where, rawWindowLimit + 1, cursor));

  const dataRows = ((dataResult as unknown) as { rows?: Array<Record<string, unknown>> }).rows ?? [];
  const boundedRows = dataRows.slice(0, rawWindowLimit);
  const visibleRows = boundedRows
    .filter((row) => !isDuplicateRawAuditRow(row))
    .map((row) => ({ raw: row, entry: mapAuditRow(row, userRole) }));
  const feedRows = groupAuditLogRows(visibleRows.map((row) => row.entry)).slice(0, limit);
  const consumedVisibleCount = feedRows.reduce(
    (count, row) => count + (row.type === "group" ? row.totalCount : 1),
    0
  );
  const cursorRawRow = consumedVisibleCount < visibleRows.length
    ? visibleRows[Math.max(consumedVisibleCount - 1, 0)]?.raw
    : boundedRows[boundedRows.length - 1];
  const hasMore = consumedVisibleCount < visibleRows.length || dataRows.length > rawWindowLimit;

  return {
    rows: feedRows,
    hasMore,
    nextCursor: hasMore && cursorRawRow
      ? encodeAuditCursor({
          createdAt: cursorRawRow.created_at instanceof Date ? cursorRawRow.created_at.toISOString() : String(cursorRawRow.created_at),
          id: Number(cursorRawRow.id),
        })
      : null,
  };
}

export async function getAuditLogCount(
  _tenantDb: TenantDb,
  filter: AuditLogFilter = {}
): Promise<AuditLogCountResult> {
  void filter;
  return { total: null };
}

async function getAuditLogGroupChildren(
  tenantDb: TenantDb,
  userRole: UserRole,
  filter: AuditLogFilter
): Promise<{ rows: AuditLogSingleEntry[]; total: number }> {
  const token = decodeAuditGroupId(filter.expand ?? "");
  if (!token) return { rows: [], total: 0 };

  const limit = Math.min(filter.limit ?? 500, 1000);
  const conditions: SQL[] = [
    buildDedupCondition(),
    sql`al.actor_system_process = ${token.processName}`,
    token.entityType ? sql`COALESCE(al.entity_type, al.table_name) = ${token.entityType}` : sql`TRUE`,
    token.action ? sql`al.action = ${token.action}` : sql`TRUE`,
    sql`al.created_at >= ${token.startTime}::timestamptz`,
    sql`al.created_at <= ${token.endTime}::timestamptz`,
  ];

  if (filter.entityType) {
    conditions.push(sql`COALESCE(al.entity_type, al.table_name) = ${filter.entityType}`);
  }
  if (filter.action) {
    conditions.push(sql`al.action = ${filter.action}`);
  }

  const where = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);
  const countResult = await tenantDb.execute(sql`
    SELECT COUNT(*)::int AS total
    FROM audit_log al
    LEFT JOIN public.users u ON u.id = al.changed_by
    WHERE ${where}
  `);
  const countRows = ((countResult as unknown) as { rows?: Array<{ total: number }> }).rows ?? [];
  const total = Number(countRows[0]?.total ?? 0);
  const page = Math.max(filter.page ?? 1, 1);
  const offset = (page - 1) * limit;
  const dataResult = await tenantDb.execute(sql`
    SELECT
      al.id,
      al.action,
      COALESCE(al.entity_type, al.table_name) AS entity_type,
      COALESCE(al.entity_name_snapshot, al.table_name || ':' || al.record_id) AS entity_name,
      al.entity_secondary_id_snapshot,
      al.actor_system_process,
      al.record_id,
      COALESCE(al.actor_name, u.display_name, CASE WHEN al.actor_system_process IS NOT NULL THEN al.actor_system_process ELSE 'System' END) AS actor_label,
      CASE WHEN al.actor_system_process IS NOT NULL THEN 'system' ELSE 'user' END AS actor_type,
      al.field_changes_jsonb,
      al.visibility_scope,
      al.created_at
    FROM audit_log al
    LEFT JOIN public.users u ON u.id = al.changed_by
    WHERE ${where}
    ORDER BY al.created_at DESC, al.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const rows = (((dataResult as unknown) as { rows?: Array<Record<string, unknown>> }).rows ?? [])
    .map((row) => mapAuditRow(row, userRole));

  return { rows, total };
}

function buildAuditLogWhere(filter: AuditLogFilter, options: { includeDedup?: boolean } = {}): SQL {
  const conditions: SQL[] = options.includeDedup === false ? [sql`TRUE`] : [buildDedupCondition()];

  if (filter.entityType) {
    conditions.push(sql`COALESCE(al.entity_type, al.table_name) = ${filter.entityType}`);
  }
  if (filter.actorQuery) {
    const pattern = `%${filter.actorQuery.trim()}%`;
    conditions.push(sql`COALESCE(al.actor_name, u.display_name, '') ILIKE ${pattern}`);
  }
  if (filter.action) {
    conditions.push(sql`al.action = ${filter.action}`);
  }
  if (filter.fromDate) {
    conditions.push(sql`al.created_at >= ${filter.fromDate}::timestamptz`);
  }
  if (filter.toDate) {
    conditions.push(sql`al.created_at <= (${filter.toDate}::date + INTERVAL '1 day')::timestamptz`);
  }

  return conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);
}

function buildBoundedFeedDataSql(where: SQL, limit: number, cursor: AuditCursor | null): SQL {
  const keyset = cursor
    ? sql`AND (al.created_at, al.id) < (${cursor.createdAt}::timestamptz, ${cursor.id})`
    : sql``;

  return sql`
    WITH raw AS MATERIALIZED (
      SELECT
        al.id,
        al.action,
        al.table_name,
        COALESCE(al.entity_type, al.table_name) AS entity_type,
        al.entity_name_snapshot,
        COALESCE(al.entity_name_snapshot, al.table_name || ':' || al.record_id) AS entity_name,
        al.entity_secondary_id_snapshot,
        al.actor_system_process,
        al.actor_name,
        al.record_id,
        COALESCE(al.actor_name, u.display_name, CASE WHEN al.actor_system_process IS NOT NULL THEN al.actor_system_process ELSE 'System' END) AS actor_label,
        CASE WHEN al.actor_system_process IS NOT NULL THEN 'system' ELSE 'user' END AS actor_type,
        al.field_changes_jsonb,
        al.visibility_scope,
        al.created_at
      FROM audit_log al
      LEFT JOIN public.users u ON u.id = al.changed_by
      WHERE ${where}
        ${keyset}
      ORDER BY al.created_at DESC, al.id DESC
      LIMIT ${limit}
    )
    SELECT
      al.*,
      ${buildDuplicateExistsCondition()} AS is_duplicate
    FROM raw al
    ORDER BY al.created_at DESC, al.id DESC
  `;
}

function buildDedupCondition(): SQL {
  return sql`NOT (${buildDuplicateExistsCondition()})`;
}

function buildDuplicateExistsCondition(): SQL {
  return sql`
    (
      al.actor_name IS NULL
      AND al.actor_system_process IS NULL
      AND al.entity_name_snapshot IS NULL
      AND EXISTS (
        SELECT 1
        FROM audit_log rich
        WHERE rich.id <> al.id
          AND rich.table_name = al.table_name
          AND rich.record_id = al.record_id
          AND rich.action = al.action
          AND rich.created_at BETWEEN
            al.created_at - INTERVAL '500 milliseconds'
            AND al.created_at + INTERVAL '500 milliseconds'
          AND rich.field_changes_jsonb IS NOT NULL
          AND (
            al.field_changes_jsonb IS NULL
            OR rich.field_changes_jsonb::text = al.field_changes_jsonb::text
          )
          AND (
            rich.actor_name IS NOT NULL
            OR rich.actor_system_process IS NOT NULL
            OR rich.entity_name_snapshot IS NOT NULL
            OR rich.field_changes_jsonb IS NOT NULL
          )
      )
    )
  `;
}

function isDuplicateRawAuditRow(row: Record<string, unknown>): boolean {
  return row.is_duplicate === true || row.is_duplicate === "true" || row.is_duplicate === "t";
}

function mapAuditRow(row: Record<string, unknown>, userRole: UserRole): AuditLogSingleEntry {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return {
    type: "single",
    id: Number(row.id),
    actorLabel: String(row.actor_label ?? "System"),
    actorType: row.actor_type === "system" ? "system" : "user",
    actorSystemProcess: row.actor_system_process == null ? null : String(row.actor_system_process),
    recordId: row.record_id == null ? null : String(row.record_id),
    action: String(row.action ?? "update"),
    entityType: String(row.entity_type ?? "record"),
    entityName: String(row.entity_name ?? "Record"),
    entitySecondaryId: row.entity_secondary_id_snapshot == null ? null : String(row.entity_secondary_id_snapshot),
    occurredAt: createdAt,
    summary: null,
    fieldChanges: redactAuditFieldChangesForRole(
      Array.isArray(row.field_changes_jsonb) ? (row.field_changes_jsonb as FormattedAuditFieldChange[]) : [],
      userRole
    ),
    visibilityScope: (row.visibility_scope as AuditLogRow["visibilityScope"]) ?? "internal",
  };
}

export async function getAuditLogEntityTypes(tenantDb: TenantDb): Promise<string[]> {
  const result = await tenantDb.execute(
    sql`SELECT DISTINCT COALESCE(entity_type, table_name) AS entity_type
        FROM audit_log
        ORDER BY COALESCE(entity_type, table_name)`
  );
  const rows = ((result as unknown) as { rows?: Array<{ entity_type: string }> }).rows ?? [];
  return rows.map((row) => row.entity_type).filter(Boolean);
}
