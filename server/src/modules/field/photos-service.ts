import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import type { PhotoCategory, UserRole } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import {
  confirmUpload,
  getFileDownloadUrl,
  getPendingUploadMetadata,
  requestUploadUrl,
} from "../files/service.js";
import { recordUploadedFileSideEffects, type UploadAuditContext } from "../files/upload-workflow.js";
import { assertAccessibleFieldCaptureTarget, type FieldPhoto } from "./projects-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

const IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const PHOTO_CATEGORY_VALUES = new Set(["before", "after", "progress", "site_visit", "damage", "safety", "delivery", "other"]);
const PHOTO_ADDRESS_SOURCES = new Set(["exif", "live_gps"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extensionForContentType(contentType: string): string {
  switch (contentType) {
    case "image/png": return "png";
    case "image/webp": return "webp";
    case "image/heic": return "heic";
    case "image/heif": return "heif";
    default: return "jpg";
  }
}

function assertImageContentType(contentType: string): void {
  if (!IMAGE_CONTENT_TYPES.has(contentType)) {
    throw new AppError(400, "contentType must be a supported image type.");
  }
}

function assertUploadSize(sizeBytes: number): void {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new AppError(400, "sizeBytes must be a positive number.");
  }
}

function cleanPhotoCategory(value: unknown): PhotoCategory | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !PHOTO_CATEGORY_VALUES.has(value)) {
    throw new AppError(400, "category must be one of the supported photo categories.");
  }
  return value as PhotoCategory;
}

function cleanAddressSource(value: unknown): "exif" | "live_gps" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !PHOTO_ADDRESS_SOURCES.has(value)) {
    throw new AppError(400, "addressSource must be exif or live_gps.");
  }
  return value as "exif" | "live_gps";
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeOptionalId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeCaptureTargetIds(input: {
  dealId?: string;
  leadId?: string;
  opportunityId?: string;
}) {
  return {
    dealId: normalizeOptionalId(input.dealId),
    leadId: normalizeOptionalId(input.leadId),
    opportunityId: normalizeOptionalId(input.opportunityId),
  };
}

function assertValidUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError(400, `Invalid ${field}: must be a UUID.`);
  }
}

function assertValidCaptureTargetIds(input: {
  dealId?: string;
  leadId?: string;
  opportunityId?: string;
}) {
  if (input.dealId) assertValidUuid(input.dealId, "dealId");
  if (input.leadId) assertValidUuid(input.leadId, "leadId");
  if (input.opportunityId) assertValidUuid(input.opportunityId, "opportunityId");
}

function toFieldUploadedPhoto(file: any, imageUrl: string | null): FieldPhoto {
  return {
    id: file.id,
    category: "photo",
    photoCategory: file.photoCategory ?? null,
    subcategory: file.subcategory ?? null,
    displayName: file.displayName,
    mimeType: file.mimeType,
    fileSizeBytes: file.fileSizeBytes ?? null,
    fileExtension: file.fileExtension ?? null,
    dealId: file.dealId ?? null,
    leadId: file.leadId ?? null,
    description: file.description ?? null,
    tags: Array.isArray(file.tags) ? file.tags : [],
    takenAt: iso(file.takenAt),
    createdAt: iso(file.createdAt)!,
    uploadedBy: file.uploadedBy,
    uploaderName: "You",
    uploaderAvatarUrl: null,
    latitude: file.latitude ?? null,
    longitude: file.longitude ?? null,
    address: file.address ?? null,
    addressSource: file.addressSource ?? null,
    geocodedAt: iso(file.geocodedAt),
    procoreSyncStatus: file.procoreSyncStatus ?? null,
    deletedAt: iso(file.deletedAt),
    imageUrl,
  };
}

function hasSelectedCaptureTarget(input: {
  dealId?: string;
  leadId?: string;
  opportunityId?: string;
}) {
  const normalized = normalizeCaptureTargetIds(input);
  return Boolean(normalized.dealId || normalized.leadId || normalized.opportunityId);
}

export async function requestFieldPhotoUploadUrl(
  tenantDb: TenantDb,
  input: {
    officeSlug: string;
    userId: string;
    userRole: UserRole;
    dealId?: string;
    leadId?: string;
    opportunityId?: string;
    contentType: string;
    sizeBytes: number;
    photoCategory?: string | null;
    caption?: string | null;
    tags?: string[];
  }
) {
  const normalizedTarget = normalizeCaptureTargetIds(input);
  assertValidCaptureTargetIds(normalizedTarget);
  if (hasSelectedCaptureTarget(input)) {
    await assertAccessibleFieldCaptureTarget(tenantDb, {
      dealId: normalizedTarget.dealId,
      leadId: normalizedTarget.leadId,
      opportunityId: normalizedTarget.opportunityId,
      userId: input.userId,
      userRole: input.userRole,
    });
  }
  assertImageContentType(input.contentType);
  assertUploadSize(input.sizeBytes);
  const photoCategory = cleanPhotoCategory(input.photoCategory);
  const ext = extensionForContentType(input.contentType);
  const result = await requestUploadUrl(tenantDb, input.officeSlug, input.userId, {
    originalFilename: `field-photo-${Date.now()}.${ext}`,
    mimeType: input.contentType,
    fileSizeBytes: Number(input.sizeBytes),
    category: "photo",
    dealId: normalizedTarget.dealId ?? normalizedTarget.opportunityId,
    leadId: normalizedTarget.leadId,
    opportunityId: normalizedTarget.opportunityId,
    description: input.caption ?? undefined,
    photoCategory,
    tags: input.tags,
    allowUnassigned: !hasSelectedCaptureTarget(normalizedTarget),
  });

  return {
    uploadUrl: result.uploadUrl,
    objectKey: result.r2Key,
    r2Key: result.r2Key,
    expiresIn: result.expiresIn,
    uploadToken: result.uploadToken,
    systemFilename: result.systemFilename,
    displayName: result.displayName,
    folderPath: result.folderPath,
  };
}

export async function confirmFieldPhotoUpload(
  tenantDb: TenantDb,
  input: {
    userId: string;
    userRole: UserRole;
    officeId: string;
    dealId?: string;
    leadId?: string;
    opportunityId?: string;
    uploadToken: string;
    objectKey: string;
    latitude?: number;
    longitude?: number;
    addressSource?: "exif" | "live_gps";
    takenAt?: string;
    auditContext?: UploadAuditContext;
  }
) {
  const normalizedTarget = normalizeCaptureTargetIds(input);
  assertValidCaptureTargetIds(normalizedTarget);
  if (hasSelectedCaptureTarget(input)) {
    await assertAccessibleFieldCaptureTarget(tenantDb, {
      dealId: normalizedTarget.dealId,
      leadId: normalizedTarget.leadId,
      opportunityId: normalizedTarget.opportunityId,
      userId: input.userId,
      userRole: input.userRole,
    });
  }
  const pending = getPendingUploadMetadata(input.uploadToken);
  if (!pending) throw new AppError(400, "Invalid or expired upload token");
  if (pending.r2Key !== input.objectKey) throw new AppError(400, "objectKey does not match the issued upload.");
  if (
    pending.dealId !== (normalizedTarget.dealId ?? normalizedTarget.opportunityId ?? undefined) ||
    pending.leadId !== (normalizedTarget.leadId ?? undefined) ||
    pending.opportunityId !== (normalizedTarget.opportunityId ?? undefined) ||
    pending.category !== "photo"
  ) {
    throw new AppError(400, "Upload token does not match this project photo upload.");
  }

  const file = await confirmUpload(tenantDb, input.userId, {
    uploadToken: input.uploadToken,
    latitude: input.latitude,
    longitude: input.longitude,
    addressSource: cleanAddressSource(input.addressSource),
    takenAt: input.takenAt,
  });

  await recordUploadedFileSideEffects(tenantDb, {
    file,
    userId: input.userId,
    officeId: input.officeId,
    addressSource: input.addressSource,
    auditContext: input.auditContext,
  });

  const imageUrl = (await getFileDownloadUrl(tenantDb, file.id)).url;
  return { photo: toFieldUploadedPhoto(file, imageUrl) };
}

export async function listPendingFieldPhotos(
  tenantDb: TenantDb,
  access: {
    userId: string;
    userRole: UserRole;
  }
) {
  const result = await tenantDb.execute(sql`
    SELECT
      f.id,
      f.category,
      f.photo_category,
      f.subcategory,
      f.display_name,
      f.mime_type,
      f.file_size_bytes,
      f.file_extension,
      f.deal_id,
      f.lead_id,
      f.description,
      f.tags,
      f.taken_at,
      f.created_at,
      f.uploaded_by,
      f.latitude,
      f.longitude,
      f.address,
      f.address_source,
      f.geocoded_at,
      f.procore_sync_status,
      f.deleted_at
    FROM files f
    WHERE f.category = 'photo'
      AND f.is_active = true
      AND f.deleted_at IS NULL
      AND f.uploaded_by = ${access.userId}::uuid
      AND f.deal_id IS NULL
      AND f.lead_id IS NULL
      AND f.contact_id IS NULL
      AND f.procore_project_id IS NULL
      AND f.change_order_id IS NULL
    ORDER BY COALESCE(f.taken_at, f.created_at) DESC
    LIMIT 50
  `);

  const rows = (result as any).rows ?? result;
  const photos = await Promise.all(rows.map(async (row: any) => {
    const imageUrl = (await getFileDownloadUrl(tenantDb, row.id)).url;
    return toFieldUploadedPhoto({
      id: row.id,
      category: row.category,
      photoCategory: row.photo_category ?? null,
      subcategory: row.subcategory ?? null,
      displayName: row.display_name,
      mimeType: row.mime_type,
      fileSizeBytes: row.file_size_bytes ?? null,
      fileExtension: row.file_extension ?? null,
      dealId: row.deal_id ?? null,
      leadId: row.lead_id ?? null,
      description: row.description ?? null,
      tags: Array.isArray(row.tags) ? row.tags : [],
      takenAt: row.taken_at ?? null,
      createdAt: row.created_at,
      uploadedBy: row.uploaded_by,
      latitude: row.latitude ?? null,
      longitude: row.longitude ?? null,
      address: row.address ?? null,
      addressSource: row.address_source ?? null,
      geocodedAt: row.geocoded_at ?? null,
      procoreSyncStatus: row.procore_sync_status ?? null,
      deletedAt: row.deleted_at ?? null,
    }, imageUrl);
  }));

  return { photos };
}

export async function assignPendingFieldPhotoTarget(
  tenantDb: TenantDb,
  access: {
    userId: string;
    userRole: UserRole;
  },
  input: {
    photoId: string;
    dealId?: string;
    leadId?: string;
    opportunityId?: string;
  }
) {
  const normalizedTarget = normalizeCaptureTargetIds(input);
  assertValidUuid(input.photoId, "photoId");
  assertValidCaptureTargetIds(normalizedTarget);
  const target = await assertAccessibleFieldCaptureTarget(tenantDb, {
    dealId: normalizedTarget.dealId,
    leadId: normalizedTarget.leadId,
    opportunityId: normalizedTarget.opportunityId,
    userId: access.userId,
    userRole: access.userRole,
  });

  const existingResult = await tenantDb.execute(sql`
    SELECT
      f.id,
      f.category,
      f.photo_category,
      f.subcategory,
      f.display_name,
      f.mime_type,
      f.file_size_bytes,
      f.file_extension,
      f.deal_id,
      f.lead_id,
      f.description,
      f.tags,
      f.taken_at,
      f.created_at,
      f.uploaded_by,
      f.latitude,
      f.longitude,
      f.address,
      f.address_source,
      f.geocoded_at,
      f.procore_sync_status,
      f.deleted_at
    FROM files f
    WHERE f.id = ${input.photoId}::uuid
      AND f.category = 'photo'
      AND f.is_active = true
      AND f.deleted_at IS NULL
      AND f.uploaded_by = ${access.userId}::uuid
      AND f.deal_id IS NULL
      AND f.lead_id IS NULL
    LIMIT 1
  `);
  const existing = ((existingResult as any).rows ?? existingResult)[0];
  if (!existing) {
    throw new AppError(404, "Pending photo not found.");
  }

  const assignResult = await tenantDb.execute(sql`
    UPDATE files
    SET
      deal_id = ${target.type === "lead" ? null : target.id}::uuid,
      lead_id = ${target.type === "lead" ? target.id : null}::uuid
    WHERE id = ${input.photoId}::uuid
      AND category = 'photo'
      AND is_active = true
      AND deleted_at IS NULL
      AND uploaded_by = ${access.userId}::uuid
      AND deal_id IS NULL
      AND lead_id IS NULL
      AND contact_id IS NULL
      AND procore_project_id IS NULL
      AND change_order_id IS NULL
    RETURNING
      id,
      category,
      photo_category,
      subcategory,
      display_name,
      mime_type,
      file_size_bytes,
      file_extension,
      deal_id,
      lead_id,
      description,
      tags,
      taken_at,
      created_at,
      uploaded_by,
      latitude,
      longitude,
      address,
      address_source,
      geocoded_at,
      procore_sync_status,
      deleted_at
  `);
  const assigned = ((assignResult as any)?.rows ?? assignResult)?.[0];
  if (!assigned) {
    throw new AppError(409, "Pending photo could not be assigned. Refresh and try again.");
  }
  const imageUrl = (await getFileDownloadUrl(tenantDb, assigned.id)).url;
  return {
    photo: toFieldUploadedPhoto({
      id: assigned.id,
      category: assigned.category,
      photoCategory: assigned.photo_category ?? null,
      subcategory: assigned.subcategory ?? null,
      displayName: assigned.display_name,
      mimeType: assigned.mime_type,
      fileSizeBytes: assigned.file_size_bytes ?? null,
      fileExtension: assigned.file_extension ?? null,
      dealId: assigned.deal_id ?? null,
      leadId: assigned.lead_id ?? null,
      description: assigned.description ?? null,
      tags: Array.isArray(assigned.tags) ? assigned.tags : [],
      takenAt: assigned.taken_at ?? null,
      createdAt: assigned.created_at,
      uploadedBy: assigned.uploaded_by,
      latitude: assigned.latitude ?? null,
      longitude: assigned.longitude ?? null,
      address: assigned.address ?? null,
      addressSource: assigned.address_source ?? null,
      geocodedAt: assigned.geocoded_at ?? null,
      procoreSyncStatus: assigned.procore_sync_status ?? null,
      deletedAt: assigned.deleted_at ?? null,
    }, imageUrl),
  };
}
