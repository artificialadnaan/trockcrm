/**
 * CompanyCam sync service.
 * Fetches projects + photos from CompanyCam, matches projects to deals,
 * downloads photos to R2 storage, and creates file records.
 */

import { eq, and, sql, isNull, isNotNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, files } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { getAllProjects, getProjectPhotos } from "./client.js";
import type { CCProject, CCPhoto } from "./client.js";
import { putObject, isR2Configured } from "../../lib/r2-client.js";
import crypto from "node:crypto";

type TenantDb = NodePgDatabase<typeof schema>;
type ProgressCallback = (message: string) => void;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectMapping {
  ccProjectId: string;
  ccProjectName: string;
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
function normalizeName(name: string): string {
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

// ─── Service Functions ───────────────────────────────────────────────────────

/**
 * Get all CompanyCam projects with their match status against deals.
 */
export async function getProjectMappings(tenantDb: TenantDb): Promise<ProjectMapping[]> {
  const [ccProjects, dealRows] = await Promise.all([
    getAllProjects(),
    tenantDb
      .select({
        id: deals.id,
        dealNumber: deals.dealNumber,
        name: deals.name,
        companycamProjectId: deals.companycamProjectId,
      })
      .from(deals)
      .where(eq(deals.isActive, true)),
  ]);

  // Index deals by companycam_project_id for linked matches
  const linkedMap = new Map<string, typeof dealRows[0]>();
  const unlinkedDeals: typeof dealRows = [];
  for (const deal of dealRows) {
    if (deal.companycamProjectId) {
      linkedMap.set(deal.companycamProjectId, deal);
    } else {
      unlinkedDeals.push(deal);
    }
  }

  // Build normalized name index for fuzzy matching
  const dealsByNormName = new Map<string, typeof dealRows[0]>();
  for (const deal of unlinkedDeals) {
    dealsByNormName.set(normalizeName(deal.name), deal);
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
    const fuzzyMatch = dealsByNormName.get(normProjName);
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
      dealsByNormName.delete(normProjName);
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
 * Link a CompanyCam project to a deal.
 */
export async function linkProjectToDeal(
  tenantDb: TenantDb,
  ccProjectId: string,
  dealId: string
): Promise<void> {
  await tenantDb
    .update(deals)
    .set({ companycamProjectId: null })
    .where(eq(deals.companycamProjectId, ccProjectId));

  await tenantDb
    .update(deals)
    .set({ companycamProjectId: ccProjectId })
    .where(eq(deals.id, dealId));
}

/**
 * Unlink a CompanyCam project from its deal.
 */
export async function unlinkProject(
  tenantDb: TenantDb,
  ccProjectId: string
): Promise<void> {
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
    .from(deals)
    .where(
      and(
        eq(deals.companycamProjectId, ccProjectId),
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

  // Process with concurrency limit
  await mapWithConcurrency(newPhotos, 5, async (photo) => {
    try {
      const { original, thumbnail } = extractUrls(photo);
      if (!original) {
        errors.push(`Photo ${photo.id}: no original URL found`);
        return;
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

        const displayName = `${deal.dealNumber} CompanyCam ${dateStr} ${photo.id.slice(-6)}`;

        await tenantDb.insert(files).values({
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
        });
      } else {
        // Dev mode — store reference only, no R2 upload
        const yearMonth = capturedAt.toISOString().slice(0, 7);
        const dateStr = capturedAt.toISOString().split("T")[0];
        const shortId = crypto.randomUUID().slice(0, 8);
        const systemFilename = `${deal.dealNumber}_CompanyCam_${dateStr}_${shortId}.jpg`;
        const r2Key = `dev/companycam/${photo.id}.jpg`;
        const displayName = `${deal.dealNumber} CompanyCam ${dateStr} ${photo.id.slice(-6)}`;

        await tenantDb.insert(files).values({
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
        });
      }

      imported++;

      // Progress update every 10 photos
      if (imported % 10 === 0) {
        onProgress?.(`${deal.name}: ${imported}/${newPhotos.length} photos imported`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Photo ${photo.id}: ${msg}`);
    }
  });

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
  const linkedDeals = await tenantDb
    .select({ companycamProjectId: deals.companycamProjectId })
    .from(deals)
    .where(
      and(
        isNotNull(deals.companycamProjectId),
        eq(deals.isActive, true)
      )
    );

  const results: SyncResult[] = [];

  for (let i = 0; i < linkedDeals.length; i++) {
    const deal = linkedDeals[i];
    if (!deal.companycamProjectId) continue;

    onProgress?.(`Project ${i + 1}/${linkedDeals.length}: syncing...`);

    try {
      const result = await syncProjectPhotos(tenantDb, deal.companycamProjectId, systemUserId, officeSlug, onProgress);
      results.push(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        projectId: deal.companycamProjectId,
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
 * Auto-link projects by name match and then sync all.
 */
export async function autoLinkAndSync(
  tenantDb: TenantDb,
  systemUserId: string,
  officeSlug: string = "default",
  onProgress?: ProgressCallback
): Promise<{ linked: number; results: SyncResult[] }> {
  onProgress?.("Matching CompanyCam projects to deals...");
  const mappings = await getProjectMappings(tenantDb);

  let linkedCount = 0;

  for (const mapping of mappings) {
    if (mapping.matchType === "auto" && mapping.dealId) {
      await linkProjectToDeal(tenantDb, mapping.ccProjectId, mapping.dealId);
      linkedCount++;
    }
  }

  onProgress?.(`Linked ${linkedCount} projects. Starting photo sync...`);

  const results = await syncAllLinkedProjects(tenantDb, systemUserId, officeSlug, onProgress);

  return { linked: linkedCount, results };
}
