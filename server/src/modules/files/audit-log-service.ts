import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { PHOTO_AUDIT_EVENT_TYPES, type PhotoAuditEventType } from "@trock-crm/shared/types";

type TenantDb = NodePgDatabase<typeof schema>;

export interface LogPhotoEventParams {
  photoId: string;
  eventType: PhotoAuditEventType;
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PhotoAuditEventRow {
  id: string;
  eventType: PhotoAuditEventType;
  userId: string;
  userName: string | null;
  userAvatarUrl: string | null;
  createdAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  photo?: {
    id: string;
    displayName: string;
    fileExtension: string | null;
    r2Key: string | null;
    externalUrl: string | null;
    externalThumbnailUrl: string | null;
  } | null;
  deal?: {
    id: string;
    name: string;
    dealNumber: string;
  } | null;
}

export interface AdminPhotoAuditFilter {
  userIds?: string[];
  eventTypes?: PhotoAuditEventType[];
  from?: string;
  to?: string;
  dealId?: string;
  photoId?: string;
  procoreSyncStatuses?: string[];
  page?: number;
  perPage?: number;
}

export async function logPhotoEvent(
  tenantDb: Pick<TenantDb, "insert">,
  params: LogPhotoEventParams
): Promise<void> {
  try {
    await tenantDb.insert(schema.photoAuditLog).values({
      photoId: params.photoId,
      eventType: params.eventType,
      userId: params.userId,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      metadata: params.metadata ?? {},
    });
  } catch (err) {
    console.error(
      "[photo-audit] Failed to write photo audit event",
      {
        photoId: params.photoId,
        eventType: params.eventType,
        userId: params.userId,
      },
      err
    );
  }
}

export function parseCsvQueryParam(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parsePhotoAuditEventTypes(value: unknown): PhotoAuditEventType[] {
  const allowed = new Set<string>(PHOTO_AUDIT_EVENT_TYPES);
  return parseCsvQueryParam(value).filter((entry): entry is PhotoAuditEventType => allowed.has(entry));
}

export function normalizePhotoAuditRow(row: any): PhotoAuditEventRow {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return {
    id: row.id,
    eventType: row.event_type,
    userId: row.user_id,
    userName: row.user_name ?? null,
    userAvatarUrl: row.user_avatar_url ?? null,
    createdAt,
    ipAddress: row.ip_address ?? null,
    userAgent: row.user_agent ?? null,
    metadata: row.metadata ?? {},
    photo: row.photo_id
      ? {
          id: row.photo_id,
          displayName: row.photo_display_name,
          fileExtension: row.photo_file_extension ?? null,
          r2Key: row.photo_r2_key ?? null,
          externalUrl: row.photo_external_url ?? null,
          externalThumbnailUrl: row.photo_external_thumbnail_url ?? null,
        }
      : null,
    deal: row.deal_id
      ? {
          id: row.deal_id,
          name: row.deal_name,
          dealNumber: row.deal_number,
        }
      : null,
  };
}

export async function getPhotoAuditEvents(
  tenantDb: TenantDb,
  photoId: string
): Promise<PhotoAuditEventRow[]> {
  const result = await tenantDb.execute(sql`
    SELECT
      pal.id,
      pal.event_type,
      pal.user_id,
      u.display_name AS user_name,
      u.avatar_url AS user_avatar_url,
      pal.created_at,
      pal.ip_address,
      pal.user_agent,
      pal.metadata
    FROM photo_audit_log pal
    LEFT JOIN public.users u ON u.id = pal.user_id
    WHERE pal.photo_id = ${photoId}::uuid
    ORDER BY pal.created_at DESC
  `);
  const rows = (result as any).rows ?? result;
  return rows.map(normalizePhotoAuditRow);
}

function buildAdminConditions(filter: AdminPhotoAuditFilter): SQL[] {
  const conditions: SQL[] = [sql`1=1`];
  if (filter.userIds?.length) {
    conditions.push(sql`pal.user_id IN (${sql.join(filter.userIds.map((userId) => sql`${userId}::uuid`), sql`, `)})`);
  }
  if (filter.eventTypes?.length) {
    conditions.push(sql`pal.event_type IN (${sql.join(filter.eventTypes.map((eventType) => sql`${eventType}`), sql`, `)})`);
  }
  if (filter.from) conditions.push(sql`pal.created_at >= ${filter.from}::timestamptz`);
  if (filter.to) conditions.push(sql`pal.created_at <= (${filter.to}::date + INTERVAL '1 day')::timestamptz`);
  if (filter.dealId) conditions.push(sql`f.deal_id = ${filter.dealId}::uuid`);
  if (filter.photoId) conditions.push(sql`pal.photo_id = ${filter.photoId}::uuid`);
  if (filter.procoreSyncStatuses?.length) {
    conditions.push(sql`f.procore_sync_status IN (${sql.join(filter.procoreSyncStatuses.map((status) => sql`${status}`), sql`, `)})`);
  }
  return conditions;
}

export async function getAdminPhotoAuditEvents(
  tenantDb: TenantDb,
  filter: AdminPhotoAuditFilter
): Promise<{ events: PhotoAuditEventRow[]; total: number; page: number; perPage: number }> {
  const requestedPage = Number.isFinite(filter.page) ? filter.page! : 1;
  const requestedPerPage = Number.isFinite(filter.perPage) ? filter.perPage! : 50;
  const page = Math.max(1, requestedPage);
  const perPage = Math.min(Math.max(1, requestedPerPage), 200);
  const offset = (page - 1) * perPage;
  const where = buildAdminConditions(filter).reduce((acc, condition) => sql`${acc} AND ${condition}`);

  const countResult = await tenantDb.execute(sql`
    SELECT COUNT(*)::int AS total
    FROM photo_audit_log pal
    JOIN files f ON f.id = pal.photo_id
    WHERE ${where}
  `);
  const countRows = (countResult as any).rows ?? countResult;
  const total = Number(countRows[0]?.total ?? 0);

  const dataResult = await tenantDb.execute(sql`
    SELECT
      pal.id,
      pal.event_type,
      pal.user_id,
      u.display_name AS user_name,
      u.avatar_url AS user_avatar_url,
      pal.created_at,
      pal.ip_address,
      pal.user_agent,
      pal.metadata,
      f.id AS photo_id,
      f.display_name AS photo_display_name,
      f.file_extension AS photo_file_extension,
      f.r2_key AS photo_r2_key,
      f.external_url AS photo_external_url,
      f.external_thumbnail_url AS photo_external_thumbnail_url,
      d.id AS deal_id,
      d.name AS deal_name,
      d.deal_number AS deal_number
    FROM photo_audit_log pal
    JOIN files f ON f.id = pal.photo_id
    LEFT JOIN public.users u ON u.id = pal.user_id
    LEFT JOIN deals d ON d.id = f.deal_id
    WHERE ${where}
    ORDER BY pal.created_at DESC
    LIMIT ${perPage} OFFSET ${offset}
  `);
  const dataRows = (dataResult as any).rows ?? dataResult;

  return {
    events: dataRows.map(normalizePhotoAuditRow),
    total,
    page,
    perPage,
  };
}
