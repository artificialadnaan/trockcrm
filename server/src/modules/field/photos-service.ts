import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import type { PhotoCategory, UserRole } from "@trock-crm/shared/types";
import { PHOTO_CATEGORIES } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { generateDownloadUrl, generateMockDownloadUrl, isR2Configured } from "../../lib/r2-client.js";
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
// Accept every value valid in the photo_category enum (the 6 offered phase
// categories + retained legacy values). Sourced from the shared single source of
// truth so adding a category never drifts from server validation.
const PHOTO_CATEGORY_VALUES = new Set<string>(PHOTO_CATEGORIES);
const PHOTO_ADDRESS_SOURCES = new Set(["exif", "live_gps"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_PENDING_LINKAGE_COLUMNS = ["contact_id", "procore_project_id", "change_order_id"] as const;
const LEGACY_LINKAGE_FALLBACK_SAVEPOINT = "field_photo_legacy_linkage_fallback";
const PENDING_LINKAGE_PROBE_SAVEPOINT = "field_photo_pending_linkage_probe";

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

export function assertValidUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError(400, `Invalid ${field}: must be a UUID.`);
  }
}

// Exported so the cross-office write routes can validate capture-target id FORMAT *before* resolving
// the deal's office — an invalid uuid must be a clean 400, not a `::uuid` cast error swallowed by the
// resolver's fan-out and reported as a misleading 503.
export function assertValidCaptureTargetIds(input: {
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
    // A freshly-uploaded photo is an R2 original with no resized variant, so full-res == the same URL.
    fullImageUrl: imageUrl,
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

function isMissingLegacyPendingLinkageColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "42703" && LEGACY_PENDING_LINKAGE_COLUMNS.some((column) => message.includes(column));
}

function createLegacyPendingLinkageExecutor(tenantDb: TenantDb) {
  let linkageModePromise: Promise<"modern" | "legacy" | null> | undefined;

  const detectPendingLinkageMode = async (): Promise<"modern" | "legacy" | null> => {
    if (!linkageModePromise) {
      linkageModePromise = (async () => {
        // The request uses a single transaction-bound client. If this schema
        // probe fails, Postgres aborts that transaction unless we isolate it
        // behind its own savepoint before falling back to the legacy query path.
        await tenantDb.execute(sql.raw(`SAVEPOINT ${PENDING_LINKAGE_PROBE_SAVEPOINT}`));
        try {
          const result = await tenantDb.execute(sql`
            SELECT COUNT(*)::int AS column_count
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'files'
              AND column_name IN (
                ${LEGACY_PENDING_LINKAGE_COLUMNS[0]},
                ${LEGACY_PENDING_LINKAGE_COLUMNS[1]},
                ${LEGACY_PENDING_LINKAGE_COLUMNS[2]}
              )
          `);
          await tenantDb.execute(sql.raw(`RELEASE SAVEPOINT ${PENDING_LINKAGE_PROBE_SAVEPOINT}`));
          const row = ((result as any).rows ?? result)?.[0];
          return Number(row?.column_count ?? 0) === LEGACY_PENDING_LINKAGE_COLUMNS.length ? "modern" : "legacy";
        } catch {
          await tenantDb.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${PENDING_LINKAGE_PROBE_SAVEPOINT}`));
          await tenantDb.execute(sql.raw(`RELEASE SAVEPOINT ${PENDING_LINKAGE_PROBE_SAVEPOINT}`));
          linkageModePromise = undefined;
          return null;
        }
      })();
    }

    return linkageModePromise;
  };

  const cachePendingLinkageMode = (mode: "modern" | "legacy"): void => {
    linkageModePromise = Promise.resolve(mode);
  };

  return async (
    // Keep the request transaction usable on legacy schemas by isolating the
    // probing query that may reference columns this tenant does not yet have.
    primaryQuery: SQL,
    fallbackQuery: SQL,
  ) => {
    const linkageMode = await detectPendingLinkageMode();
    if (linkageMode === "modern") {
      return tenantDb.execute(primaryQuery);
    }
    if (linkageMode === "legacy") {
      return tenantDb.execute(fallbackQuery);
    }

    await tenantDb.execute(sql.raw(`SAVEPOINT ${LEGACY_LINKAGE_FALLBACK_SAVEPOINT}`));

    try {
      const result = await tenantDb.execute(primaryQuery);
      await tenantDb.execute(sql.raw(`RELEASE SAVEPOINT ${LEGACY_LINKAGE_FALLBACK_SAVEPOINT}`));
      cachePendingLinkageMode("modern");
      return result;
    } catch (error) {
      await tenantDb.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${LEGACY_LINKAGE_FALLBACK_SAVEPOINT}`));
      await tenantDb.execute(sql.raw(`RELEASE SAVEPOINT ${LEGACY_LINKAGE_FALLBACK_SAVEPOINT}`));

      if (!isMissingLegacyPendingLinkageColumnError(error)) throw error;
      cachePendingLinkageMode("legacy");
      return tenantDb.execute(fallbackQuery);
    }
  };
}

async function buildFieldPhotoImageUrl(file: {
  r2Key: string | null;
  displayName: string;
  fileExtension: string | null;
}): Promise<string | null> {
  if (!file.r2Key) {
    return null;
  }

  const filename = `${file.displayName}${file.fileExtension ?? ""}`;
  if (isR2Configured()) {
    return generateDownloadUrl(file.r2Key, 3600, filename);
  }

  return generateMockDownloadUrl(file.r2Key);
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
    /**
     * The resolved (deal's) office slug this confirm is running in. The upload token's r2Key embeds the
     * office it was minted under (`office_<slug>/…`); we assert they match so a token can't be replayed
     * under a different office to file the row in the wrong schema. Optional for back-compat; when omitted
     * the assertion is skipped (single-office callers).
     */
    officeSlug?: string;
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
  // Token-office integrity: the r2Key was built under the office this upload was issued for. If the
  // confirm resolved to a different office (token replayed under another active office), the prefix
  // won't match — reject rather than file the row in the wrong schema.
  if (input.officeSlug && !pending.r2Key.startsWith(`office_${input.officeSlug}/`)) {
    throw new AppError(409, "Upload token was issued for a different office.");
  }
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
  const executeWithLegacyPendingLinkageFallback = createLegacyPendingLinkageExecutor(tenantDb);
  const result = await executeWithLegacyPendingLinkageFallback(
    sql`
    SELECT
      f.id,
      f.category,
      f.photo_category,
      f.subcategory,
      f.display_name,
      f.mime_type,
      f.file_size_bytes,
      f.file_extension,
      f.r2_key,
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
  `,
    sql`
      SELECT
        f.id,
        f.category,
        f.photo_category,
        f.subcategory,
        f.display_name,
        f.mime_type,
        f.file_size_bytes,
        f.file_extension,
        f.r2_key,
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
      ORDER BY COALESCE(f.taken_at, f.created_at) DESC
      LIMIT 50
    `,
  );

  const rows = (result as any).rows ?? result;
  const photos = await Promise.all(rows.map(async (row: any) => {
    // URL signing only touches R2/local helpers, so it is safe to parallelize.
    // Keep tenantDb queries serialized on the request-bound Postgres client.
    const imageUrl = await buildFieldPhotoImageUrl({
      r2Key: row.r2_key ?? null,
      displayName: row.display_name,
      fileExtension: row.file_extension ?? null,
    });
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
  const executeWithLegacyPendingLinkageFallback = createLegacyPendingLinkageExecutor(tenantDb);
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

  const existingResult = await executeWithLegacyPendingLinkageFallback(
    sql`
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
        AND f.contact_id IS NULL
        AND f.procore_project_id IS NULL
        AND f.change_order_id IS NULL
      LIMIT 1
    `,
    sql`
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
    `,
  );
  const existing = ((existingResult as any).rows ?? existingResult)[0];
  if (!existing) {
    throw new AppError(404, "Pending photo not found.");
  }

  const assignResult = await executeWithLegacyPendingLinkageFallback(
    sql`
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
  `,
    sql`
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
    `,
  );
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
