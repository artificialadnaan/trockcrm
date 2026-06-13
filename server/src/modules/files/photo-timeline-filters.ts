import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, files } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export interface DealPhotoTimelineFilters {
  categories?: string[];
  tags?: string[];
  uploaderIds?: string[];
  from?: string;
  to?: string;
  includeDeleted?: boolean;
}

function normalizeList(values?: string[]): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

export function describeDealPhotoTimelineFilters(filters: DealPhotoTimelineFilters): string[] {
  const categories = normalizeList(filters.categories);
  const tags = normalizeList(filters.tags).map((tag) => tag.toLowerCase());
  const uploaderIds = normalizeList(filters.uploaderIds);
  const keys = ["deal_scope", "file_category", "active_file", "latest_version"];

  if (!filters.includeDeleted) keys.push("deleted_at");
  if (categories.length > 0) keys.push("photo_category");
  if (tags.length > 0) keys.push("tags");
  if (uploaderIds.length > 0) keys.push("uploaded_by");
  if (filters.from || filters.to) keys.push("taken_at", "created_at");

  return keys;
}

// "Latest active version" predicate for a `files`-rooted query. uploadNewVersion stores EVERY version
// with parent_file_id = ROOT id (a flat chain, not root<-v2<-v3), and version is `integer NOT NULL
// default 1`. So the previous `NOT EXISTS (child WHERE parent_file_id = files.id)` check only excluded
// the ROOT — an intermediate v2 (no child points at it) wrongly read as latest once v3 existed.
// This checks the whole version family — COALESCE(parent_file_id, id) groups root + all its children —
// and excludes a row when any ACTIVE family member has a higher version. Single source of truth for the
// timeline/viewer/mint AND the public-share asset/download, so they can never disagree on "latest".
// Relies on the outer query being `FROM files` (matches the existing inline usage).
export function latestActiveVersionCondition(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM files f2
    WHERE COALESCE(f2.parent_file_id, f2.id) = COALESCE(files.parent_file_id, files.id)
      AND f2.is_active = true
      AND f2.version > files.version
  )`;
}

async function buildDealPhotoScopeCondition(tenantDb: TenantDb, dealId: string): Promise<SQL> {
  const [deal] = await tenantDb
    .select({ sourceLeadId: deals.sourceLeadId })
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);

  if (!deal?.sourceLeadId) {
    return eq(files.dealId, dealId);
  }

  return or(eq(files.dealId, dealId), eq(files.leadId, deal.sourceLeadId))!;
}

export async function buildDealPhotoTimelineConditions(
  tenantDb: TenantDb,
  dealId: string,
  filters: DealPhotoTimelineFilters
): Promise<SQL> {
  const categories = normalizeList(filters.categories);
  const tags = normalizeList(filters.tags).map((tag) => tag.toLowerCase());
  const uploaderIds = normalizeList(filters.uploaderIds);
  const concreteCategories = categories.filter((category) => category !== "uncategorized");
  const wantsUncategorized = categories.includes("uncategorized");

  const conditions: SQL[] = [
    await buildDealPhotoScopeCondition(tenantDb, dealId),
    eq(files.category, "photo"),
    eq(files.isActive, true),
    latestActiveVersionCondition(),
  ];

  if (!filters.includeDeleted) {
    conditions.push(isNull(files.deletedAt));
  }

  if (categories.length > 0) {
    const categoryConditions: SQL[] = [];
    if (concreteCategories.length > 0) {
      categoryConditions.push(inArray(files.photoCategory, concreteCategories as any));
      categoryConditions.push(inArray(sql`LOWER(${files.subcategory})`, concreteCategories));
    }
    if (wantsUncategorized) {
      categoryConditions.push(and(isNull(files.photoCategory), isNull(files.subcategory))!);
    }
    conditions.push(or(...categoryConditions)!);
  }

  if (uploaderIds.length > 0) {
    conditions.push(inArray(files.uploadedBy, uploaderIds));
  }

  if (tags.length > 0) {
    conditions.push(sql`EXISTS (
      SELECT 1
      FROM unnest(COALESCE(${files.tags}, ARRAY[]::text[])) AS photo_tag(tag)
      WHERE LOWER(photo_tag.tag) = ANY(${tags})
    )`);
  }

  if (filters.from) {
    conditions.push(sql`COALESCE(${files.takenAt}, ${files.createdAt}) >= ${filters.from}::date`);
  }
  if (filters.to) {
    conditions.push(sql`COALESCE(${files.takenAt}, ${files.createdAt}) < (${filters.to}::date + INTERVAL '1 day')`);
  }

  return and(...conditions)!;
}
