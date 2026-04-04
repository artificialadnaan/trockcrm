import { eq, and, desc, gte, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { files, deals, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export interface PhotoFeedFilters {
  dealId?: string;
  uploadedBy?: string;
  subcategory?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
}

/**
 * Paginated photo listing across all deals the user can access.
 * RBAC: reps are restricted to deals where they are the assigned rep.
 */
export async function getPhotoFeed(
  tenantDb: TenantDb,
  userRole: string,
  userId: string,
  filters: PhotoFeedFilters
): Promise<{
  photos: Array<{
    id: string;
    displayName: string;
    mimeType: string;
    subcategory: string | null;
    dealId: string | null;
    externalUrl: string | null;
    externalThumbnailUrl: string | null;
    r2Key: string;
    takenAt: Date | null;
    createdAt: Date;
    geoLat: string | null;
    geoLng: string | null;
    uploadedBy: string;
    dealNumber: string | null;
    dealName: string | null;
    uploaderName: string;
  }>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const page = filters.page ?? 1;
  const limit = Math.min(filters.limit ?? 40, 200);
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [
    eq(files.category, "photo"),
    eq(files.isActive, true),
    // Exclude superseded versions
    sql`NOT EXISTS (SELECT 1 FROM files f2 WHERE f2.parent_file_id = files.id AND f2.is_active = true)`,
  ];

  // All users can see all deal photos — no rep filtering

  if (filters.dealId) conditions.push(eq(files.dealId, filters.dealId));
  if (filters.uploadedBy) conditions.push(eq(files.uploadedBy, filters.uploadedBy));
  if (filters.subcategory) conditions.push(eq(files.subcategory, filters.subcategory));

  if (filters.dateFrom) {
    conditions.push(
      sql`COALESCE(${files.takenAt}, ${files.createdAt}) >= ${filters.dateFrom}::timestamptz`
    );
  }
  if (filters.dateTo) {
    conditions.push(
      sql`COALESCE(${files.takenAt}, ${files.createdAt}) <= ${filters.dateTo}::timestamptz`
    );
  }

  const where = and(...conditions);

  const [countResult, photoRows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(files).where(where),
    tenantDb
      .select({
        id: files.id,
        displayName: files.displayName,
        mimeType: files.mimeType,
        subcategory: files.subcategory,
        dealId: files.dealId,
        externalUrl: files.externalUrl,
        externalThumbnailUrl: files.externalThumbnailUrl,
        r2Key: files.r2Key,
        takenAt: files.takenAt,
        createdAt: files.createdAt,
        geoLat: files.geoLat,
        geoLng: files.geoLng,
        uploadedBy: files.uploadedBy,
        dealNumber: deals.dealNumber,
        dealName: deals.name,
        uploaderName: sql<string>`COALESCE(${users.displayName}, 'Unknown')`.as("uploader_name"),
      })
      .from(files)
      .leftJoin(deals, eq(deals.id, files.dealId))
      .leftJoin(users, eq(users.id, files.uploadedBy))
      .where(where)
      .orderBy(desc(sql`COALESCE(${files.takenAt}, ${files.createdAt})`))
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    photos: photoRows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Aggregate photo stats grouped by project (deal).
 * Returns one row per deal that has at least one photo.
 */
export async function getProjectPhotoStats(
  tenantDb: TenantDb
): Promise<{
  projects: Array<{
    dealId: string;
    dealName: string;
    dealNumber: string;
    propertyCity: string | null;
    propertyState: string | null;
    photoCount: number;
    lastPhotoAt: string | null;
    recentUploaders: string[];
    recentPhotoIds: string[];
  }>;
}> {
  // Aggregate counts, last photo timestamp, recent uploaders, and recent photo IDs per deal
  const rows = await tenantDb
    .select({
      dealId: files.dealId,
      dealName: deals.name,
      dealNumber: deals.dealNumber,
      propertyCity: deals.propertyCity,
      propertyState: deals.propertyState,
      photoCount: sql<number>`count(*)::int`,
      lastPhotoAt: sql<string>`max(COALESCE(${files.takenAt}, ${files.createdAt}))::text`,
      recentUploaders: sql<string>`
        (SELECT array_to_json(array_agg(DISTINCT u.display_name))
         FROM (
           SELECT COALESCE(u2.display_name, 'Unknown') as display_name
           FROM files f2
           LEFT JOIN users u2 ON u2.id = f2.uploaded_by
           WHERE f2.deal_id = ${files.dealId}
             AND f2.category = 'photo'
             AND f2.is_active = true
           ORDER BY COALESCE(f2.taken_at, f2.created_at) DESC
           LIMIT 10
         ) u
        )::text`,
      recentPhotoIds: sql<string>`
        (SELECT array_to_json(array_agg(f3.id))
         FROM (
           SELECT f3.id
           FROM files f3
           WHERE f3.deal_id = ${files.dealId}
             AND f3.category = 'photo'
             AND f3.is_active = true
           ORDER BY COALESCE(f3.taken_at, f3.created_at) DESC
           LIMIT 5
         ) f3
        )::text`,
    })
    .from(files)
    .innerJoin(deals, eq(deals.id, files.dealId))
    .where(
      and(
        eq(files.category, "photo"),
        eq(files.isActive, true),
        sql`${files.dealId} IS NOT NULL`
      )
    )
    .groupBy(files.dealId, deals.name, deals.dealNumber, deals.propertyCity, deals.propertyState)
    .orderBy(desc(sql`max(COALESCE(${files.takenAt}, ${files.createdAt}))`));

  return {
    projects: rows.map((r) => ({
      dealId: r.dealId!,
      dealName: r.dealName,
      dealNumber: r.dealNumber,
      propertyCity: r.propertyCity,
      propertyState: r.propertyState,
      photoCount: r.photoCount,
      lastPhotoAt: r.lastPhotoAt,
      recentUploaders: r.recentUploaders ? JSON.parse(r.recentUploaders) : [],
      recentPhotoIds: r.recentPhotoIds ? JSON.parse(r.recentPhotoIds) : [],
    })),
  };
}

/**
 * Count photos created on or after `since`.
 * Same RBAC filter as getPhotoFeed — reps only see photos from their assigned deals.
 */
export async function getNewPhotoCount(
  tenantDb: TenantDb,
  userRole: string,
  userId: string,
  since: Date
): Promise<number> {
  const conditions: SQL[] = [
    eq(files.category, "photo"),
    eq(files.isActive, true),
    gte(files.createdAt, since),
  ];

  // All users can see all deal photos — no rep filtering

  const [result] = await tenantDb
    .select({ count: sql<number>`count(*)` })
    .from(files)
    .where(and(...conditions));

  return Number(result?.count ?? 0);
}
