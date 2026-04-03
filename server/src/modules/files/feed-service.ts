import { eq, and, desc, gte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { files, deals } from "@trock-crm/shared/schema";
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
  photos: Array<typeof files.$inferSelect>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 40;
  const offset = (page - 1) * limit;

  const conditions: ReturnType<typeof eq>[] = [
    eq(files.category, "photo"),
    eq(files.isActive, true),
    // Exclude superseded versions
    sql`NOT EXISTS (SELECT 1 FROM files f2 WHERE f2.parent_file_id = files.id AND f2.is_active = true)` as any,
  ];

  // RBAC: reps only see photos from their assigned deals
  if (userRole === "rep") {
    conditions.push(
      sql`${files.dealId} IN (SELECT id FROM deals WHERE assigned_rep_id = ${userId}::uuid AND is_active = TRUE)` as any
    );
  }

  if (filters.dealId) conditions.push(eq(files.dealId, filters.dealId));
  if (filters.uploadedBy) conditions.push(eq(files.uploadedBy, filters.uploadedBy));
  if (filters.subcategory) conditions.push(eq(files.subcategory, filters.subcategory));

  if (filters.dateFrom) {
    conditions.push(
      sql`COALESCE(${files.takenAt}, ${files.createdAt}) >= ${filters.dateFrom}::timestamptz` as any
    );
  }
  if (filters.dateTo) {
    conditions.push(
      sql`COALESCE(${files.takenAt}, ${files.createdAt}) <= ${filters.dateTo}::timestamptz` as any
    );
  }

  const where = and(...conditions);

  const [countResult, photoRows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(files).where(where),
    tenantDb
      .select()
      .from(files)
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
 * Count photos created on or after `since`.
 * Same RBAC filter as getPhotoFeed — reps only see photos from their assigned deals.
 */
export async function getNewPhotoCount(
  tenantDb: TenantDb,
  userRole: string,
  userId: string,
  since: Date
): Promise<number> {
  const conditions: ReturnType<typeof eq>[] = [
    eq(files.category, "photo"),
    eq(files.isActive, true),
    gte(files.createdAt, since),
  ];

  if (userRole === "rep") {
    conditions.push(
      sql`${files.dealId} IN (SELECT id FROM deals WHERE assigned_rep_id = ${userId}::uuid AND is_active = TRUE)` as any
    );
  }

  const [result] = await tenantDb
    .select({ count: sql<number>`count(*)` })
    .from(files)
    .where(and(...conditions));

  return Number(result?.count ?? 0);
}
