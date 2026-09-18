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
  // Whitelist of photo ids — when set, the timeline returns ONLY these photos (used by subset
  // public-share tokens). Empty/undefined = no whitelist (all photos in scope).
  photoIds?: string[];
}

function normalizeList(values?: string[]): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

export function describeDealPhotoTimelineFilters(filters: DealPhotoTimelineFilters): string[] {
  const categories = normalizeList(filters.categories);
  const tags = normalizeList(filters.tags).map((tag) => tag.toLowerCase());
  const uploaderIds = normalizeList(filters.uploaderIds);
  const keys = ["deal_scope", "file_category", "file_mime", "active_file", "latest_version"];

  if (!filters.includeDeleted) keys.push("deleted_at");
  if (categories.length > 0) keys.push("photo_category");
  if (tags.length > 0) keys.push("tags");
  if (uploaderIds.length > 0) keys.push("uploaded_by");
  if (filters.from || filters.to) keys.push("taken_at", "created_at");
  if (normalizeList(filters.photoIds).length > 0) keys.push("photo_ids");

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
//
// WHY TWO CORRELATED SUBQUERIES AND NOT ONE COALESCE EQUALITY. The direct spelling of "same family",
//   COALESCE(f2.parent_file_id, f2.id) = COALESCE(files.parent_file_id, files.id)
// is what this helper used to say. It reads well and is unindexable: the inner side is an expression over
// two columns, so no index can serve it and Postgres can only satisfy it by hashing the ENTIRE files
// table. Every caller paid a full Seq Scan of all ~80k rows — including the count(*) that
// getDealPhotoTimeline runs once per page — and the hash join also destroyed the index ordering, so the
// deal's whole photo set had to be sorted before LIMIT could take 200 of it. On a 7,708-photo deal the
// field gallery walks 39 pages, which meant 78 full scans of `files` to open one gallery.
//
// The family has exactly two halves, and each one IS indexable on the inner side:
//   1. a CHILD of this row's family root holding a higher active version  -> files_version_chain_idx
//   2. the family ROOT itself holding a higher active version             -> files_pkey
// Splitting it that way lets the planner do correlated index lookups per row and leaves
// files_photo_timeline_idx free to supply the ORDER BY, so LIMIT stops early instead of materializing
// the deal. Measured with EXPLAIN ANALYZE on production (office_dallas, 79,784 files rows, a
// 7,708-photo deal) against the FULL condition set this builder emits and the real
// `ORDER BY COALESCE(taken_at, created_at) DESC, id ASC`:
//   page 1       36.6ms -> 1.34ms   (Parallel Hash Anti Join + Parallel Seq Scan -> Nested Loop Anti
//                                    Join; the index scan now reads 201 rows, not all 7,708)
//   page 39     106.3ms -> 18.7ms   (deep OFFSET, the worst page of the gallery's 39-page walk)
//   count(*)    100.9ms -> 19.1ms   (the Seq Scan of all 79,784 rows is gone)
//
// `family_root.parent_file_id IS NULL` in (2) is load-bearing, not a tidy-up. The old expression matched
// a row by id ONLY when that row's own parent_file_id was NULL — otherwise its COALESCE resolved to the
// parent, not to its id — so dropping the guard would treat a NESTED chain (root <- v2 <- v3) as one
// family where the old predicate did not. uploadNewVersion never writes such a chain, but nothing in the
// schema forbids one, and a predicate that silently changes meaning on data it merely hasn't seen yet is
// how a "pure performance" edit turns into a correctness bug. Equivalence of the two spellings is proven
// over every family shape — flat, nested, inactive, self-parent, tied versions — in
// server/tests/modules/files/latest-version-predicate-equivalence.runtime.test.ts.
//
// Parenthesized as a whole so it stays one logical unit: callers compose it with and()/OR fragments, and
// an unwrapped `A AND B` would bind wrong the first time somebody drops it into an or().
export function latestActiveVersionCondition(): SQL {
  return sql`(NOT EXISTS (
    SELECT 1 FROM files newer_child
    WHERE newer_child.parent_file_id = COALESCE(files.parent_file_id, files.id)
      AND newer_child.is_active = true
      AND newer_child.version > files.version
  ) AND NOT EXISTS (
    SELECT 1 FROM files family_root
    WHERE family_root.id = COALESCE(files.parent_file_id, files.id)
      AND family_root.parent_file_id IS NULL
      AND family_root.is_active = true
      AND family_root.version > files.version
  ))`;
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
    // category='photo' is a FILING choice, not a fact about the bytes — the CRM uploader will happily put a
    // PDF in the Photos category. Such a row still gets a thumbnail (confirmUpload rasterizes page 1 to a
    // JPEG when the image thumbnailer misses), so it renders a perfectly good tile in the grid while its
    // full-size URL is a PDF no image view can decode: a black frame with no error, since the URL is not
    // null. Same shape for any other non-image filed here. mime_type is NOT NULL, so this needs no null
    // branch. Anything that isn't an image cannot render in a photo gallery, so it does not belong in one.
    sql`${files.mimeType} ILIKE 'image/%'`,
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

  const photoIds = normalizeList(filters.photoIds);
  if (photoIds.length > 0) {
    conditions.push(inArray(files.id, photoIds));
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
