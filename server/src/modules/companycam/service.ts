/**
 * CompanyCam sync service.
 * Fetches projects + photos from CompanyCam, matches projects to deals,
 * downloads photos to R2 storage, and creates file records.
 */

import { eq, and, sql, isNull, isNotNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, files, dealCompanycamProjects } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { getAllProjects, getProjectPhotos } from "./client.js";
import type { CCProject, CCPhoto } from "./client.js";
import { putObject, isR2Configured } from "../../lib/r2-client.js";
import { generateAndStoreThumbnail } from "../../lib/image-thumbnail.js";
import { isBrokenConnectionError } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import crypto from "node:crypto";

type TenantDb = NodePgDatabase<typeof schema>;
type ProgressCallback = (message: string) => void;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectMapping {
  ccProjectId: string;
  ccProjectName: string | null;
  ccPhotoCount: number;
  ccCity: string | null;
  dealId: string | null;
  dealNumber: string | null;
  dealName: string | null;
  matchType: "linked" | "auto" | "unmatched";
}

export interface SyncResult {
  projectId: string;
  projectName: string;
  dealId: string;
  photosImported: number;
  photosSkipped: number;
  errors: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a project name for fuzzy matching.
 */
function normalizeName(name: string | null | undefined): string {
  if (!name) return ""; // null/blank CompanyCam or deal names are not matchable
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the best image URLs from a CompanyCam photo.
 */
function extractUrls(photo: CCPhoto): { original: string | null; thumbnail: string | null } {
  const original = photo.uris.find((u) => u.type === "original")?.uri ?? null;
  const thumbnail = photo.uris.find((u) => u.type === "thumbnail")?.uri
    ?? photo.uris.find((u) => u.type === "web")?.uri
    ?? null;
  return { original, thumbnail };
}

/**
 * Download an image from a URL with a 30-second timeout.
 */
async function downloadImage(url: string): Promise<{ buffer: Buffer; contentType: string; size: number }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  return { buffer, contentType, size: buffer.length };
}

/**
 * Determine file extension from content type.
 */
function extFromMime(contentType: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("heic")) return ".heic";
  if (contentType.includes("heif")) return ".heif";
  if (contentType.includes("gif")) return ".gif";
  return ".jpg";
}

/**
 * Run async tasks with a concurrency limit.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

type PreparedCompanyCamPhoto = {
  photoId: string;
  values: typeof files.$inferInsert;
};

// ─── Service Functions ───────────────────────────────────────────────────────

/**
 * Get all CompanyCam projects with their match status against deals.
 */
export async function getProjectMappings(tenantDb: TenantDb): Promise<ProjectMapping[]> {
  // getAllProjects() is an external CompanyCam HTTP call, so start it concurrently. But the two DB reads
  // both run on `tenantDb` — a single transaction-bound client that executes queries SERIALLY — so awaiting
  // them together via Promise.all gains no real concurrency; it only queues the second behind the first, and
  // the pool-level query_timeout counts that queue wait against the timer. Run the DB reads sequentially.
  const ccProjectsPromise = getAllProjects();
  // If a DB read below throws first, we exit before awaiting ccProjectsPromise — attach a catch now so a
  // later CompanyCam HTTP rejection can't become an unhandled rejection. The real value/rejection is still
  // surfaced by the `await ccProjectsPromise` below on the success path.
  void ccProjectsPromise.catch(() => {});
  const dealRows = await tenantDb
    .select({
      id: deals.id,
      dealNumber: deals.dealNumber,
      name: deals.name,
    })
    .from(deals)
    .where(eq(deals.isActive, true));
  // Every deal <-> CompanyCam-project link (a deal may own many projects). Join to deals so off-deal /
  // inactive-deal links are dropped, mirroring the isActive filter on the deal list above.
  const linkRows = await tenantDb
    .select({
      companycamProjectId: dealCompanycamProjects.companycamProjectId,
      dealId: dealCompanycamProjects.dealId,
    })
    .from(dealCompanycamProjects)
    .innerJoin(
      deals,
      and(eq(deals.id, dealCompanycamProjects.dealId), eq(deals.isActive, true)),
    );
  const ccProjects = await ccProjectsPromise;

  // Index deals by companycam_project_id for linked matches (from the join table — the source of truth).
  const dealById = new Map(dealRows.map((deal) => [deal.id, deal]));
  const linkedMap = new Map<string, typeof dealRows[0]>();
  for (const link of linkRows) {
    const deal = dealById.get(link.dealId);
    if (!deal) continue;
    linkedMap.set(link.companycamProjectId, deal);
  }

  // Build the fuzzy-match name index from ALL active deals — NOT just deals with no link yet. A deal is
  // 1:many to CompanyCam projects, so a deal that already owns ONE project must stay a candidate for OTHER
  // same-named projects (otherwise its 2nd/3rd project can never auto-link). Projects already linked to a
  // deal still surface as matchType 'linked' via linkedMap above; only the DEAL remains a candidate here.
  //
  // BUT a normalized name held by >1 active deal is AMBIGUOUS: auto-linking would silently pick whichever
  // row Postgres returned last (no ORDER BY) and then attach EVERY same-named CompanyCam project to that
  // arbitrary deal. Mirror the CLI import planner (companycam-inventory.ts: exact-name match is reliable
  // ONLY when exactly one deal carries that name) — track ambiguous names in a Set and exclude them from
  // auto-matching so those projects fall through to 'unmatched' (manual review) instead.
  const dealsByNormName = new Map<string, typeof dealRows[0]>();
  const ambiguousNormNames = new Set<string>();
  for (const deal of dealRows) {
    const norm = normalizeName(deal.name);
    if (dealsByNormName.has(norm)) {
      ambiguousNormNames.add(norm);
    } else {
      dealsByNormName.set(norm, deal);
    }
  }

  const mappings: ProjectMapping[] = [];

  for (const proj of ccProjects) {
    if (proj.photo_count === 0) continue;

    const linked = linkedMap.get(proj.id);
    if (linked) {
      mappings.push({
        ccProjectId: proj.id,
        ccProjectName: proj.name,
        ccPhotoCount: proj.photo_count,
        ccCity: proj.address.city,
        dealId: linked.id,
        dealNumber: linked.dealNumber,
        dealName: linked.name,
        matchType: "linked",
      });
      continue;
    }

    const normProjName = normalizeName(proj.name);
    // Skip auto-matching a null/blank-named project (normalizes to "") — it would otherwise tie with
    // any deal whose name also normalizes to "" (e.g. "Project"/"Photos"). Also skip an AMBIGUOUS name
    // (held by >1 active deal): there's no single correct deal, so it goes to manual review ('unmatched').
    const fuzzyMatch =
      normProjName && !ambiguousNormNames.has(normProjName)
        ? dealsByNormName.get(normProjName)
        : undefined;
    if (fuzzyMatch) {
      mappings.push({
        ccProjectId: proj.id,
        ccProjectName: proj.name,
        ccPhotoCount: proj.photo_count,
        ccCity: proj.address.city,
        dealId: fuzzyMatch.id,
        dealNumber: fuzzyMatch.dealNumber,
        dealName: fuzzyMatch.name,
        matchType: "auto",
      });
      // Keep the deal in the index: a deal can own MANY projects (1:many), so additional unlinked
      // projects with the same normalized name should also auto-match it within this one snapshot
      // (autoLinkProjects consumes a single getProjectMappings() result).
      continue;
    }

    mappings.push({
      ccProjectId: proj.id,
      ccProjectName: proj.name,
      ccPhotoCount: proj.photo_count,
      ccCity: proj.address.city,
      dealId: null,
      dealNumber: null,
      dealName: null,
      matchType: "unmatched",
    });
  }

  const order = { linked: 0, auto: 1, unmatched: 2 };
  mappings.sort((a, b) => order[a.matchType] - order[b.matchType] || b.ccPhotoCount - a.ccPhotoCount);

  return mappings;
}

/**
 * Link a CompanyCam project to a deal. Additive: a deal can own many projects, but a project is 1:1 with a
 * deal, so we first clear any prior mapping of THIS project (it may have pointed at a different deal) and
 * then map it to the target deal. Other projects already linked to the target deal are left untouched.
 */
export async function linkProjectToDeal(
  tenantDb: TenantDb,
  ccProjectId: string,
  dealId: string
): Promise<void> {
  // Serialize concurrent (re)links of the SAME project so the LAST writer wins deterministically and no
  // caller is falsely told their link took. Without this, two admins linking the same project to different
  // deals both pass the delete; one insert wins the UNIQUE and the other hits ON CONFLICT DO NOTHING but
  // STILL returns success. We MIRROR the proven mechanism in
  // feed-service.assignUnassignedCompanyCamProjectToDeal: a transaction-scoped advisory lock keyed on the
  // project id (hashtext(ccProjectId)). The lock holds because req.tenantDb is already bound to the
  // request's open transaction — the tenant middleware issues BEGIN and the route commits via
  // commitTransaction — so pg_advisory_xact_lock persists for the rest of the request and auto-releases at
  // commit, exactly as the assign flow relies on. (Deliberately NOT wrapped in tenantDb.transaction():
  // that would issue a nested BEGIN/COMMIT against the already-open request transaction and commit it
  // prematurely.) With the lock held, the delete-then-insert below is atomic relative to other writers, so
  // the insert always lands its own row — the relink/steal semantics (move the project to the target deal)
  // are preserved.
  await tenantDb.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ccProjectId}))`);

  // The join table's deal_id FK would turn a well-formed-but-stale/deleted dealId into a raw 500.
  // Reject it cleanly (404) — the route only validates UUID shape, so verify the deal exists here.
  const [target] = await tenantDb
    .select({ id: deals.id })
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);
  if (!target) throw new AppError(404, "Deal not found");

  await tenantDb
    .delete(dealCompanycamProjects)
    .where(eq(dealCompanycamProjects.companycamProjectId, ccProjectId));

  await tenantDb
    .insert(dealCompanycamProjects)
    .values({ dealId, companycamProjectId: ccProjectId })
    .onConflictDoNothing({ target: dealCompanycamProjects.companycamProjectId });

  // Mirror the link onto the legacy scalar deals.companycam_project_id. This scalar is a DENORMALIZED
  // MIRROR kept only so un-migrated legacy readers (companycam-import/inventory) still detect the link for
  // the single-project case; deal_companycam_projects is the source of truth. #830 migrates those readers
  // and drops the column. For a multi-project deal the scalar holds the most-recent link — an accepted
  // interim (the import-time guard already prevents mis-routing).
  //
  // On a RELINK the PREVIOUS owner's scalar still points at ccProjectId (the join row moved, but the scalar
  // didn't), leaving a stale phantom link that legacy readers would still honor. Clear ANY deal's scalar for
  // this project BEFORE stamping the target, so exactly one deal mirrors the link.
  await tenantDb.update(deals).set({ companycamProjectId: null }).where(eq(deals.companycamProjectId, ccProjectId));
  await tenantDb.update(deals).set({ companycamProjectId: ccProjectId }).where(eq(deals.id, dealId));
}

/**
 * Unlink a CompanyCam project from whatever deal it maps to (deletes the join row for that project).
 */
export async function unlinkProject(
  tenantDb: TenantDb,
  ccProjectId: string
): Promise<void> {
  // Serialize against concurrent (re)links/assigns of the SAME project. unlinkProject mutates the join table
  // AND clears the scalar mirror; without the lock it could interleave with linkProjectToDeal/assign (which
  // take the same project-scoped lock) and leave the join row and scalar out of sync. Same mechanism +
  // request-transaction reasoning as linkProjectToDeal: pg_advisory_xact_lock holds for the rest of the
  // request and auto-releases at commit.
  await tenantDb.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ccProjectId}))`);

  await tenantDb
    .delete(dealCompanycamProjects)
    .where(eq(dealCompanycamProjects.companycamProjectId, ccProjectId));

  // Clear the stale legacy scalar mirror (deals.companycam_project_id) for any deal that still points at
  // this project, so un-migrated legacy readers (companycam-import/inventory) don't keep seeing a link the
  // join table no longer has. The join table is the source of truth; #830 migrates the readers + drops the
  // column. (No-op for a multi-project deal where the scalar already holds a different, more-recent link.)
  await tenantDb
    .update(deals)
    .set({ companycamProjectId: null })
    .where(eq(deals.companycamProjectId, ccProjectId));
}

/**
 * Sync photos from a single CompanyCam project into files table.
 * Downloads each photo to R2, creates file records. Skips duplicates.
 * Processes photos with concurrency limit of 5 for performance.
 */
export async function syncProjectPhotos(
  tenantDb: TenantDb,
  ccProjectId: string,
  systemUserId: string,
  officeSlug: string = "default",
  onProgress?: ProgressCallback
): Promise<SyncResult> {
  const [deal] = await tenantDb
    .select({ id: deals.id, dealNumber: deals.dealNumber, name: deals.name })
    .from(dealCompanycamProjects)
    .innerJoin(deals, eq(deals.id, dealCompanycamProjects.dealId))
    .where(
      and(
        eq(dealCompanycamProjects.companycamProjectId, ccProjectId),
        eq(deals.isActive, true)
      )
    )
    .limit(1);

  if (!deal) {
    throw new Error(`No deal linked to CompanyCam project ${ccProjectId}`);
  }

  onProgress?.(`Fetching photos for ${deal.name}...`);

  const ccPhotos = await getProjectPhotos(ccProjectId);

  // Get existing CompanyCam photo IDs to skip duplicates
  const existingRows = await tenantDb
    .select({ companycamPhotoId: files.companycamPhotoId })
    .from(files)
    .where(
      and(
        eq(files.dealId, deal.id),
        isNotNull(files.companycamPhotoId)
      )
    );

  const existingIds = new Set(existingRows.map((r) => r.companycamPhotoId));

  // Filter out already-imported photos
  const newPhotos = ccPhotos.filter((p) => !existingIds.has(p.id));
  const skipped = ccPhotos.length - newPhotos.length;
  let imported = 0;
  const errors: string[] = [];
  const bucketName = process.env.R2_BUCKET_NAME || "trock-crm-files";
  const useR2 = isR2Configured();

  onProgress?.(`${deal.name}: ${newPhotos.length} new photos to import (${skipped} already synced)`);

  const preparedPhotos = await mapWithConcurrency(newPhotos, 5, async (photo): Promise<PreparedCompanyCamPhoto | null> => {
    try {
      const { original, thumbnail } = extractUrls(photo);
      if (!original) {
        errors.push(`Photo ${photo.id}: no original URL found`);
        return null;
      }

      const capturedAt = photo.captured_at
        ? new Date(photo.captured_at * 1000)
        : new Date(photo.created_at * 1000);

      // Download from CompanyCam CDN
      let fileSizeBytes = 0;
      let mimeType = "image/jpeg";
      let ext = ".jpg";

      if (useR2) {
        const { buffer, contentType, size } = await downloadImage(original);
        fileSizeBytes = size;
        mimeType = contentType;
        ext = extFromMime(contentType);

        const yearMonth = capturedAt.toISOString().slice(0, 7);
        const dateStr = capturedAt.toISOString().split("T")[0];
        const shortId = crypto.randomUUID().slice(0, 8);
        const systemFilename = `${deal.dealNumber}_CompanyCam_${dateStr}_${shortId}${ext}`;
        const r2Key = `office_${officeSlug}/deals/${deal.dealNumber}/photos/${systemFilename}`;

        await putObject(r2Key, buffer, mimeType);

        // Grid thumbnail from the buffer we already hold (no extra R2 round-trip). Best-effort: a miss
        // leaves thumbnailR2Key null and the grid falls back to the full original.
        const thumbnailR2Key = await generateAndStoreThumbnail(r2Key, mimeType, buffer);

        const displayName = `${deal.dealNumber} CompanyCam ${dateStr} ${photo.id.slice(-6)}`;

        return {
          photoId: photo.id,
          values: {
            category: "photo",
            subcategory: "CompanyCam",
            folderPath: `Photos/CompanyCam/${yearMonth}`,
            tags: ["companycam"],
            displayName,
            systemFilename,
            originalFilename: `companycam_${photo.id}${ext}`,
            mimeType,
            fileSizeBytes,
            fileExtension: ext,
            r2Key,
            thumbnailR2Key,
            r2Bucket: bucketName,
            externalUrl: original,
            externalThumbnailUrl: thumbnail,
            companycamPhotoId: photo.id,
            dealId: deal.id,
            description: photo.description,
            takenAt: capturedAt,
            geoLat: photo.coordinates.lat !== 0 ? String(photo.coordinates.lat) : null,
            geoLng: photo.coordinates.lon !== 0 ? String(photo.coordinates.lon) : null,
            uploadedBy: systemUserId,
          },
        };
      } else {
        // Dev mode — store reference only, no R2 upload
        const yearMonth = capturedAt.toISOString().slice(0, 7);
        const dateStr = capturedAt.toISOString().split("T")[0];
        const shortId = crypto.randomUUID().slice(0, 8);
        const systemFilename = `${deal.dealNumber}_CompanyCam_${dateStr}_${shortId}.jpg`;
        const r2Key = `dev/companycam/${photo.id}.jpg`;
        const displayName = `${deal.dealNumber} CompanyCam ${dateStr} ${photo.id.slice(-6)}`;

        return {
          photoId: photo.id,
          values: {
            category: "photo",
            subcategory: "CompanyCam",
            folderPath: `Photos/CompanyCam/${yearMonth}`,
            tags: ["companycam"],
            displayName,
            systemFilename,
            originalFilename: `companycam_${photo.id}.jpg`,
            mimeType: "image/jpeg",
            fileSizeBytes: 0,
            fileExtension: ".jpg",
            r2Key,
            r2Bucket: "dev",
            externalUrl: original,
            externalThumbnailUrl: thumbnail,
            companycamPhotoId: photo.id,
            dealId: deal.id,
            description: photo.description,
            takenAt: capturedAt,
            geoLat: photo.coordinates.lat !== 0 ? String(photo.coordinates.lat) : null,
            geoLng: photo.coordinates.lon !== 0 ? String(photo.coordinates.lon) : null,
            uploadedBy: systemUserId,
          },
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Photo ${photo.id}: ${msg}`);
      return null;
    }
  });

  for (const prepared of preparedPhotos) {
    if (!prepared) continue;
    try {
      await tenantDb.insert(files).values(prepared.values);
      imported++;

      // Progress update every 10 photos
      if (imported % 10 === 0) {
        onProgress?.(`${deal.name}: ${imported}/${newPhotos.length} photos imported`);
      }
    } catch (err) {
      // A broken-connection error means the tenant client is dead — rethrow (aborts the sync, destroys the
      // client) instead of recording a per-photo error and inserting the rest on the dead socket.
      if (isBrokenConnectionError(err)) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Photo ${prepared.photoId}: ${msg}`);
    }
  }

  onProgress?.(`${deal.name}: Done — ${imported} imported, ${skipped} skipped`);

  return {
    projectId: ccProjectId,
    projectName: deal.name,
    dealId: deal.id,
    photosImported: imported,
    photosSkipped: skipped,
    errors,
  };
}

/**
 * Sync all linked CompanyCam projects.
 */
export async function syncAllLinkedProjects(
  tenantDb: TenantDb,
  systemUserId: string,
  officeSlug: string = "default",
  onProgress?: ProgressCallback
): Promise<SyncResult[]> {
  // Every CompanyCam project mapped to an active deal (a deal may own many; a project is 1:1 to a deal, so
  // the project ids are already distinct via the join table's UNIQUE on companycam_project_id).
  const linkedProjects = await tenantDb
    .selectDistinct({ companycamProjectId: dealCompanycamProjects.companycamProjectId })
    .from(dealCompanycamProjects)
    .innerJoin(
      deals,
      and(eq(deals.id, dealCompanycamProjects.dealId), eq(deals.isActive, true)),
    );

  const results: SyncResult[] = [];

  for (let i = 0; i < linkedProjects.length; i++) {
    const projectId = linkedProjects[i].companycamProjectId;

    onProgress?.(`Project ${i + 1}/${linkedProjects.length}: syncing...`);

    try {
      const result = await syncProjectPhotos(tenantDb, projectId, systemUserId, officeSlug, onProgress);
      results.push(result);
    } catch (err) {
      // A broken-connection error means the tenant client is dead — abort the whole sync (rethrow to the
      // /sync-all handler, which destroys the client) instead of recording it as a per-project failure and
      // running every remaining project's queries on the dead socket (and briefly reporting "Complete").
      if (isBrokenConnectionError(err)) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        projectId,
        projectName: "Unknown",
        dealId: "",
        photosImported: 0,
        photosSkipped: 0,
        errors: [msg],
      });
    }
  }

  return results;
}

/**
 * Auto-link projects by name match — the LINK phase ONLY (no photo sync).
 *
 * Split out from the photo sync so the per-project advisory locks taken by linkProjectToDeal
 * (pg_advisory_xact_lock) release as soon as THIS phase's transaction commits. The /auto-import route runs
 * the long syncAllLinkedProjects in a SEPARATE transaction afterwards, so those link locks are NOT held
 * across the entire photo sync (which would otherwise block any concurrent link/assign of those projects
 * until the statement timeout). Returns the number of projects linked.
 */
export async function autoLinkProjects(
  tenantDb: TenantDb,
  onProgress?: ProgressCallback
): Promise<number> {
  onProgress?.("Matching CompanyCam projects to deals...");
  const mappings = await getProjectMappings(tenantDb);

  let linkedCount = 0;

  for (const mapping of mappings) {
    if (mapping.matchType === "auto" && mapping.dealId) {
      await linkProjectToDeal(tenantDb, mapping.ccProjectId, mapping.dealId);
      linkedCount++;
    }
  }

  onProgress?.(`Linked ${linkedCount} projects.`);

  return linkedCount;
}
