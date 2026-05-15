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
  }
) {
  await assertAccessibleFieldCaptureTarget(tenantDb, {
    dealId: input.dealId,
    leadId: input.leadId,
    opportunityId: input.opportunityId,
    userId: input.userId,
    userRole: input.userRole,
  });
  assertImageContentType(input.contentType);
  assertUploadSize(input.sizeBytes);
  const photoCategory = cleanPhotoCategory(input.photoCategory);
  const ext = extensionForContentType(input.contentType);
  const result = await requestUploadUrl(tenantDb, input.officeSlug, input.userId, {
    originalFilename: `field-photo-${Date.now()}.${ext}`,
    mimeType: input.contentType,
    fileSizeBytes: Number(input.sizeBytes),
    category: "photo",
    dealId: input.dealId ?? input.opportunityId,
    leadId: input.leadId,
    opportunityId: input.opportunityId,
    description: input.caption ?? undefined,
    photoCategory,
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
  await assertAccessibleFieldCaptureTarget(tenantDb, {
    dealId: input.dealId,
    leadId: input.leadId,
    opportunityId: input.opportunityId,
    userId: input.userId,
    userRole: input.userRole,
  });
  const pending = getPendingUploadMetadata(input.uploadToken);
  if (!pending) throw new AppError(400, "Invalid or expired upload token");
  if (pending.r2Key !== input.objectKey) throw new AppError(400, "objectKey does not match the issued upload.");
  if (
    pending.dealId !== (input.dealId ?? input.opportunityId ?? undefined) ||
    pending.leadId !== (input.leadId ?? undefined) ||
    pending.opportunityId !== (input.opportunityId ?? undefined) ||
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
