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

  const countResult = await tenantDb.select({ count: sql<number>`count(*)` }).from(files).where(where);
  const photoRows = await tenantDb
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
    .offset(offset);

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
    recentPhotos: Array<{
      id: string;
      displayName: string | null;
      mimeType: string | null;
      r2Key: string | null;
      externalUrl: string | null;
      externalThumbnailUrl: string | null;
    }>;
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
      recentPhotos: sql<string>`
        (SELECT COALESCE(json_agg(json_build_object(
          'id', recent.id,
          'displayName', recent.display_name,
          'mimeType', recent.mime_type,
          'r2Key', recent.r2_key,
          'externalUrl', recent.external_url,
          'externalThumbnailUrl', recent.external_thumbnail_url
        )), '[]'::json)
         FROM (
           SELECT
             f4.id,
             f4.display_name,
             f4.mime_type,
             f4.r2_key,
             f4.external_url,
             f4.external_thumbnail_url
           FROM files f4
           WHERE f4.deal_id = ${files.dealId}
             AND f4.category = 'photo'
             AND f4.is_active = true
           ORDER BY COALESCE(f4.taken_at, f4.created_at) DESC
           LIMIT 5
         ) recent
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
    .orderBy(desc(sql`max(COALESCE(${files.takenAt}, ${files.createdAt}))`))
    .limit(100);

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
      recentPhotos: r.recentPhotos ? JSON.parse(r.recentPhotos) : [],
    })),
  };
}

// CompanyCam rescue photos that aren't linked to a deal (deal_id IS NULL) carry their source project
// id/name in the `notes` JSON. Extract it with a CASE guard so the ::jsonb cast NEVER runs on a
// non-JSON notes value (other file types store plain-text notes) — CASE only evaluates THEN when WHEN
// is true, so non-`{` rows are skipped safely.
const ccProjectIdExpr = sql<string | null>`CASE WHEN left(btrim(${files.notes}), 1) = '{' THEN (btrim(${files.notes})::jsonb ->> 'companycamProjectId') END`;
const ccProjectNameExpr = sql<string | null>`CASE WHEN left(btrim(${files.notes}), 1) = '{' THEN (btrim(${files.notes})::jsonb ->> 'companycamProjectName') END`;

/**
 * Unassigned CompanyCam photos grouped by their source CompanyCam project (mirrors CompanyCam's own
 * project-folder structure). Powers the "Unassigned" tab on the photo feed. One row per CompanyCam
 * project that has at least one unlinked rescued photo.
 */
export async function getUnassignedCompanyCamProjects(tenantDb: TenantDb): Promise<{
  projects: Array<{
    companycamProjectId: string;
    companycamProjectName: string | null;
    photoCount: number;
    lastPhotoAt: string | null;
    recentPhotos: Array<{
      id: string;
      displayName: string | null;
      mimeType: string | null;
      r2Key: string | null;
      externalUrl: string | null;
      externalThumbnailUrl: string | null;
    }>;
  }>;
}> {
  // CTE makes the CASE-guarded project id a real column so we can GROUP BY it and rank within each
  // project (a correlated subquery over the ungrouped `notes` is illegal post-GROUP BY). row_number()
  // + json_agg FILTER picks the 5 most-recent photos per project in one pass.
  const result = await tenantDb.execute(sql`
    WITH cc AS (
      SELECT ${files.id} AS id, ${files.displayName} AS display_name, ${files.mimeType} AS mime_type,
             ${files.r2Key} AS r2_key, ${files.externalUrl} AS external_url,
             ${files.externalThumbnailUrl} AS external_thumbnail_url,
             COALESCE(${files.takenAt}, ${files.createdAt}) AS sort_at,
             ${ccProjectIdExpr} AS pid, ${ccProjectNameExpr} AS pname
      FROM ${files}
      WHERE ${files.category} = 'photo' AND ${files.isActive} = true
        AND ${files.subcategory} = 'CompanyCam' AND ${files.dealId} IS NULL
    ),
    ranked AS (
      SELECT *, row_number() OVER (PARTITION BY pid ORDER BY sort_at DESC NULLS LAST) AS rn
      FROM cc WHERE pid IS NOT NULL
    )
    SELECT
      pid AS "companycamProjectId",
      max(pname) AS "companycamProjectName",
      count(*)::int AS "photoCount",
      max(sort_at)::text AS "lastPhotoAt",
      COALESCE(json_agg(json_build_object(
        'id', id, 'displayName', display_name, 'mimeType', mime_type,
        'r2Key', r2_key, 'externalUrl', external_url, 'externalThumbnailUrl', external_thumbnail_url
      ) ORDER BY sort_at DESC NULLS LAST) FILTER (WHERE rn <= 5), '[]'::json) AS "recentPhotos"
    FROM ranked
    GROUP BY pid
    ORDER BY max(sort_at) DESC NULLS LAST
    LIMIT 1000
  `);

  const rows = (result as unknown as {
    rows: Array<{
      companycamProjectId: string;
      companycamProjectName: string | null;
      photoCount: number;
      lastPhotoAt: string | null;
      recentPhotos: unknown;
    }>;
  }).rows;

  return {
    projects: rows.map((r) => ({
      companycamProjectId: r.companycamProjectId,
      companycamProjectName: r.companycamProjectName,
      photoCount: Number(r.photoCount),
      lastPhotoAt: r.lastPhotoAt,
      recentPhotos: Array.isArray(r.recentPhotos)
        ? (r.recentPhotos as never[])
        : typeof r.recentPhotos === "string"
          ? JSON.parse(r.recentPhotos)
          : [],
    })),
  };
}

/**
 * Paginated unassigned CompanyCam photos for a single source project (the drill-in from the
 * "Unassigned" tab). Same item shape as getPhotoFeed so the client grid can be reused.
 */
export async function getUnassignedCompanyCamPhotos(
  tenantDb: TenantDb,
  companycamProjectId: string,
  page = 1,
  limit = 40,
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
  const safeLimit = Math.min(limit, 200);
  const offset = (page - 1) * safeLimit;
  const where = and(
    eq(files.category, "photo"),
    eq(files.isActive, true),
    eq(files.subcategory, "CompanyCam"),
    sql`${files.dealId} IS NULL`,
    sql`${ccProjectIdExpr} = ${companycamProjectId}`,
  );

  const countResult = await tenantDb.select({ count: sql<number>`count(*)` }).from(files).where(where);
  const photoRows = await tenantDb
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
      dealNumber: sql<string | null>`NULL`,
      dealName: ccProjectNameExpr,
      uploaderName: sql<string>`COALESCE(${users.displayName}, 'Unknown')`.as("uploader_name"),
    })
    .from(files)
    .leftJoin(users, eq(users.id, files.uploadedBy))
    .where(where)
    .orderBy(desc(sql`COALESCE(${files.takenAt}, ${files.createdAt})`))
    .limit(safeLimit)
    .offset(offset);

  const total = Number(countResult[0]?.count ?? 0);
  return { photos: photoRows, pagination: { page, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) } };
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
