import { eq, and, desc, asc, ilike, sql, or, arrayContains, isNull, isNotNull, type SQL, type AnyColumn } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { companies, contacts, deals, files, leads, pipelineStageConfig, properties, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { FileCategory, PhotoCategory } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import {
  generateUploadUrl,
  generateDownloadUrl,
  generateMockUploadUrl,
  generateMockDownloadUrl,
  headObject,
  isR2Configured,
} from "../../lib/r2-client.js";
import {
  MAX_FILE_SIZE_BYTES,
  PRESIGNED_URL_EXPIRY_SECONDS,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  MIME_TO_EXTENSIONS,
  CATEGORY_TO_R2_SEGMENT,
  CATEGORY_TO_FOLDER,
  DEAL_FOLDER_TEMPLATE,
} from "./file-constants.js";
import { resolvePhotoAddressMetadata } from "./photo-geocoding.js";
import { buildDealPhotoTimelineConditions, type DealPhotoTimelineFilters } from "./photo-timeline-filters.js";
import crypto from "node:crypto";

type TenantDb = NodePgDatabase<typeof schema>;

// ─── Pending Uploads (Fix 2: bind confirm-upload to upload-url grant) ───────

interface PendingUpload {
  r2Key: string;
  systemFilename: string;
  displayName: string;
  folderPath: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  category: FileCategory;
  subcategory?: string;
  dealId?: string;
  leadId?: string;
  opportunityId?: string;
  contactId?: string;
  procoreProjectId?: number;
  changeOrderId?: string;
  description?: string;
  photoCategory?: PhotoCategory | null;
  tags?: string[];
  expiresAt: Date;
  /** Set when this upload is a new version of an existing file */
  parentFileId?: string;
  /** Version number — defaults to 1 for new files */
  version?: number;
}

const pendingUploads = new Map<string, PendingUpload>();

// Periodically clean expired pending uploads (every 5 minutes)
setInterval(() => {
  const now = new Date();
  for (const [token, pending] of pendingUploads) {
    if (pending.expiresAt < now) {
      pendingUploads.delete(token);
    }
  }
}, 5 * 60 * 1000);

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface RequestUploadInput {
  /** Original filename from the user's device */
  originalFilename: string;
  /** MIME type declared by the browser */
  mimeType: string;
  /** File size in bytes */
  fileSizeBytes: number;
  /** File category */
  category: FileCategory;
  /** Optional subcategory (e.g. "Site Visit", "Progress") */
  subcategory?: string;
  /** Target deal ID (at least one association required) */
  dealId?: string;
  /** Target lead ID; lead files follow converted deals through sourceLeadId lineage */
  leadId?: string;
  /** Target opportunity ID; stored as a deal-linked file because opportunities are deal records */
  opportunityId?: string;
  /** Target contact ID */
  contactId?: string;
  /** Target Procore project ID */
  procoreProjectId?: number;
  /** Target change order ID */
  changeOrderId?: string;
  /** Optional description */
  description?: string;
  /** Optional photo-only category label */
  photoCategory?: PhotoCategory | null;
  /** Optional tags */
  tags?: string[];
  /** Allow the upload to remain unassigned until a later field-app step */
  allowUnassigned?: boolean;
}

export interface ConfirmUploadInput {
  /** The upload token returned from the presigned URL request */
  uploadToken: string;
  /** EXIF data extracted client-side (optional, server also extracts for images) */
  takenAt?: string;
  geoLat?: number;
  geoLng?: number;
  latitude?: number;
  longitude?: number;
  addressSource?: "exif" | "live_gps";
}

export interface FileFilters {
  dealId?: string;
  leadId?: string;
  contactId?: string;
  procoreProjectId?: number;
  changeOrderId?: string;
  category?: FileCategory;
  fileKind?: "photos" | "documents";
  linkedType?: "deal" | "lead" | "contact" | "procore" | "change_order" | "unassigned";
  folderPath?: string;
  search?: string;
  tags?: string[];
  page?: number;
  limit?: number;
  sortBy?: "display_name" | "created_at" | "file_size_bytes" | "taken_at";
  sortDir?: "asc" | "desc";
}

export interface FileStats {
  totalFiles: number;
  totalPhotos: number;
  totalDocuments: number;
  totalBytes: number;
  recentUploads: number;
  dealsWithFiles: number;
}

export interface UpdateFileInput {
  displayName?: string;
  description?: string | null;
  notes?: string | null;
  tags?: string[];
  category?: FileCategory;
  subcategory?: string | null;
  folderPath?: string | null;
  photoCategory?: string | null;
  deletedAt?: Date | null;
  deletedByUserId?: string | null;
}

export interface UpdateFileAddressInput {
  address: string;
  latitude?: number;
  longitude?: number;
}

export interface PhotoUploadTarget {
  id: string;
  type: "lead" | "opportunity" | "deal";
  name: string;
  recordNumber: string | null;
  stageName: string | null;
  companyName: string | null;
  lastUpdatedAt: Date;
}

function validateOptionalCoordinate(value: number | undefined, min: number, max: number, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
    throw new AppError(400, `${name} must be between ${min} and ${max}.`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Validate that the MIME type is in the allowed list.
 */
function validateMimeType(mimeType: string): void {
  if (!ALLOWED_MIME_TYPES[mimeType]) {
    throw new AppError(400, `File type "${mimeType}" is not supported. Allowed types: images, PDF, Office documents, email exports, CSV, TXT, ZIP.`);
  }
}

/**
 * Validate file extension against allowed list.
 */
function validateExtension(filename: string): string {
  const ext = filename.lastIndexOf(".") >= 0
    ? filename.substring(filename.lastIndexOf(".")).toLowerCase()
    : "";

  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    throw new AppError(400, `File extension "${ext || "(none)"}" is not supported.`);
  }
  return ext;
}

/**
 * Validate that the declared MIME type corresponds to the file extension.
 * Prevents uploading a .exe disguised as image/jpeg, etc.
 */
function validateMimeMatchesExtension(mimeType: string, extension: string): void {
  const expectedExts = MIME_TO_EXTENSIONS[mimeType];
  if (!expectedExts || !expectedExts.includes(extension.toLowerCase())) {
    throw new AppError(400, `MIME type ${mimeType} does not match extension ${extension}`);
  }
}

function validateCategoryMatchesMime(category: FileCategory, mimeType: string): void {
  if (category === "photo" && !mimeType.toLowerCase().startsWith("image/")) {
    throw new AppError(400, "Photo uploads must use an image file type.");
  }
}

/**
 * Validate that at least one association is provided (no orphan files).
 */
function validateAssociations(input: {
  dealId?: string;
  leadId?: string;
  opportunityId?: string;
  contactId?: string;
  procoreProjectId?: number;
  changeOrderId?: string;
  allowUnassigned?: boolean;
}): void {
  if (input.allowUnassigned) {
    return;
  }
  if (!input.dealId && !input.leadId && !input.opportunityId && !input.contactId && !input.procoreProjectId && !input.changeOrderId) {
    throw new AppError(400, "File must be associated with at least one entity (lead, deal, contact, Procore project, or change order).");
  }
}

async function getDealLineageLeadId(tenantDb: TenantDb, dealId: string): Promise<string | null> {
  const [deal] = await tenantDb
    .select({ sourceLeadId: deals.sourceLeadId })
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);

  return deal?.sourceLeadId ?? null;
}

async function buildDealFileScopeCondition(tenantDb: TenantDb, dealId: string): Promise<SQL> {
  const sourceLeadId = await getDealLineageLeadId(tenantDb, dealId);
  if (!sourceLeadId) {
    return eq(files.dealId, dealId);
  }

  return or(eq(files.dealId, dealId), eq(files.leadId, sourceLeadId))!;
}

function activeLatestFileConditions(): SQL[] {
  return [
    eq(files.isActive, true),
    sql`NOT EXISTS (SELECT 1 FROM files f2 WHERE f2.parent_file_id = files.id AND f2.is_active = true)`,
  ];
}

function photoFileCondition(): SQL {
  return sql`(${files.category} = 'photo' OR ${files.mimeType} ILIKE 'image/%')`;
}

function documentFileCondition(): SQL {
  return sql`NOT (${photoFileCondition()})`;
}

function linkedFileCondition(linkedType: NonNullable<FileFilters["linkedType"]>): SQL {
  switch (linkedType) {
    case "deal":
      return isNotNull(files.dealId);
    case "lead":
      return isNotNull(files.leadId);
    case "contact":
      return isNotNull(files.contactId);
    case "procore":
      return isNotNull(files.procoreProjectId);
    case "change_order":
      return isNotNull(files.changeOrderId);
    case "unassigned":
      return and(
        isNull(files.dealId),
        isNull(files.leadId),
        isNull(files.contactId),
        isNull(files.procoreProjectId),
        isNull(files.changeOrderId)
      )!;
  }
}

/**
 * Validate file size does not exceed the 200 MB limit.
 */
function validateFileSize(sizeBytes: number): void {
  if (sizeBytes <= 0) {
    throw new AppError(400, "File size must be greater than 0.");
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new AppError(413, "File exceeds 200 MB limit.");
  }
}

/**
 * Generate the auto-naming system filename.
 * Pattern: {DealNumber}_{Category}_{YYYY-MM-DD}_{Seq}.{ext}
 * Falls back to a random-suffix name if no deal is associated.
 */
async function generateSystemFilename(
  tenantDb: TenantDb,
  dealId: string | undefined,
  category: FileCategory,
  ext: string,
  date: Date
): Promise<{ systemFilename: string; displayName: string }> {
  const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD
  const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1).replace(/_/g, "-");

  if (dealId) {
    // Look up deal number
    const [deal] = await tenantDb
      .select({ dealNumber: deals.dealNumber })
      .from(deals)
      .where(eq(deals.id, dealId))
      .limit(1);

    if (!deal) {
      throw new AppError(404, "Associated deal not found.");
    }

    // Acquire an advisory lock scoped to (dealNumber + category + date) to
    // prevent a race condition where concurrent uploads for the same deal,
    // category, and date could compute the same sequence number.
    // The lock is automatically released at the end of the transaction.
    await tenantDb.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${deal.dealNumber + category + dateStr}))`
    );

    // Count existing files for this deal + category + date to determine sequence
    const countResult = await tenantDb
      .select({ count: sql<number>`count(*)` })
      .from(files)
      .where(
        and(
          eq(files.dealId, dealId),
          eq(files.category, category),
          sql`DATE(${files.createdAt}) = ${dateStr}::date`
        )
      );

    const seq = Number(countResult[0]?.count ?? 0) + 1;
    const seqStr = String(seq).padStart(3, "0");

    // Fix 3: Append a short random suffix so systemFilename is unique even under concurrency
    const shortId = crypto.randomUUID().slice(0, 8);
    const systemFilename = `${deal.dealNumber}_${categoryLabel}_${dateStr}_${seqStr}_${shortId}${ext}`;
    const displayName = systemFilename.replace(ext, "").replace(/_/g, " ");

    return { systemFilename, displayName };
  }

  // No deal -- use a simpler naming scheme
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const systemFilename = `${categoryLabel}_${dateStr}_${randomSuffix}${ext}`;
  const displayName = systemFilename.replace(ext, "").replace(/_/g, " ");

  return { systemFilename, displayName };
}

/**
 * Build the R2 object key.
 * Pattern: office_{slug}/deals/{DealNumber}/{category}/{filename}
 * Or: office_{slug}/contacts/{contactId}/{category}/{filename}
 */
function buildR2Key(
  officeSlug: string,
  input: {
    dealNumber?: string;
    dealId?: string;
    leadId?: string;
    contactId?: string;
    procoreProjectId?: number;
    changeOrderId?: string;
    category: FileCategory;
    systemFilename: string;
  }
): string {
  const segment = CATEGORY_TO_R2_SEGMENT[input.category];

  if (input.dealNumber) {
    return `office_${officeSlug}/deals/${input.dealNumber}/${segment}/${input.systemFilename}`;
  }
  if (input.leadId) {
    return `office_${officeSlug}/leads/${input.leadId}/${segment}/${input.systemFilename}`;
  }
  if (input.contactId) {
    return `office_${officeSlug}/contacts/${input.contactId}/${segment}/${input.systemFilename}`;
  }
  if (input.procoreProjectId) {
    return `office_${officeSlug}/procore/${input.procoreProjectId}/${segment}/${input.systemFilename}`;
  }
  if (input.changeOrderId) {
    return `office_${officeSlug}/change-orders/${input.changeOrderId}/${segment}/${input.systemFilename}`;
  }

  return `office_${officeSlug}/unassociated/${segment}/${input.systemFilename}`;
}

/**
 * Build the virtual folder_path for a file.
 * For photo category files, appends a year-month date bucket (e.g. "2026-04")
 * derived from takenAt or createdAt so photos are organized chronologically:
 *   Photos/Site Visits/2026-04
 */
function buildFolderPath(
  category: FileCategory,
  subcategory?: string,
  dateForBucket?: Date
): string {
  const topFolder = CATEGORY_TO_FOLDER[category] || "Other";
  let path = topFolder;
  if (subcategory) {
    path = `${topFolder}/${subcategory}`;
  }

  // For photo files, append the year-month bucket
  if (category === "photo" && dateForBucket) {
    const yearMonth = dateForBucket.toISOString().slice(0, 7); // "YYYY-MM"
    path = `${path}/${yearMonth}`;
  }

  return path;
}

// ─── Service Functions ───────────────────────────────────────────────────────

/**
 * Step 1 of upload flow: validate input and generate presigned PUT URL.
 * Returns the presigned URL + the r2Key + file metadata for the frontend
 * to upload directly to R2.
 */
export async function requestUploadUrl(
  tenantDb: TenantDb,
  officeSlug: string,
  userId: string,
  input: RequestUploadInput
): Promise<{
  uploadUrl: string;
  r2Key: string;
  expiresIn: number;
  systemFilename: string;
  displayName: string;
  folderPath: string;
  uploadToken: string;
}> {
  // Validate everything before generating the presigned URL
  validateMimeType(input.mimeType);
  const ext = validateExtension(input.originalFilename);
  validateMimeMatchesExtension(input.mimeType, ext); // Fix 3: MIME must match extension
  validateCategoryMatchesMime(input.category, input.mimeType);
  validateFileSize(input.fileSizeBytes);
  validateAssociations(input);

  const now = new Date();

  // Generate system filename (requires DB lookup for deal number + sequence)
  const { systemFilename, displayName } = await generateSystemFilename(
    tenantDb,
    input.dealId,
    input.category,
    ext,
    now
  );

  // Look up deal number for R2 key path
  let dealNumber: string | undefined;
  if (input.dealId) {
    const [deal] = await tenantDb
      .select({ dealNumber: deals.dealNumber })
      .from(deals)
      .where(eq(deals.id, input.dealId))
      .limit(1);
    dealNumber = deal?.dealNumber;
  }

  // Build R2 key with UUID prefix to prevent collision (Fix 4)
  const baseR2Key = buildR2Key(officeSlug, {
    dealNumber,
    dealId: input.dealId,
    leadId: input.leadId,
    contactId: input.contactId,
    procoreProjectId: input.procoreProjectId,
    changeOrderId: input.changeOrderId,
    category: input.category,
    systemFilename,
  });
  // Insert a UUID before the filename in the key for collision safety
  const keyParts = baseR2Key.split("/");
  const filename = keyParts.pop()!;
  const r2Key = [...keyParts, `${crypto.randomUUID()}-${filename}`].join("/");

  // Build folder path (pass date for photo category date-bucketing)
  const folderPath = buildFolderPath(input.category, input.subcategory, now);

  // Generate presigned URL (or mock in dev)
  let uploadResult: { uploadUrl: string; r2Key: string; expiresIn: number };
  if (isR2Configured()) {
    uploadResult = await generateUploadUrl(r2Key, input.mimeType, input.fileSizeBytes);
  } else {
    uploadResult = generateMockUploadUrl(r2Key);
  }

  // Fix 2: Store pending upload and generate upload token
  const uploadToken = crypto.randomUUID();
  pendingUploads.set(uploadToken, {
    r2Key,
    systemFilename,
    displayName,
    folderPath,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    fileSizeBytes: input.fileSizeBytes,
    category: input.category,
    subcategory: input.subcategory,
    dealId: input.dealId,
    leadId: input.leadId,
    opportunityId: input.opportunityId,
    contactId: input.contactId,
    procoreProjectId: input.procoreProjectId,
    changeOrderId: input.changeOrderId,
    description: input.description,
    photoCategory: input.photoCategory,
    tags: input.tags,
    expiresAt: new Date(Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000),
  });

  return {
    ...uploadResult,
    systemFilename,
    displayName,
    folderPath,
    uploadToken,
  };
}

/**
 * Step 2 of upload flow: browser has uploaded the file to R2.
 * Consumes the pending upload token to retrieve server-trusted metadata,
 * verifies the R2 object exists, then creates the file record.
 */
export async function confirmUpload(
  tenantDb: TenantDb,
  userId: string,
  input: ConfirmUploadInput
): Promise<typeof files.$inferSelect> {
  // Fix 2: Consume the pending upload token — don't trust client-supplied values
  // Fix 7: Don't delete token until after DB insert succeeds — allows retry on
  // transient failures. NOTE: pendingUploads is process-local (in-memory Map).
  // This is fine for single-instance Railway deployment. If multi-instance is
  // needed, move pending uploads to DB-backed storage (e.g. a pending_uploads table).
  const pending = pendingUploads.get(input.uploadToken);
  if (!pending || pending.expiresAt < new Date()) {
    pendingUploads.delete(input.uploadToken);
    throw new AppError(400, "Invalid or expired upload token");
  }
  // Do NOT delete yet — verify and insert first so client can retry on failure

  // ── Verify the R2 object before persisting metadata ──────────────
  if (isR2Configured()) {
    const head = await headObject(pending.r2Key);
    if (!head) {
      throw new AppError(400, "Upload verification failed: object not found in R2. The file may not have been uploaded.");
    }
    if (head.contentType && head.contentType !== pending.mimeType) {
      throw new AppError(400, `Upload verification failed: Content-Type mismatch. Expected "${pending.mimeType}", got "${head.contentType}".`);
    }
    if (head.contentLength != null && head.contentLength !== pending.fileSizeBytes) {
      throw new AppError(400, `Upload verification failed: Content-Length mismatch. Expected ${pending.fileSizeBytes} bytes, got ${head.contentLength}.`);
    }
  }

  const ext = pending.originalFilename.lastIndexOf(".") >= 0
    ? pending.originalFilename.substring(pending.originalFilename.lastIndexOf(".")).toLowerCase()
    : "";

  const bucketName = process.env.R2_BUCKET_NAME || "trock-crm-files";
  const latitude = input.latitude ?? input.geoLat;
  const longitude = input.longitude ?? input.geoLng;
  const photoAddress = pending.category === "photo"
    ? await resolvePhotoAddressMetadata(tenantDb, pending, {
      latitude,
      longitude,
      addressSource: input.addressSource ?? (input.geoLat !== undefined || input.geoLng !== undefined ? "exif" : undefined),
    })
    : {
      latitude: null,
      longitude: null,
      geoLat: input.geoLat?.toString() ?? null,
      geoLng: input.geoLng?.toString() ?? null,
      address: null,
      addressSource: null,
      geocodedAt: null,
    };

  const result = await tenantDb
    .insert(files)
    .values({
      category: pending.category,
      subcategory: pending.subcategory ?? null,
      folderPath: pending.folderPath,
      tags: pending.tags ?? [],
      displayName: pending.displayName,
      systemFilename: pending.systemFilename,
      originalFilename: pending.originalFilename,
      mimeType: pending.mimeType,
      fileSizeBytes: pending.fileSizeBytes,
      fileExtension: ext,
      r2Key: pending.r2Key,
      r2Bucket: bucketName,
      dealId: pending.dealId ?? null,
      leadId: pending.leadId ?? null,
      contactId: pending.contactId ?? null,
      procoreProjectId: pending.procoreProjectId ?? null,
      changeOrderId: pending.changeOrderId ?? null,
      description: pending.description ?? null,
      photoCategory: pending.photoCategory ?? null,
      notes: null,
      version: pending.version ?? 1,
      parentFileId: pending.parentFileId ?? null,
      takenAt: input.takenAt ? new Date(input.takenAt) : null,
      geoLat: photoAddress.geoLat,
      geoLng: photoAddress.geoLng,
      latitude: photoAddress.latitude,
      longitude: photoAddress.longitude,
      address: photoAddress.address,
      addressSource: photoAddress.addressSource,
      geocodedAt: photoAddress.geocodedAt,
      uploadedBy: userId,
    })
    .returning();

  // Fix 7: NOW delete the token — DB insert succeeded, no retry needed
  pendingUploads.delete(input.uploadToken);

  return result[0];
}

export function getPendingUploadMetadata(uploadToken: string): Readonly<PendingUpload> | null {
  const pending = pendingUploads.get(uploadToken);
  if (!pending || pending.expiresAt < new Date()) return null;
  return pending;
}

/**
 * Upload a new version of an existing file.
 * Creates a new file record with parent_file_id pointing to the original.
 */
export async function uploadNewVersion(
  tenantDb: TenantDb,
  officeSlug: string,
  userId: string,
  parentFileId: string,
  input: RequestUploadInput
): Promise<{
  uploadUrl: string;
  r2Key: string;
  expiresIn: number;
  systemFilename: string;
  displayName: string;
  folderPath: string;
  version: number;
  parentFileId: string;
}> {
  // Find the original file (root of the version chain)
  const [parentFile] = await tenantDb
    .select()
    .from(files)
    .where(and(eq(files.id, parentFileId), eq(files.isActive, true)))
    .limit(1);

  if (!parentFile) {
    throw new AppError(404, "Parent file not found.");
  }

  // Find the root file (walk up the chain)
  let rootFileId = parentFile.parentFileId ?? parentFile.id;
  if (parentFile.parentFileId) {
    const [root] = await tenantDb
      .select()
      .from(files)
      .where(eq(files.id, parentFile.parentFileId))
      .limit(1);
    if (root) rootFileId = root.id;
  }

  // Count existing versions to determine the new version number
  const countResult = await tenantDb
    .select({ count: sql<number>`count(*)` })
    .from(files)
    .where(
      or(
        eq(files.id, rootFileId),
        eq(files.parentFileId, rootFileId)
      )
    );

  const newVersion = Number(countResult[0]?.count ?? 1) + 1;

  // Inherit associations from parent file
  const mergedInput: RequestUploadInput = {
    ...input,
    dealId: input.dealId ?? parentFile.dealId ?? undefined,
    contactId: input.contactId ?? parentFile.contactId ?? undefined,
    procoreProjectId: input.procoreProjectId ?? parentFile.procoreProjectId ?? undefined,
    changeOrderId: input.changeOrderId ?? parentFile.changeOrderId ?? undefined,
    category: input.category ?? parentFile.category,
    subcategory: input.subcategory ?? parentFile.subcategory ?? undefined,
    tags: input.tags ?? Array.from(parentFile.tags),
  };

  const result = await requestUploadUrl(tenantDb, officeSlug, userId, mergedInput);

  // Fix 1: Store version metadata in the pending upload so confirmUpload()
  // persists the correct version and parentFileId instead of defaults.
  const pendingEntry = pendingUploads.get(result.uploadToken);
  if (pendingEntry) {
    pendingEntry.parentFileId = rootFileId;
    pendingEntry.version = newVersion;
  }

  return {
    ...result,
    version: newVersion,
    parentFileId: rootFileId,
  };
}

/**
 * Get a paginated, filtered, sorted list of files.
 */
export async function getFiles(tenantDb: TenantDb, filters: FileFilters) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const offset = (page - 1) * limit;

  const conditions: SQL[] = activeLatestFileConditions();

  if (filters.dealId) conditions.push(await buildDealFileScopeCondition(tenantDb, filters.dealId));
  if (filters.leadId) conditions.push(eq(files.leadId, filters.leadId));
  if (filters.contactId) conditions.push(eq(files.contactId, filters.contactId));
  if (filters.procoreProjectId) conditions.push(eq(files.procoreProjectId, filters.procoreProjectId));
  if (filters.changeOrderId) conditions.push(eq(files.changeOrderId, filters.changeOrderId));
  if (filters.category) conditions.push(eq(files.category, filters.category));
  if (filters.fileKind === "photos") conditions.push(photoFileCondition());
  if (filters.fileKind === "documents") conditions.push(documentFileCondition());
  if (filters.linkedType) conditions.push(linkedFileCondition(filters.linkedType));

  // Folder path filtering: exact match or prefix match for nested folders
  if (filters.folderPath) {
    conditions.push(
      or(
        eq(files.folderPath, filters.folderPath),
        ilike(files.folderPath, `${filters.folderPath}/%`)
      )!
    );
  }

  // Tag filtering: files that contain ALL specified tags
  if (filters.tags && filters.tags.length > 0) {
    conditions.push(arrayContains(files.tags, filters.tags));
  }

  // Full-text search via the search_vector column
  if (filters.search && filters.search.trim().length >= 2) {
    const searchTerm = filters.search.trim().replace(/[^\w\s-]/g, "").trim().split(/\s+/).filter(Boolean).join(" & ");
    if (searchTerm.length > 0) {
      conditions.push(
        sql`search_vector @@ to_tsquery('english', ${searchTerm})`
      );
    }
  }

  const where = and(...conditions);

  // Sort
  const sortColumn = (() => {
    switch (filters.sortBy) {
      case "display_name": return files.displayName;
      case "file_size_bytes": return files.fileSizeBytes;
      case "taken_at": return files.takenAt;
      default: return files.createdAt;
    }
  })();
  const sortOrder = filters.sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const countResult = await tenantDb.select({ count: sql<number>`count(*)` }).from(files).where(where);
  const fileRows = await tenantDb
    .select()
    .from(files)
    .where(where)
    .orderBy(sortOrder)
    .limit(limit)
    .offset(offset);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    files: fileRows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getFileStats(tenantDb: TenantDb, _filters: Record<string, never> = {}): Promise<FileStats> {
  const where = and(...activeLatestFileConditions());
  const photoCondition = photoFileCondition();

  const [row] = await tenantDb
    .select({
      totalFiles: sql<number>`count(*)`,
      totalPhotos: sql<number>`count(*) FILTER (WHERE ${photoCondition})`,
      totalDocuments: sql<number>`count(*) FILTER (WHERE NOT (${photoCondition}))`,
      totalBytes: sql<number>`coalesce(sum(${files.fileSizeBytes}), 0)`,
      recentUploads: sql<number>`count(*) FILTER (WHERE ${files.createdAt} >= now() - interval '3 days')`,
      dealsWithFiles: sql<number>`count(DISTINCT ${files.dealId}) FILTER (WHERE ${files.dealId} IS NOT NULL)`,
    })
    .from(files)
    .where(where);

  return {
    totalFiles: Number(row?.totalFiles ?? 0),
    totalPhotos: Number(row?.totalPhotos ?? 0),
    totalDocuments: Number(row?.totalDocuments ?? 0),
    totalBytes: Number(row?.totalBytes ?? 0),
    recentUploads: Number(row?.recentUploads ?? 0),
    dealsWithFiles: Number(row?.dealsWithFiles ?? 0),
  };
}

/** Escape LIKE/ILIKE wildcards in user input so '%' and '_' match literally. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Search columns for the LEAD side of the photo picker. Mirrors the main leads
 * search (buildAliasedLeadSearchCondition) so a lead found in the regular leads
 * list — by site/property address, on-site contact, or source — is also findable
 * here. Previously only name/company/stage were searched, which hid leads when a
 * user searched by the natural "where is the job" fields. See
 * .audit/trockcam-leads-photos.md (root cause G2).
 *
 * Requires the picker query to leftJoin companies, properties, contacts and
 * pipelineStageConfig.
 */
export function buildPhotoTargetLeadSearchCondition(search: string): SQL {
  const term = `%${escapeLikePattern(search.trim())}%`;
  return or(
    sql`${leads.name} ILIKE ${term} ESCAPE '\\'`,
    sql`${leads.source} ILIKE ${term} ESCAPE '\\'`,
    sql`${leads.sourceDetail} ILIKE ${term} ESCAPE '\\'`,
    sql`${leads.description} ILIKE ${term} ESCAPE '\\'`,
    sql`${companies.name} ILIKE ${term} ESCAPE '\\'`,
    sql`${properties.name} ILIKE ${term} ESCAPE '\\'`,
    sql`${properties.address} ILIKE ${term} ESCAPE '\\'`,
    sql`${properties.city} ILIKE ${term} ESCAPE '\\'`,
    sql`${properties.state} ILIKE ${term} ESCAPE '\\'`,
    sql`${contacts.firstName} ILIKE ${term} ESCAPE '\\'`,
    sql`${contacts.lastName} ILIKE ${term} ESCAPE '\\'`,
    sql`CONCAT(${contacts.firstName}, ' ', ${contacts.lastName}) ILIKE ${term} ESCAPE '\\'`,
    sql`${pipelineStageConfig.name} ILIKE ${term} ESCAPE '\\'`
  )!;
}

/**
 * Search columns for the DEAL side of the photo picker. Mirrors
 * buildDealSearchCondition (deal number, name, description, source, company,
 * property address/city/state, primary contact name).
 *
 * Requires the picker query to leftJoin companies, properties, contacts and
 * pipelineStageConfig.
 */
export function buildPhotoTargetDealSearchCondition(search: string): SQL {
  const term = `%${escapeLikePattern(search.trim())}%`;
  return or(
    sql`${deals.name} ILIKE ${term} ESCAPE '\\'`,
    sql`${deals.dealNumber} ILIKE ${term} ESCAPE '\\'`,
    sql`${deals.description} ILIKE ${term} ESCAPE '\\'`,
    sql`${deals.source} ILIKE ${term} ESCAPE '\\'`,
    sql`${companies.name} ILIKE ${term} ESCAPE '\\'`,
    sql`${properties.name} ILIKE ${term} ESCAPE '\\'`,
    sql`${properties.address} ILIKE ${term} ESCAPE '\\'`,
    sql`${properties.city} ILIKE ${term} ESCAPE '\\'`,
    sql`${properties.state} ILIKE ${term} ESCAPE '\\'`,
    sql`${contacts.firstName} ILIKE ${term} ESCAPE '\\'`,
    sql`${contacts.lastName} ILIKE ${term} ESCAPE '\\'`,
    sql`CONCAT(${contacts.firstName}, ' ', ${contacts.lastName}) ILIKE ${term} ESCAPE '\\'`,
    sql`${pipelineStageConfig.name} ILIKE ${term} ESCAPE '\\'`
  )!;
}

/** Rank a single value against the search term: exact=3, prefix=2, substring=1, else 0. */
function photoTargetMatchRank(value: string | null | undefined, needle: string): number {
  const haystack = (value ?? "").trim().toLowerCase();
  const term = needle.trim().toLowerCase();
  if (!haystack || !term) return 0;
  if (haystack === term) return 3;
  if (haystack.startsWith(term)) return 2;
  if (haystack.includes(term)) return 1;
  return 0;
}

/**
 * Relevance of a target to the search term, based on its display name and
 * record number. Used to keep precise matches ahead of merely more-recent ones.
 */
export function photoTargetRelevanceScore(
  target: Pick<PhotoUploadTarget, "name" | "recordNumber">,
  search: string
): number {
  if (!search.trim()) return 0;
  return Math.max(photoTargetMatchRank(target.name, search), photoTargetMatchRank(target.recordNumber, search));
}

/**
 * Order targets by relevance (exact > prefix > substring), then by recency. This
 * replaces the old pure-recency ordering so a strong match is not truncated by
 * the result cap just because other records were updated more recently. See
 * .audit/trockcam-leads-photos.md (root cause G3). Returns a new array.
 */
export function sortPhotoTargetsByRelevance<
  T extends Pick<PhotoUploadTarget, "name" | "recordNumber" | "lastUpdatedAt">
>(targets: T[], search: string): T[] {
  return [...targets].sort((left, right) => {
    const scoreDelta = photoTargetRelevanceScore(right, search) - photoTargetRelevanceScore(left, search);
    if (scoreDelta !== 0) return scoreDelta;
    return right.lastUpdatedAt.getTime() - left.lastUpdatedAt.getTime();
  });
}

/**
 * SQL relevance expression mirroring photoTargetMatchRank, taking the GREATEST
 * rank across the given columns (e.g. deal name + deal number). Used in ORDER BY
 * so the per-type LIMIT keeps the most relevant rows, not just the most recent.
 */
function photoTargetSqlRelevance(columns: AnyColumn[], search: string): SQL<number> {
  const trimmed = search.trim();
  if (!trimmed || columns.length === 0) return sql<number>`0`;
  const escaped = escapeLikePattern(trimmed);
  const exact = escaped;
  const prefix = `${escaped}%`;
  const substring = `%${escaped}%`;
  const ranks = columns.map(
    (column) => sql`(CASE
      WHEN ${column} ILIKE ${exact} ESCAPE '\\' THEN 3
      WHEN ${column} ILIKE ${prefix} ESCAPE '\\' THEN 2
      WHEN ${column} ILIKE ${substring} ESCAPE '\\' THEN 1
      ELSE 0 END)`
  );
  if (ranks.length === 1) return sql<number>`${ranks[0]}`;
  return sql<number>`GREATEST(${sql.join(ranks, sql`, `)})`;
}

export async function searchPhotoUploadTargets(
  tenantDb: TenantDb,
  input: { search?: string; limit?: number; userRole?: string; userId?: string }
): Promise<{ targets: PhotoUploadTarget[] }> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 60);
  const trimmed = input.search?.trim() ?? "";
  const hasSearch = trimmed.length > 0;

  const leadConditions: SQL[] = [];
  const dealConditions: SQL[] = [];
  // The WEB photo picker route intentionally does NOT pass userId/userRole, so
  // this rep-scoping branch stays dead on web: anyone in the company must be able
  // to find ANY lead/deal to attach photos (creator-agnostic by design — see
  // .audit/trockcam-leads-photos.md Q5). Do NOT wire user context into the web
  // route. The field app DOES pass them, so the field picker stays rep-scoped.
  //
  // KNOWN FOLLOW-UP (not in this change): this query runs on a single office's
  // schema (search_path = office_<slug>,public), so it cannot find leads/deals in
  // OTHER offices. Cross-office search is a separate structural item (G1).
  if (input.userRole === "rep" && input.userId) {
    leadConditions.push(eq(leads.assignedRepId, input.userId));
    dealConditions.push(eq(deals.assignedRepId, input.userId));
  }
  if (hasSearch) {
    leadConditions.push(buildPhotoTargetLeadSearchCondition(trimmed));
    dealConditions.push(buildPhotoTargetDealSearchCondition(trimmed));
  }

  // Order by relevance first, then recency — but ONLY when there is a search
  // term. With no term the relevance expression is a constant, and Postgres reads
  // a constant integer in ORDER BY as a (out-of-range) column ordinal and errors,
  // so the browse-all case orders by recency alone.
  const leadOrder = hasSearch
    ? [desc(photoTargetSqlRelevance([leads.name], trimmed)), desc(leads.updatedAt)]
    : [desc(leads.updatedAt)];
  const dealOrder = hasSearch
    ? [desc(photoTargetSqlRelevance([deals.name, deals.dealNumber], trimmed)), desc(deals.updatedAt)]
    : [desc(deals.updatedAt)];

  const leadRows = await tenantDb
    .select({
      id: leads.id,
      name: leads.name,
      stageName: pipelineStageConfig.name,
      companyName: companies.name,
      lastUpdatedAt: leads.updatedAt,
    })
    .from(leads)
    .leftJoin(companies, eq(companies.id, leads.companyId))
    .leftJoin(properties, eq(properties.id, leads.propertyId))
    .leftJoin(contacts, eq(contacts.id, leads.primaryContactId))
    .leftJoin(pipelineStageConfig, eq(pipelineStageConfig.id, leads.stageId))
    .where(leadConditions.length > 0 ? and(...leadConditions) : sql`true`)
    .orderBy(...leadOrder)
    .limit(limit);
  const dealRows = await tenantDb
    .select({
      id: deals.id,
      name: deals.name,
      dealNumber: deals.dealNumber,
      pipelineDisposition: deals.pipelineDisposition,
      stageName: pipelineStageConfig.name,
      companyName: companies.name,
      lastUpdatedAt: deals.updatedAt,
    })
    .from(deals)
    .leftJoin(companies, eq(companies.id, deals.companyId))
    .leftJoin(properties, eq(properties.id, deals.propertyId))
    .leftJoin(contacts, eq(contacts.id, deals.primaryContactId))
    .leftJoin(pipelineStageConfig, eq(pipelineStageConfig.id, deals.stageId))
    .where(dealConditions.length > 0 ? and(...dealConditions) : sql`true`)
    .orderBy(...dealOrder)
    .limit(limit);

  const targets: PhotoUploadTarget[] = [
    ...leadRows.map((row) => ({
      id: row.id,
      type: "lead" as const,
      name: row.name,
      recordNumber: null,
      stageName: row.stageName ?? null,
      companyName: row.companyName ?? null,
      lastUpdatedAt: row.lastUpdatedAt,
    })),
    ...dealRows.map((row) => ({
      id: row.id,
      type: row.pipelineDisposition === "opportunity" ? ("opportunity" as const) : ("deal" as const),
      name: row.name,
      recordNumber: row.dealNumber,
      stageName: row.stageName ?? null,
      companyName: row.companyName ?? null,
      lastUpdatedAt: row.lastUpdatedAt,
    })),
  ];

  return { targets: sortPhotoTargetsByRelevance(targets, trimmed).slice(0, limit) };
}

/**
 * Get a single file by ID.
 */
export async function getFileById(
  tenantDb: TenantDb,
  fileId: string
): Promise<typeof files.$inferSelect | null> {
  const [file] = await tenantDb
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.isActive, true)))
    .limit(1);

  return file ?? null;
}

export async function getFileByIdIncludingDeleted(
  tenantDb: TenantDb,
  fileId: string
): Promise<typeof files.$inferSelect | null> {
  const [file] = await tenantDb
    .select()
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);

  return file ?? null;
}

/**
 * Get a presigned download URL for a file.
 */
export async function buildFileDownloadUrlFromRecord(file: {
  r2Key: string;
  displayName: string;
  fileExtension?: string | null;
}): Promise<{ url: string; filename: string }> {
  const filename = file.displayName + (file.fileExtension ?? "");
  const url = isR2Configured()
    ? await generateDownloadUrl(file.r2Key, 3600, filename)
    : generateMockDownloadUrl(file.r2Key);

  return { url, filename };
}

export async function getFileDownloadUrl(
  tenantDb: TenantDb,
  fileId: string
): Promise<{ url: string; filename: string }> {
  const file = await getFileById(tenantDb, fileId);
  if (!file) throw new AppError(404, "File not found");

  return buildFileDownloadUrlFromRecord(file);
}

export function shouldServeExternalFileUrl(file: {
  r2Key?: string | null;
  externalUrl?: string | null;
}): boolean {
  return !file.r2Key && Boolean(file.externalUrl);
}

export function shouldLogFileDownloadEvent(query: { preview?: unknown }): boolean {
  void query;
  return true;
}

export function resolveFileDownloadAuditPurpose(query: { preview?: unknown }): "preview" | "download" {
  return query.preview === "1" || query.preview === "true" ? "preview" : "download";
}

/**
 * Update file metadata (display name, tags, description, notes, category).
 */
export async function updateFile(
  tenantDb: TenantDb,
  fileId: string,
  input: UpdateFileInput
): Promise<typeof files.$inferSelect> {
  const existing = input.deletedAt === null
    ? await getFileByIdIncludingDeleted(tenantDb, fileId)
    : await getFileById(tenantDb, fileId);
  if (!existing) throw new AppError(404, "File not found");

  const updates: Record<string, unknown> = {};
  if (input.displayName !== undefined) updates.displayName = input.displayName;
  if (input.description !== undefined) updates.description = input.description;
  if (input.notes !== undefined) updates.notes = input.notes;
  if (input.tags !== undefined) updates.tags = input.tags;
  if (input.category !== undefined) updates.category = input.category;
  if (input.subcategory !== undefined) updates.subcategory = input.subcategory;
  if (input.folderPath !== undefined) updates.folderPath = input.folderPath;
  if (input.photoCategory !== undefined) updates.photoCategory = input.photoCategory;
  if (input.deletedAt !== undefined) {
    updates.deletedAt = input.deletedAt;
    updates.isActive = input.deletedAt == null;
  }
  if (input.deletedByUserId !== undefined) updates.deletedByUserId = input.deletedByUserId;

  if (Object.keys(updates).length === 0) return existing;

  const result = await tenantDb
    .update(files)
    .set(updates)
    .where(eq(files.id, fileId))
    .returning();

  return result[0];
}

/**
 * Manually override a photo address. Audit log writes are added in PR 4.
 */
export async function updateFileAddress(
  tenantDb: TenantDb,
  fileId: string,
  input: UpdateFileAddressInput
): Promise<typeof files.$inferSelect> {
  const existing = await getFileById(tenantDb, fileId);
  if (!existing) throw new AppError(404, "File not found");
  if (!input.address?.trim()) throw new AppError(400, "address is required.");
  validateOptionalCoordinate(input.latitude, -90, 90, "latitude");
  validateOptionalCoordinate(input.longitude, -180, 180, "longitude");

  const updates: Record<string, unknown> = {
    address: input.address.trim(),
    addressSource: "manual_override",
  };
  if (input.latitude !== undefined) updates.latitude = input.latitude.toFixed(7);
  if (input.longitude !== undefined) updates.longitude = input.longitude.toFixed(7);

  const result = await tenantDb
    .update(files)
    .set(updates)
    .where(eq(files.id, fileId))
    .returning();

  return result[0];
}

/**
 * Soft-delete a file.
 */
export async function deleteFile(
  tenantDb: TenantDb,
  fileId: string,
  _userRole: string,
  userId?: string
): Promise<typeof files.$inferSelect | null> {
  const [existing] = await tenantDb.select().from(files).where(eq(files.id, fileId)).limit(1);
  if (!existing) throw new AppError(404, "File not found");
  if (!existing.isActive) return null;

  const result = await tenantDb
    .update(files)
    .set({ isActive: false, deletedAt: new Date(), deletedByUserId: userId ?? null })
    .where(eq(files.id, fileId))
    .returning();

  if (result.length === 0) throw new AppError(404, "File not found");
  return result[0];
}

/**
 * Get the version history chain for a file.
 * Returns all versions ordered by version number ascending.
 */
export async function getFileVersions(
  tenantDb: TenantDb,
  fileId: string
): Promise<Array<typeof files.$inferSelect>> {
  const file = await getFileById(tenantDb, fileId);
  if (!file) throw new AppError(404, "File not found");

  // Determine the root of the version chain
  const rootId = file.parentFileId ?? file.id;

  const versions = await tenantDb
    .select()
    .from(files)
    .where(
      and(
        or(eq(files.id, rootId), eq(files.parentFileId, rootId)),
        eq(files.isActive, true)
      )
    )
    .orderBy(asc(files.version));

  return versions;
}

/**
 * Get all distinct tags used across files in a deal (for autocomplete).
 */
export async function getTagSuggestions(
  tenantDb: TenantDb,
  dealId?: string
): Promise<string[]> {
  const conditions: SQL[] = [eq(files.isActive, true)];
  if (dealId) conditions.push(await buildDealFileScopeCondition(tenantDb, dealId));

  const result = await tenantDb
    .select({ tags: files.tags })
    .from(files)
    .where(and(...conditions));

  // Flatten and deduplicate all tags
  const tagSet = new Set<string>();
  for (const row of result) {
    for (const tag of row.tags) {
      tagSet.add(tag.toLowerCase());
    }
  }

  return Array.from(tagSet).sort();
}

/**
 * Get the virtual folder structure for a deal.
 * Returns the template with file counts per folder.
 */
export async function getDealFolderTree(
  tenantDb: TenantDb,
  dealId: string
): Promise<Array<{
  name: string;
  path: string;
  category: FileCategory;
  count: number;
  subfolders: Array<{ name: string; path: string; count: number }>;
}>> {
  // Get all active files for this deal, grouped by folder_path
  const fileCounts = await tenantDb
    .select({
      folderPath: files.folderPath,
      count: sql<number>`count(*)`,
    })
    .from(files)
    .where(and(await buildDealFileScopeCondition(tenantDb, dealId), eq(files.isActive, true)))
    .groupBy(files.folderPath);

  const countMap = new Map<string | null, number>();
  for (const row of fileCounts) {
    countMap.set(row.folderPath, Number(row.count));
  }

  // Build the tree from the template.
  // Fix 9: For photo buckets (and similar), aggregate counts by prefix
  // so date-bucketed paths like "Photos/Site Visits/2026-04" roll up
  // into the "Photos/Site Visits" subfolder node.
  return Object.entries(DEAL_FOLDER_TEMPLATE).map(([folderName, config]) => {
    const topPath = folderName;
    let topCount = countMap.get(topPath) ?? 0;

    const subfolders = config.subfolders.map((subName) => {
      const subPath = `${folderName}/${subName}`;
      // Exact match count
      let subCount = countMap.get(subPath) ?? 0;
      // Also aggregate any nested paths (e.g. "Photos/Site Visits/2026-04")
      for (const [path, count] of countMap) {
        if (path != null && path.startsWith(subPath + "/")) {
          subCount += count;
        }
      }
      topCount += subCount;
      return { name: subName, path: subPath, count: subCount };
    });

    // Also aggregate any folder_path entries that are directly under the
    // top folder but not in a known subfolder (e.g. "Photos/2026-04" with
    // no subcategory).
    for (const [path, count] of countMap) {
      if (path != null && path !== topPath && path.startsWith(topPath + "/")) {
        // Check it wasn't already counted in a subfolder
        const isInSubfolder = config.subfolders.some(
          (sub) => path === `${topPath}/${sub}` || path.startsWith(`${topPath}/${sub}/`)
        );
        if (!isInSubfolder) {
          topCount += count;
        }
      }
    }

    return {
      name: folderName,
      path: topPath,
      category: config.category,
      count: topCount,
      subfolders,
    };
  });
}

/**
 * Get photos for a deal in chronological order (for photo timeline).
 * Uses taken_at (EXIF) with fallback to created_at.
 */
export async function getDealPhotoTimeline(
  tenantDb: TenantDb,
  dealId: string,
  page: number = 1,
  limit: number = 50,
  filters: DealPhotoTimelineFilters = {}
): Promise<{
  photos: Array<typeof files.$inferSelect & { uploaderName: string; uploaderAvatarUrl: string | null }>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const offset = (page - 1) * limit;
  const conditions = await buildDealPhotoTimelineConditions(tenantDb, dealId, filters);

  const countResult = await tenantDb.select({ count: sql<number>`count(*)` }).from(files).where(conditions);
  const photoRows = await tenantDb
    .select({
      id: files.id,
      category: files.category,
      subcategory: files.subcategory,
      folderPath: files.folderPath,
      tags: files.tags,
      displayName: files.displayName,
      systemFilename: files.systemFilename,
      originalFilename: files.originalFilename,
      mimeType: files.mimeType,
      fileSizeBytes: files.fileSizeBytes,
      fileExtension: files.fileExtension,
      r2Key: files.r2Key,
      r2Bucket: files.r2Bucket,
      dealId: files.dealId,
      leadId: files.leadId,
      intakeSection: files.intakeSection,
      intakeRequirementKey: files.intakeRequirementKey,
      intakeSource: files.intakeSource,
      contactId: files.contactId,
      procoreProjectId: files.procoreProjectId,
      changeOrderId: files.changeOrderId,
      externalUrl: files.externalUrl,
      externalThumbnailUrl: files.externalThumbnailUrl,
      companycamPhotoId: files.companycamPhotoId,
      description: files.description,
      notes: files.notes,
      version: files.version,
      parentFileId: files.parentFileId,
      takenAt: files.takenAt,
      geoLat: files.geoLat,
      geoLng: files.geoLng,
      latitude: files.latitude,
      longitude: files.longitude,
      address: files.address,
      addressSource: files.addressSource,
      geocodedAt: files.geocodedAt,
      photoCategory: files.photoCategory,
      deletedAt: files.deletedAt,
      deletedByUserId: files.deletedByUserId,
      procoreSyncStatus: files.procoreSyncStatus,
      procorePhotoId: files.procorePhotoId,
      uploadedBy: files.uploadedBy,
      isActive: files.isActive,
      createdAt: files.createdAt,
      updatedAt: files.updatedAt,
      uploaderName: sql<string>`COALESCE(${users.displayName}, 'Unknown')`.as("uploader_name"),
      uploaderAvatarUrl: users.avatarUrl,
    })
    .from(files)
    .leftJoin(users, eq(users.id, files.uploadedBy))
    .where(conditions)
    .orderBy(desc(sql`COALESCE(${files.takenAt}, ${files.createdAt})`))
    .limit(limit)
    .offset(offset);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    photos: photoRows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
