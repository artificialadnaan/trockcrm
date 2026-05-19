import crypto from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, files, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { deleteObject, generateDownloadUrl, putObject } from "../../lib/r2-client.js";
import { getFileById, getFileDownloadUrl } from "../files/service.js";
import type { FieldAccessContext, FieldPhoto, FieldProject } from "./projects-service.js";
import { assertActiveFieldProject, listFieldProjectPhotos } from "./projects-service.js";
import { renderFieldPhotoReportPdf, type ReportRenderSection } from "./pdf-layout.js";

type TenantDb = NodePgDatabase<typeof schema>;

const REPORT_TAG = "photo-report";
const REPORT_EXPIRY_TAG_PREFIX = "photo-report-exp:";
const REPORT_FILE_SUBCATEGORY = "Photo Report";
const REPORT_DOWNLOAD_EXPIRY_SECONDS = 60 * 60;
const REPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
  const projectPhotos = await listFieldProjectPhotos(tenantDb, access, project.id, { includeDeleted: false });
  const photoMap = new Map(projectPhotos.photos.map((photo) => [photo.id, photo]));
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
}>> {
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
    })
    .from(files)
    .leftJoin(users, eq(users.id, files.uploadedBy))
    .where(and(
      inArray(files.id, photoIds),
      eq(files.category, "photo"),
      eq(files.isActive, true),
      isNull(files.deletedAt),
      eq(files.dealId, projectId),
    ));

  return new Map(rows.map((row) => [row.id, {
    ...row,
    tags: Array.isArray(row.tags) ? row.tags : [],
    takenAt: row.takenAt ? new Date(row.takenAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
  }]));
}

export async function generateFieldPhotoReport(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  input: {
    officeSlug: string;
    projectId: string;
    reportTitle: string;
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
  const pdfBuffer = await renderFieldPhotoReportPdf({ cover, sections: renderSections });
  const bucketName = process.env.R2_BUCKET_NAME || "trock-crm-files";
  const fileExtension = ".pdf";
  const systemFilename = `${slugify(title)}-${now.toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}${fileExtension}`;
  const yearMonth = now.toISOString().slice(0, 7);
  const r2Key = `office_${input.officeSlug}/deals/${project.dealNumber}/documents/photo-reports/${yearMonth}/${systemFilename}`;
  const expiresAt = new Date(now.getTime() + REPORT_RETENTION_MS).toISOString();
  const pdfUrl = await generateDownloadUrl(r2Key, REPORT_DOWNLOAD_EXPIRY_SECONDS, `${title}${fileExtension}`);
  await putObject(r2Key, pdfBuffer, "application/pdf");

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
      fileSizeBytes: pdfBuffer.byteLength,
      fileExtension,
      r2Key,
      r2Bucket: bucketName,
      dealId: project.id,
      description: `Generated photo report for ${project.name}`,
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

export async function getFieldProjectReportDownload(
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
  return getFileDownloadUrl(tenantDb, reportId);
}
