import crypto from "crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { db, pool } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { getFileDownloadUrl, getDealPhotoTimeline } from "../files/service.js";
import { logPhotoEvent } from "../files/audit-log-service.js";
import type { DealPhotoTimelineFilters } from "../files/photo-timeline-filters.js";

type TenantDb = NodePgDatabase<typeof schema>;

const PUBLIC_TOKEN_BYTES = 32;

export type PublicTokenStatus = "active" | "expired" | "revoked";

export function generateRawPublicToken(): string {
  return crypto.randomBytes(PUBLIC_TOKEN_BYTES).toString("base64url");
}

export function hashPublicPhotoToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function tokenStatus(row: { revoked_at?: Date | string | null; expires_at?: Date | string | null }, now = new Date()): PublicTokenStatus {
  if (row.revoked_at) return "revoked";
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return "expired";
  return "active";
}

export async function generatePublicToken(input: {
  dealId: string;
  createdByUserId: string;
  tenantId: string;
  expiresAt?: Date | null;
}): Promise<{ rawToken: string; token: { id: string; dealId: string; tenantId: string; expiresAt: string | null } }> {
  const rawToken = generateRawPublicToken();
  const tokenHash = hashPublicPhotoToken(rawToken);
  const result = await db.execute(sql`
    INSERT INTO public.public_photo_tokens (token, deal_id, tenant_id, created_by_user_id, expires_at)
    VALUES (${tokenHash}, ${input.dealId}::uuid, ${input.tenantId}::uuid, ${input.createdByUserId}::uuid, ${input.expiresAt ?? null})
    RETURNING id, deal_id, tenant_id, expires_at
  `);
  const row = ((result as any).rows ?? result)[0];
  return {
    rawToken,
    token: {
      id: row.id,
      dealId: row.deal_id,
      tenantId: row.tenant_id,
      expiresAt: normalizeDate(row.expires_at),
    },
  };
}

export async function verifyAndConsumeToken(rawToken: string): Promise<{
  tokenId: string;
  dealId: string;
  tenantId: string;
  createdByUserId: string;
}> {
  const tokenHash = hashPublicPhotoToken(rawToken);
  const result = await db.execute(sql`
    UPDATE public.public_photo_tokens
    SET access_count = access_count + 1,
        last_accessed_at = now()
    WHERE token = ${tokenHash}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    RETURNING id, deal_id, tenant_id, created_by_user_id
  `);
  const row = ((result as any).rows ?? result)[0];
  if (!row) throw new AppError(404, "Photo link not found");
  return {
    tokenId: row.id,
    dealId: row.deal_id,
    tenantId: row.tenant_id,
    createdByUserId: row.created_by_user_id,
  };
}

export async function revokeToken(tokenId: string, userId: string, tenantId?: string): Promise<void> {
  const result = await db.execute(sql`
    UPDATE public.public_photo_tokens
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE id = ${tokenId}::uuid
      ${tenantId ? sql`AND tenant_id = ${tenantId}::uuid` : sql``}
    RETURNING id
  `);
  const row = ((result as any).rows ?? result)[0];
  if (!row) throw new AppError(404, "Photo token not found");
  console.info(`[public-photo-token] Token ${tokenId} revoked by ${userId}`);
}

export async function listTokensForDeal(dealId: string, tenantId?: string) {
  const result = await db.execute(sql`
    SELECT
      ppt.id,
      ppt.deal_id,
      ppt.tenant_id,
      ppt.created_by_user_id,
      u.display_name AS created_by_name,
      ppt.created_at,
      ppt.expires_at,
      ppt.revoked_at,
      ppt.last_accessed_at,
      ppt.access_count
    FROM public.public_photo_tokens ppt
    LEFT JOIN public.users u ON u.id = ppt.created_by_user_id
    WHERE ppt.deal_id = ${dealId}::uuid
      ${tenantId ? sql`AND ppt.tenant_id = ${tenantId}::uuid` : sql``}
    ORDER BY ppt.created_at DESC
  `);
  const rows = (result as any).rows ?? result;
  return rows.map((row: any) => ({
    id: row.id,
    dealId: row.deal_id,
    tenantId: row.tenant_id,
    createdBy: {
      id: row.created_by_user_id,
      name: row.created_by_name ?? "Unknown",
    },
    createdAt: normalizeDate(row.created_at)!,
    expiresAt: normalizeDate(row.expires_at),
    revokedAt: normalizeDate(row.revoked_at),
    lastAccessedAt: normalizeDate(row.last_accessed_at),
    accessCount: Number(row.access_count ?? 0),
    status: tokenStatus(row),
  }));
}

async function resolveTenant(tenantId: string): Promise<{ officeId: string; slug: string }> {
  const result = await pool.query(
    "SELECT id, slug FROM public.offices WHERE id = $1 AND is_active = true LIMIT 1",
    [tenantId]
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, "Photo link not found");
  if (!/^[a-z][a-z0-9_]*$/.test(row.slug)) throw new AppError(500, "Invalid office schema");
  return { officeId: row.id, slug: row.slug };
}

export async function withPublicPhotoTenant<T>(
  tenantId: string,
  handler: (tenantDb: TenantDb, tenant: { officeId: string; slug: string }) => Promise<T>
): Promise<T> {
  const tenant = await resolveTenant(tenantId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('search_path', $1, true)", [`office_${tenant.slug},public`]);
    const tenantDb = drizzle(client, { schema }) as TenantDb;
    const value = await handler(tenantDb, tenant);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function publicPhotoShape(photo: any, imageUrl: string | null) {
  return {
    id: photo.id,
    category: "photo",
    photoCategory: photo.photoCategory ?? null,
    subcategory: photo.subcategory ?? null,
    displayName: photo.displayName,
    mimeType: photo.mimeType,
    fileSizeBytes: photo.fileSizeBytes ?? null,
    fileExtension: photo.fileExtension ?? null,
    description: photo.description ?? null,
    takenAt: normalizeDate(photo.takenAt),
    createdAt: normalizeDate(photo.createdAt)!,
    uploadedBy: photo.uploadedBy,
    uploaderName: photo.uploaderName,
    uploaderAvatarUrl: photo.uploaderAvatarUrl ?? null,
    latitude: photo.latitude ?? null,
    longitude: photo.longitude ?? null,
    address: photo.address ?? null,
    addressSource: photo.addressSource ?? null,
    geocodedAt: normalizeDate(photo.geocodedAt),
    procoreSyncStatus: photo.procoreSyncStatus ?? null,
    imageUrl,
  };
}

export async function getPublicPhotoViewer(rawToken: string, filters: DealPhotoTimelineFilters = {}) {
  const token = await verifyAndConsumeToken(rawToken);
  return withPublicPhotoTenant(token.tenantId, async (tenantDb) => {
    const dealResult = await tenantDb.execute(sql`
      SELECT
        id,
        name,
        deal_number,
        NULLIF(CONCAT_WS(', ', NULLIF(property_address, ''), NULLIF(property_city, ''), NULLIF(property_state, ''), NULLIF(property_zip, '')), '') AS property_address
      FROM deals
      WHERE id = ${token.dealId}::uuid
      LIMIT 1
    `);
    const deal = ((dealResult as any).rows ?? dealResult)[0];
    if (!deal) throw new AppError(404, "Photo link not found");

    const timeline = await getDealPhotoTimeline(tenantDb, token.dealId, 1, 500, {
      ...filters,
      includeDeleted: false,
    });
    const photos = await Promise.all(timeline.photos.map(async (photo) => {
      const imageUrl = photo.externalThumbnailUrl ?? photo.externalUrl ?? (await getFileDownloadUrl(tenantDb, photo.id)).url;
      return publicPhotoShape(photo, imageUrl);
    }));

    return {
      tokenId: token.tokenId,
      deal: {
        id: deal.id,
        name: deal.name,
        dealNumber: deal.deal_number,
        propertyAddress: deal.property_address ?? null,
      },
      photos,
    };
  });
}

export async function getPublicPhotoDownload(rawToken: string, photoId: string, context: {
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const token = await verifyAndConsumeToken(rawToken);
  return withPublicPhotoTenant(token.tenantId, async (tenantDb) => {
    const photoResult = await tenantDb.execute(sql`
      SELECT id, deal_id, category, display_name, file_extension, external_url
      FROM files
      WHERE id = ${photoId}::uuid
        AND deal_id = ${token.dealId}::uuid
        AND category = 'photo'
        AND deleted_at IS NULL
      LIMIT 1
    `);
    const photo = ((photoResult as any).rows ?? photoResult)[0];
    if (!photo) throw new AppError(404, "Photo not found");

    const result = photo.external_url
      ? { url: photo.external_url, filename: `${photo.display_name}${photo.file_extension ?? ""}` }
      : await getFileDownloadUrl(tenantDb, photo.id);

    await logPhotoEvent(tenantDb, {
      photoId: photo.id,
      eventType: "downloaded",
      userId: token.createdByUserId,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      metadata: {
        viaPublicToken: true,
        tokenId: token.tokenId,
      },
    });

    return result;
  });
}
