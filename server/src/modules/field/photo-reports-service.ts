import crypto from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, files, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { deleteObject, generateDownloadUrl, putObject } from "../../lib/r2-client.js";
import { buildFileDownloadUrlFromRecord, getFileById } from "../files/service.js";
import { buildDealPhotoTimelineConditions } from "../files/photo-timeline-filters.js";
import type { FieldAccessContext, FieldPhoto, FieldProject } from "./projects-service.js";
import { assertActiveFieldProject, listFieldProjectPhotos } from "./projects-service.js";
import { renderFieldPhotoReportPdf, type ReportPhotoLayout, type ReportRenderSection } from "./pdf-layout.js";

type TenantDb = NodePgDatabase<typeof schema>;

const REPORT_TAG = "photo-report";
const REPORT_EXPIRY_TAG_PREFIX = "photo-report-exp:";
const REPORT_FILE_SUBCATEGORY = "Photo Report";
const REPORT_DOWNLOAD_EXPIRY_SECONDS = 60 * 60;
// How long a generated photo report stays available after creation. The report's expiresAt is stamped
// now + this window; past it the report drops out of the list and re-downloads return 410. The per-download
// presigned URL stays short-lived (REPORT_DOWNLOAD_EXPIRY_SECONDS) and is re-minted on each access, so the
// report is re-downloadable through the app for this whole window without exposing a long-lived bearer URL.
const REPORT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

type ReportGroupBy = "tag" | "date" | "none";

export type FieldReportPhoto = Pick<
  FieldPhoto,
  "id" | "displayName" | "description" | "takenAt" | "createdAt" | "uploaderName" | "imageUrl" | "tags"
> & {
  projectName: string;
};

export type FieldReportSection = {
  id: string;
  title: string;
  photos: FieldReportPhoto[];
};

export type FieldProjectReportSummary = {
  id: string;
  title: string;
  createdAt: string;
  expiresAt: string | null;
  description: string | null;
};

function normalizeTitle(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 140) : fallback;
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function buildReportTags(expiresAt: string): string[] {
  return [REPORT_TAG, `${REPORT_EXPIRY_TAG_PREFIX}${expiresAt}`];
}

function readReportExpiryFromTags(tags: string[] | null | undefined): string | null {
  if (!Array.isArray(tags)) return null;
  const match = tags.find((tag) => tag.startsWith(REPORT_EXPIRY_TAG_PREFIX));
  return match ? match.slice(REPORT_EXPIRY_TAG_PREFIX.length) : null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "report";
}

function formatReportDateLabel(value: Date): string {
  return value.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function groupPhotosIntoSections(photos: FieldReportPhoto[], groupBy: ReportGroupBy): FieldReportSection[] {
  if (groupBy === "none") {
    return [{ id: "section-1", title: "Section 1", photos }];
  }

  const groups = new Map<string, FieldReportSection>();
  for (const photo of photos) {
    let key = "section-1";
    let title = "Section 1";
    if (groupBy === "tag") {
      const firstTag = photo.tags[0];
      key = firstTag ? `tag:${normalizeTag(firstTag)}` : "tag:untagged";
      title = firstTag ? `Tag: ${firstTag}` : "Untagged";
    } else if (groupBy === "date") {
      const date = new Date(photo.takenAt ?? photo.createdAt);
      key = date.toISOString().slice(0, 10);
      title = date.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    }
    const existing = groups.get(key) ?? { id: key, title, photos: [] };
    existing.photos.push(photo);
    groups.set(key, existing);
  }
  return Array.from(groups.values());
}

async function loadProjectReportPhotos(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  project: FieldProject,
  photoIds: string[],
): Promise<FieldReportPhoto[]> {
  // The field gallery now loads ALL photos (not just the first 200), so a selected id can live on a later
  // page. Page through here until every selected id is resolved (or pages run out) instead of validating
  // against only the first page — otherwise picking a photo beyond #200 wrongly 400s as "not available".
  // Sequential on purpose: req.tenantDb is a single transaction-bound client (parallel reads would 500).
  const wanted = new Set(photoIds);
  const photoMap = new Map<string, FieldPhoto>();
  let page = 1;
  let totalPages = 1;
  do {
    const pageResult = await listFieldProjectPhotos(
      tenantDb,
      access,
      project.id,
      { includeDeleted: false },
      { page, perPage: 200 },
    );
    for (const photo of pageResult.photos) {
      if (wanted.has(photo.id)) photoMap.set(photo.id, photo);
    }
    totalPages = pageResult.pagination?.totalPages ?? 1;
    page += 1;
  } while (page <= totalPages && photoMap.size < wanted.size);

  const selected = photoIds.map((id) => photoMap.get(id)).filter((photo): photo is FieldPhoto => Boolean(photo));
  if (selected.length !== photoIds.length) {
    throw new AppError(400, "One or more selected photos are not available for this project.");
  }
  return selected.map((photo) => ({
    id: photo.id,
    displayName: photo.displayName,
    description: photo.description,
    takenAt: photo.takenAt,
    createdAt: photo.createdAt,
    uploaderName: photo.uploaderName,
    imageUrl: photo.imageUrl,
    tags: photo.tags ?? [],
    projectName: project.name,
  }));
}

export async function previewFieldPhotoReport(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  input: {
    projectId: string;
    photoIds: string[];
    groupBy: ReportGroupBy;
    creatorName: string;
  },
) {
  const uniquePhotoIds = Array.from(new Set(input.photoIds.map(String).filter(Boolean)));
  if (uniquePhotoIds.length === 0) {
    throw new AppError(400, "Select at least one photo to build a report.");
  }
  const project = await assertActiveFieldProject(tenantDb, access, input.projectId);
  const selectedPhotos = await loadProjectReportPhotos(tenantDb, access, project, uniquePhotoIds);
  const now = new Date();
  const sections = groupPhotosIntoSections(selectedPhotos, input.groupBy);

  return {
    cover: {
      reportTitle: `${project.name} Photo Report`,
      creatorName: input.creatorName.trim() || "Field User",
      companyName: "TRock Construction",
      reportDateLabel: formatReportDateLabel(now),
      projectName: project.name,
      photoCount: selectedPhotos.length,
    },
    sections,
  };
}

async function loadReportRenderPhotos(
  tenantDb: TenantDb,
  projectId: string,
  photoIds: string[],
): Promise<Map<string, {
  id: string;
  displayName: string;
  description: string | null;
  takenAt: string | null;
  createdAt: string;
  uploaderName: string;
  tags: string[];
  r2Key: string | null;
  externalUrl: string | null;
  externalThumbnailUrl: string | null;
  // Declared, not just selected: the renderer reads it to decide whether a HEIC original needs transcoding,
  // and omitting it here dropped it from the type the moment these rows were spread into a render photo.
  mimeType: string | null;
}>> {
  // Keep report rendering aligned with the project timeline scope so converted
  // lead-origin photos survive final rendering and out-of-scope photos do not.
  const projectPhotoConditions = await buildDealPhotoTimelineConditions(tenantDb, projectId, {
    includeDeleted: false,
  });
  const rows = await tenantDb
    .select({
      id: files.id,
      displayName: files.displayName,
      description: files.description,
      takenAt: files.takenAt,
      createdAt: files.createdAt,
      uploaderName: sql<string>`COALESCE(${users.displayName}, 'Unknown')`.as("uploader_name"),
      tags: files.tags,
      r2Key: files.r2Key,
      externalUrl: files.externalUrl,
      externalThumbnailUrl: files.externalThumbnailUrl,
      // Drives the renderer's transcode decision — a HEIC original embeds as "Image unavailable" otherwise.
      mimeType: files.mimeType,
    })
    .from(files)
    .leftJoin(users, eq(users.id, files.uploadedBy))
    .where(and(
      inArray(files.id, photoIds),
      projectPhotoConditions,
    ));

  return new Map(rows.map((row) => [row.id, {
    ...row,
    tags: Array.isArray(row.tags) ? row.tags : [],
    takenAt: row.takenAt ? new Date(row.takenAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
  }]));
}

/**
 * Read the project and photo rows and assemble everything the renderer needs. DB-only — this is the part
 * that must run inside the office transaction.
 */
export async function prepareFieldPhotoReport(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  input: {
    projectId: string;
    reportTitle: string;
    executiveSummary?: string | null;
    coverData: {
      creatorName: string;
      companyName?: string | null;
      reportDateLabel?: string | null;
      projectName?: string | null;
    };
    sections: Array<{
      title: string;
      photoIds: string[];
      photoOverrides?: Array<{ id: string; description?: string | null }>;
    }>;
    /**
     * Per-photo page layout. Omitted (the mobile/web "Generate PDF" path) keeps the 2-per-page grid.
     * The AI report passes "findings" so each photo gets a full page with its bulleted assessment.
     */
    photoLayout?: ReportPhotoLayout;
    /** Overrides the file's displayName/description wording so an AI report is labelled as one. */
    fileDescription?: string | null;
  },
) {
  const project = await assertActiveFieldProject(tenantDb, access, input.projectId);
  const title = normalizeTitle(input.reportTitle, `${project.name} Photo Report`);
  const allPhotoIds = Array.from(new Set(input.sections.flatMap((section) => section.photoIds.map(String).filter(Boolean))));
  if (allPhotoIds.length === 0) {
    throw new AppError(400, "Select at least one photo to generate a report.");
  }

  const photoMap = await loadReportRenderPhotos(tenantDb, project.id, allPhotoIds);
  if (photoMap.size !== allPhotoIds.length) {
    throw new AppError(400, "One or more selected photos are unavailable for report generation.");
  }

  let reportIndex = 1;
  const renderSections = input.sections
    .map((section, sectionIndex): ReportRenderSection | null => {
      const overrides = new Map((section.photoOverrides ?? []).map((entry) => [entry.id, entry.description ?? null]));
      const photos = section.photoIds
        .map((photoId) => photoMap.get(photoId))
        .filter((photo): photo is NonNullable<typeof photo> => Boolean(photo))
        .map((photo) => ({
          ...photo,
          projectName: project.name,
          descriptionOverride: overrides.get(photo.id),
          reportIndex: reportIndex++,
        }));
      if (photos.length === 0) return null;
      return {
        title: normalizeTitle(section.title, `Section ${sectionIndex + 1}`),
        photos,
      };
    })
    .filter((section): section is ReportRenderSection => section !== null);

  const now = new Date();
  const cover = {
    reportTitle: title,
    creatorName: normalizeTitle(input.coverData.creatorName, "Field User"),
    companyName: normalizeTitle(input.coverData.companyName ?? undefined, "TRock Construction"),
    reportDateLabel: normalizeTitle(input.coverData.reportDateLabel ?? undefined, formatReportDateLabel(now)),
    projectName: normalizeTitle(input.coverData.projectName ?? undefined, project.name),
    photoCount: renderSections.reduce((sum, section) => sum + section.photos.length, 0),
  };
  // Cap the free-form summary so a pathological payload can't balloon the PDF into hundreds of pages;
  // blank/whitespace collapses to null (renderer adds no page for it).
  const executiveSummary = input.executiveSummary?.trim() ? input.executiveSummary.trim().slice(0, 5000) : null;
  return {
    project,
    title,
    cover,
    renderSections,
    executiveSummary,
    photoLayout: input.photoLayout,
    fileDescription: input.fileDescription ?? null,
    now,
  };
}

export type PreparedFieldPhotoReport = Awaited<ReturnType<typeof prepareFieldPhotoReport>>;

/**
 * Render the PDF and put it in R2. Touches NO database — deliberately, so the caller can run this outside a
 * transaction. Rendering a 60-page report downloads and decodes every original and then uploads the result,
 * which is minutes of work; doing it while holding a pooled client leaves a connection idle-in-transaction
 * for the duration, and a worker pool is small. Returns everything the file row needs.
 */
export async function renderAndStoreFieldPhotoReportPdf(
  prepared: PreparedFieldPhotoReport,
  officeSlug: string,
  /** Bounds every object read and transcode the render performs. Omitted by the human path. */
  signal?: AbortSignal,
) {
  const { project, title, cover, renderSections, executiveSummary, photoLayout, now } = prepared;
  const pdfBuffer = await renderFieldPhotoReportPdf({
    cover,
    sections: renderSections,
    executiveSummary,
    photoLayout,
    signal,
  });
  const bucketName = process.env.R2_BUCKET_NAME || "trock-crm-files";
  const fileExtension = ".pdf";
  const systemFilename = `${slugify(title)}-${now.toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}${fileExtension}`;
  const yearMonth = now.toISOString().slice(0, 7);
  const r2Key = `office_${officeSlug}/deals/${project.dealNumber}/documents/photo-reports/${yearMonth}/${systemFilename}`;
  const expiresAt = new Date(now.getTime() + REPORT_RETENTION_MS).toISOString();
  const pdfUrl = await generateDownloadUrl(r2Key, REPORT_DOWNLOAD_EXPIRY_SECONDS, `${title}${fileExtension}`);
  // The upload carries the SAME deadline as the render that produced it. Bounding the reads and transcodes
  // but not the PUT just moves the stall one line down: an accepted-then-stalled upload leaves this function
  // pending forever, and the AI-report poller is single-in-flight, so every later report queues behind it
  // with nothing able to free the handler.
  await putObject(r2Key, pdfBuffer, "application/pdf", { signal });

  return { r2Key, pdfUrl, expiresAt, systemFilename, yearMonth, bucketName, fileExtension, byteLength: pdfBuffer.byteLength };
}

export type StoredFieldPhotoReport = Awaited<ReturnType<typeof renderAndStoreFieldPhotoReportPdf>>;

/**
 * Record the uploaded PDF as a `files` row. The only step here that needs a transaction — kept short on
 * purpose. On failure the R2 object is deleted so a failed insert cannot leave an orphaned upload.
 */
export async function recordFieldPhotoReportFile(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  prepared: PreparedFieldPhotoReport,
  stored: StoredFieldPhotoReport,
) {
  const { project, title, fileDescription } = prepared;
  const { r2Key, pdfUrl, expiresAt, systemFilename, yearMonth, bucketName, fileExtension, byteLength } = stored;

  let file;
  try {
    [file] = await tenantDb.insert(files).values({
      category: "other",
      subcategory: REPORT_FILE_SUBCATEGORY,
      folderPath: `Documents/Photo Reports/${yearMonth}`,
      tags: buildReportTags(expiresAt),
      displayName: title,
      systemFilename,
      originalFilename: `${slugify(title)}${fileExtension}`,
      mimeType: "application/pdf",
      fileSizeBytes: byteLength,
      fileExtension,
      r2Key,
      r2Bucket: bucketName,
      dealId: project.id,
      description: fileDescription?.trim() || `Generated photo report for ${project.name}`,
      uploadedBy: access.userId,
    }).returning();
  } catch (error) {
    await deleteObject(r2Key).catch(() => undefined);
    throw error;
  }

  return {
    report: {
      id: file.id,
      title,
      pdfUrl,
      expiresAt,
      createdAt: new Date(file.createdAt).toISOString(),
    },
  };
}

/**
 * The synchronous path (POST /reports/generate): prepare, render+upload, record — all on the caller's
 * connection, exactly as before this was split. Behaviour is unchanged for the human "Generate PDF" flow.
 *
 * The AI report deliberately does NOT use this wrapper: it runs the render+upload step between two short
 * transactions instead, so a 60-photo render cannot hold a pooled client idle-in-transaction for minutes.
 */
export async function generateFieldPhotoReport(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  input: Parameters<typeof prepareFieldPhotoReport>[2] & { officeSlug: string },
) {
  const prepared = await prepareFieldPhotoReport(tenantDb, access, input);
  const stored = await renderAndStoreFieldPhotoReportPdf(prepared, input.officeSlug);
  return recordFieldPhotoReportFile(tenantDb, access, prepared, stored);
}

export async function listFieldProjectReports(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  projectId: string,
) {
  await assertActiveFieldProject(tenantDb, access, projectId);
  const rows = await tenantDb
    .select({
      id: files.id,
      displayName: files.displayName,
      description: files.description,
      createdAt: files.createdAt,
      updatedAt: files.updatedAt,
      tags: files.tags,
    })
    .from(files)
    .where(and(
      eq(files.dealId, projectId),
      eq(files.isActive, true),
      eq(files.category, "other"),
      sql`${files.tags} @> ARRAY[${REPORT_TAG}]::text[]`,
    ))
    .orderBy(sql`${files.createdAt} DESC`);

  return {
    reports: rows
      .map((row) => {
        const expiresAt = readReportExpiryFromTags(row.tags);
        return {
          id: row.id,
          title: row.displayName,
          description: row.description,
          createdAt: new Date(row.createdAt).toISOString(),
          expiresAt,
        } satisfies FieldProjectReportSummary;
      })
      .filter((row) => !row.expiresAt || new Date(row.expiresAt).getTime() > Date.now()),
  };
}

/**
 * The download URL for an existing report PLUS the metadata the app shows beside it, in exactly the shape
 * POST /reports/generate returns. Lets the AI report's status poll hand the client the same `report` object
 * the synchronous path does, so the mobile success handler is shared rather than duplicated.
 *
 * Access is delegated to getFieldProjectReportDownload — same report-tag, expiry and project-access gate as
 * a direct download; the metadata read below only runs once that has passed.
 */
export async function getFieldProjectReportDetail(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  reportId: string,
) {
  // Gate and metadata come from ONE read. Calling getFieldProjectReportDownload and then re-fetching the
  // same row fetched it twice for a single poll.
  const file = await assertReadableFieldProjectReport(tenantDb, access, reportId);
  const download = await buildFileDownloadUrlFromRecord(file);
  return {
    report: {
      id: file.id,
      title: file.displayName,
      pdfUrl: download.url,
      expiresAt: readReportExpiryFromTags(file.tags),
      createdAt: new Date(file.createdAt).toISOString(),
    },
  };
}

/**
 * The report-tag, expiry and project-access gate, returning the row it had to read anyway.
 *
 * Shared by the download and detail paths so a caller that also needs the file's metadata does not fetch the
 * same row a second time. Every rejection here is deliberate: a non-report file 404s rather than 403s (the
 * id is opaque; confirming it exists leaks that a report was generated), an expired one 410s, and project
 * access is checked LAST so it cannot be used to probe for report ids.
 */
async function assertReadableFieldProjectReport(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  reportId: string,
) {
  const file = await getFileById(tenantDb, reportId);
  if (!file || file.category !== "other" || !Array.isArray(file.tags) || !file.tags.includes(REPORT_TAG) || !file.dealId) {
    throw new AppError(404, "Report not found");
  }
  const expiresAt = readReportExpiryFromTags(file.tags);
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    throw new AppError(410, "Report has expired");
  }
  await assertActiveFieldProject(tenantDb, access, file.dealId);
  return file;
}

export async function getFieldProjectReportDownload(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  reportId: string,
) {
  // The gate already read the row, so the URL is built FROM it rather than through getFileDownloadUrl,
  // which would fetch the same file a second time. The builder's default disposition is "attachment" —
  // the same one getFileDownloadUrl was passing through.
  const file = await assertReadableFieldProjectReport(tenantDb, access, reportId);
  return buildFileDownloadUrlFromRecord(file);
}
