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

interface GroupAuditOptions {
  minGroupSize?: number;
  maxGapSeconds?: number;
  childPreviewLimit?: number;
}

const DEFAULT_BATCH_GROUP_MIN_SIZE = 5;
const DEFAULT_BATCH_GROUP_GAP_SECONDS = Number(process.env.AUDIT_BATCH_GROUP_GAP_SECONDS ?? 120);
const DEFAULT_BATCH_GROUP_CHILD_PREVIEW_LIMIT = 10;

interface AuditGroupToken {
  processName: string;
  entityType: string;
  action: string;
  startTime: string;
  endTime: string;
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
): Promise<{ rows: AuditLogFeedItem[]; total: number }> {
  if (filter.expand) {
    return getAuditLogGroupChildren(tenantDb, userRole, filter);
  }

  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = ((filter.page ?? 1) - 1) * limit;
  const conditions: SQL[] = [buildDedupCondition()];

  if (filter.entityType) {
    conditions.push(sql`al.entity_type = ${filter.entityType}`);
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

  const where = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);
  const countResult = await tenantDb.execute(
    buildGroupedFeedCountSql(where)
  );
  const countRows = ((countResult as unknown) as { rows?: Array<{ total: number }> }).rows ?? [];
  const total = Number(countRows[0]?.total ?? 0);

  const dataResult = await tenantDb.execute(buildGroupedFeedDataSql(where, limit, offset));

  const dataRows = ((dataResult as unknown) as { rows?: Array<Record<string, unknown>> }).rows ?? [];
  return {
    rows: dataRows.map((row) => mapFeedItem(row, userRole)),
    total,
  };
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
    conditions.push(sql`al.entity_type = ${filter.entityType}`);
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
  const offset = ((filter.page ?? 1) - 1) * limit;
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

function buildGroupedFeedCte(where: SQL): SQL {
  return sql`
    WITH base AS (
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
    ),
    lagged AS (
      SELECT
        base.*,
        LAG(actor_system_process) OVER (ORDER BY created_at DESC, id DESC) AS previous_actor_system_process,
        LAG(entity_type) OVER (ORDER BY created_at DESC, id DESC) AS previous_entity_type,
        LAG(action) OVER (ORDER BY created_at DESC, id DESC) AS previous_action,
        LAG(created_at) OVER (ORDER BY created_at DESC, id DESC) AS previous_created_at
      FROM base
    ),
    keyed AS (
      SELECT
        lagged.*,
        SUM(
          CASE
            WHEN actor_system_process IS NULL THEN 1
            WHEN previous_actor_system_process IS DISTINCT FROM actor_system_process THEN 1
            WHEN previous_entity_type IS DISTINCT FROM entity_type THEN 1
            WHEN previous_action IS DISTINCT FROM action THEN 1
            WHEN ABS(EXTRACT(EPOCH FROM (created_at - previous_created_at))) > ${DEFAULT_BATCH_GROUP_GAP_SECONDS} THEN 1
            ELSE 0
          END
        ) OVER (ORDER BY created_at DESC, id DESC) AS group_key
      FROM lagged
    ),
    group_stats AS (
      SELECT
        group_key,
        actor_system_process,
        entity_type,
        action,
        MIN(created_at) AS start_time,
        MAX(created_at) AS end_time,
        MAX(created_at) AS sort_at,
        COUNT(*)::int AS total_count,
        COUNT(DISTINCT record_id)::int AS distinct_entity_count,
        to_jsonb((array_agg(jsonb_build_object('name', entity_name, 'snapshot', entity_secondary_id_snapshot) ORDER BY created_at DESC, id DESC))[1:5]) AS preview_entities,
        to_jsonb((array_agg(to_jsonb(keyed) ORDER BY created_at DESC, id DESC))[1:${DEFAULT_BATCH_GROUP_CHILD_PREVIEW_LIMIT}]) AS child_entries
      FROM keyed
      WHERE actor_system_process IS NOT NULL
      GROUP BY group_key, actor_system_process, entity_type, action
      HAVING COUNT(*) >= ${DEFAULT_BATCH_GROUP_MIN_SIZE}
    ),
    feed_items AS (
      SELECT
        'group' AS item_type,
        NULL::int AS id,
        group_stats.action,
        group_stats.entity_type,
        NULL::text AS entity_name,
        NULL::text AS entity_secondary_id_snapshot,
        group_stats.actor_system_process,
        NULL::text AS record_id,
        NULL::text AS actor_label,
        'system' AS actor_type,
        NULL::jsonb AS field_changes_jsonb,
        NULL::text AS visibility_scope,
        group_stats.sort_at AS created_at,
        group_stats.start_time,
        group_stats.end_time,
        group_stats.total_count,
        group_stats.distinct_entity_count,
        group_stats.preview_entities,
        group_stats.child_entries
      FROM group_stats

      UNION ALL

      SELECT
        'single' AS item_type,
        keyed.id,
        keyed.action,
        keyed.entity_type,
        keyed.entity_name,
        keyed.entity_secondary_id_snapshot::text,
        keyed.actor_system_process,
        keyed.record_id::text,
        keyed.actor_label,
        keyed.actor_type,
        keyed.field_changes_jsonb,
        keyed.visibility_scope,
        keyed.created_at,
        NULL::timestamptz AS start_time,
        NULL::timestamptz AS end_time,
        NULL::int AS total_count,
        NULL::int AS distinct_entity_count,
        NULL::jsonb AS preview_entities,
        NULL::jsonb AS child_entries
      FROM keyed
      LEFT JOIN group_stats ON group_stats.group_key = keyed.group_key
      WHERE group_stats.group_key IS NULL
    )
  `;
}

function buildGroupedFeedCountSql(where: SQL): SQL {
  return sql`
    ${buildGroupedFeedCte(where)}
    SELECT COUNT(*)::int AS total FROM feed_items
  `;
}

function buildGroupedFeedDataSql(where: SQL, limit: number, offset: number): SQL {
  return sql`
    ${buildGroupedFeedCte(where)}
    SELECT *
    FROM feed_items
    ORDER BY created_at DESC, id DESC NULLS LAST
    LIMIT ${limit} OFFSET ${offset}
  `;
}

function buildDedupCondition(): SQL {
  return sql`
    NOT (
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

function mapFeedItem(row: Record<string, unknown>, userRole: UserRole): AuditLogFeedItem {
  if (row.item_type === "group") {
    const processName = String(row.actor_system_process ?? "System Process");
    const startTime = row.start_time instanceof Date ? row.start_time.toISOString() : String(row.start_time);
    const endTime = row.end_time instanceof Date ? row.end_time.toISOString() : String(row.end_time);
    const entityType = String(row.entity_type ?? "record");
    const action = String(row.action ?? "update");
    const previewEntities = Array.isArray(row.preview_entities)
      ? (row.preview_entities as Array<{ name: string; snapshot: string | null }>)
      : [];
    const childRows = Array.isArray(row.child_entries) ? (row.child_entries as Array<Record<string, unknown>>) : [];

    return {
      type: "group",
      id: encodeAuditGroupId({ processName, entityType, action, startTime, endTime }),
      processName,
      startTime,
      endTime,
      totalCount: Number(row.total_count ?? 0),
      distinctEntityCount: Number(row.distinct_entity_count ?? 0),
      entityType,
      action,
      previewEntities,
      childEntries: childRows.map((childRow) => mapAuditRow({
        ...childRow,
        actor_label: childRow.actor_label ?? processName,
        actor_type: "system",
      }, userRole)),
    };
  }

  return mapAuditRow(row, userRole);
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
