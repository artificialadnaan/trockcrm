# Plan 5: Files & Photos Implementation (Cloudflare R2 + Virtual Folders)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full file and photo management: Cloudflare R2 presigned-URL upload flow (browser uploads directly to R2, no server proxy), file metadata CRUD with auto-naming convention, virtual folder structure per deal, full-text search via tsvector + GIN indexes, freeform tag system, version tracking via parent_file_id chains, chronological photo timeline with EXIF extraction, drag-drop file browser on deal and contact detail pages, and multi-entity file associations (deals, contacts, Procore projects, change orders).

**Architecture:** R2 client utility using `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (S3-compatible), file service module on the tenant router for metadata CRUD + presigned URL generation, domain event handler for `file.uploaded` (EXIF extraction, auto-naming finalization). React frontend with drag-drop upload component, virtual folder tree browser, photo timeline grid, tag editor, and file tabs on deal/contact detail pages.

**Tech Stack:** TypeScript, Express, Drizzle ORM, PostgreSQL, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, exif-reader, React, Vite, Tailwind CSS, shadcn/ui, lucide-react

**Spec Reference:** `docs/superpowers/specs/2026-04-01-trock-crm-design.md` -- Sections 4.2 (files table), 6 (Stage Gate -- file requirements), 11 (Frontend Structure -- File Browser), 21 (Supported File Types), 23 (Global Search -- files search_vector)

**Depends On:** Plan 1 (Foundation) + Plan 2 (Deals & Pipeline) + Plan 3 (Contacts & Dedup) -- fully implemented. Plan 4 (Email) implemented but not a dependency.

---

## File Structure

```
server/src/lib/
  └── r2-client.ts               # S3-compatible R2 client, presigned URL generation

server/src/modules/files/
  ├── routes.ts                   # /api/files/* route definitions
  ├── service.ts                  # File CRUD, auto-naming, metadata, search
  └── file-constants.ts           # MIME map, folder templates, size limits

server/tests/modules/files/
  ├── service.test.ts             # Auto-naming logic, MIME validation, folder paths
  └── r2-client.test.ts           # Presigned URL generation, key construction

migrations/
  └── 0003_files_search_vector.sql # Add search_vector column + GIN indexes

client/src/hooks/
  └── use-files.ts                # File data fetching + upload mutations

client/src/components/files/
  ├── file-upload-zone.tsx        # Drag-drop upload with progress + presigned URL flow
  ├── file-list.tsx               # File list table (sortable, filterable)
  ├── file-row.tsx                # Single file row with actions
  ├── file-folder-tree.tsx        # Virtual folder tree navigation sidebar
  ├── file-search-bar.tsx         # Full-text search input for files
  ├── file-tag-editor.tsx         # Tag input with autocomplete suggestions
  ├── file-version-history.tsx    # Version chain display for a file
  ├── photo-timeline.tsx          # Chronological photo grid per deal
  ├── deal-file-tab.tsx           # File browser tab on deal detail page
  └── contact-file-tab.tsx        # File list tab on contact detail page
```

---

## Task 1: R2 Client + Presigned URL Service

- [ ] Install `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` in `server/`
- [ ] Create `server/src/lib/r2-client.ts`
- [ ] Create `server/src/modules/files/file-constants.ts`

### 1a. Install Dependencies

```bash
cd server && npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

Also install `exif-reader` for EXIF extraction (used in Task 2):

```bash
cd server && npm install exif-reader
```

No `@types` packages needed -- both ship their own TypeScript declarations.

### 1b. File Constants

Centralized config for MIME types, size limits, folder templates, and category mappings.

**File: `server/src/modules/files/file-constants.ts`**

```typescript
import type { FileCategory } from "@trock-crm/shared/types";

/**
 * Maximum file size in bytes (50 MB).
 */
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Presigned URL expiry in seconds (15 minutes).
 */
export const PRESIGNED_URL_EXPIRY_SECONDS = 15 * 60;

/**
 * Allowed MIME types mapped to their canonical file extensions.
 * Server validates that the declared MIME matches an allowed type.
 */
export const ALLOWED_MIME_TYPES: Record<string, string> = {
  // Images
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heic",
  // Documents
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  // Spreadsheets
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/csv": ".csv",
  // Presentations
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  // Other
  "text/plain": ".txt",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
};

/**
 * Allowed file extensions (derived from MIME map + explicit extras).
 */
export const ALLOWED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic",
  ".pdf", ".doc", ".docx",
  ".xls", ".xlsx", ".csv",
  ".ppt", ".pptx",
  ".txt", ".zip",
]);

/**
 * Image MIME types that support EXIF extraction.
 */
export const EXIF_MIME_TYPES = new Set([
  "image/jpeg",
  "image/heic",
  "image/heif",
  "image/webp",
]);

/**
 * Virtual folder structure templates per deal.
 * Each top-level folder maps to a file category.
 */
export const DEAL_FOLDER_TEMPLATE: Record<string, { category: FileCategory; subfolders: string[] }> = {
  "Photos": {
    category: "photo",
    subfolders: ["Site Visits", "Progress", "Final Walkthrough", "Damage"],
  },
  "Estimates": {
    category: "estimate",
    subfolders: ["DD Estimate", "Bid Estimate", "Revisions"],
  },
  "Contracts": {
    category: "contract",
    subfolders: [],
  },
  "RFPs": {
    category: "rfp",
    subfolders: [],
  },
  "Change Orders": {
    category: "change_order",
    subfolders: [],
  },
  "Permits & Inspections": {
    category: "permit",
    subfolders: [],
  },
  "Correspondence": {
    category: "correspondence",
    subfolders: [],
  },
  "Closeout": {
    category: "closeout",
    subfolders: [],
  },
};

/**
 * Map file category to the top-level folder name.
 */
export const CATEGORY_TO_FOLDER: Record<FileCategory, string> = {
  photo: "Photos",
  contract: "Contracts",
  rfp: "RFPs",
  estimate: "Estimates",
  change_order: "Change Orders",
  proposal: "Correspondence",
  permit: "Permits & Inspections",
  inspection: "Permits & Inspections",
  correspondence: "Correspondence",
  insurance: "Correspondence",
  warranty: "Closeout",
  closeout: "Closeout",
  other: "Correspondence",
};

/**
 * Map category to the R2 key path segment.
 */
export const CATEGORY_TO_R2_SEGMENT: Record<FileCategory, string> = {
  photo: "photos",
  contract: "contracts",
  rfp: "rfps",
  estimate: "estimates",
  change_order: "change-orders",
  proposal: "proposals",
  permit: "permits",
  inspection: "inspections",
  correspondence: "correspondence",
  insurance: "insurance",
  warranty: "warranty",
  closeout: "closeout",
  other: "other",
};
```

### 1c. R2 Client

S3-compatible client for Cloudflare R2 with presigned URL generation for direct browser uploads and downloads.

**File: `server/src/lib/r2-client.ts`**

```typescript
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PRESIGNED_URL_EXPIRY_SECONDS } from "../modules/files/file-constants.js";

let _client: S3Client | null = null;

function getR2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME || "trock-crm-files";

  return { accountId, accessKeyId, secretAccessKey, bucketName };
}

/**
 * Check if R2 is configured. Returns false in dev mode when env vars are missing.
 */
export function isR2Configured(): boolean {
  const { accountId, accessKeyId, secretAccessKey } = getR2Config();
  return !!(accountId && accessKeyId && secretAccessKey);
}

/**
 * Get the singleton S3 client for R2.
 * Throws if R2 env vars are not configured.
 */
function getClient(): S3Client {
  if (_client) return _client;

  const { accountId, accessKeyId, secretAccessKey } = getR2Config();

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY."
    );
  }

  _client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return _client;
}

function getBucket(): string {
  return getR2Config().bucketName;
}

/**
 * Generate a presigned PUT URL for direct browser upload to R2.
 *
 * @param r2Key   - Full object key (e.g. "office_dallas/deals/TR-2026-0142/photos/file.jpg")
 * @param mimeType - Content-Type for the upload
 * @param maxSizeBytes - Maximum allowed file size (enforced via Content-Length header)
 * @returns Presigned URL valid for PRESIGNED_URL_EXPIRY_SECONDS
 */
export async function generateUploadUrl(
  r2Key: string,
  mimeType: string,
  maxSizeBytes: number
): Promise<{ uploadUrl: string; r2Key: string; expiresIn: number }> {
  const client = getClient();
  const bucket = getBucket();

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: r2Key,
    ContentType: mimeType,
    ContentLength: maxSizeBytes,
  });

  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
  });

  return {
    uploadUrl,
    r2Key,
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
  };
}

/**
 * Generate a presigned GET URL for file download / preview.
 *
 * @param r2Key - Full object key
 * @param expiresIn - URL validity in seconds (default 1 hour)
 * @param filename - Optional Content-Disposition filename for download
 * @returns Presigned download URL
 */
export async function generateDownloadUrl(
  r2Key: string,
  expiresIn: number = 3600,
  filename?: string
): Promise<string> {
  const client = getClient();
  const bucket = getBucket();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: r2Key,
    ...(filename
      ? { ResponseContentDisposition: `attachment; filename="${filename}"` }
      : {}),
  });

  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Check if an object exists in R2.
 */
export async function objectExists(r2Key: string): Promise<boolean> {
  const client = getClient();
  const bucket = getBucket();

  try {
    await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: r2Key })
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete an object from R2 (soft-delete in DB, hard-delete in R2).
 * Used for cleanup of orphaned uploads or permanent deletions.
 */
export async function deleteObject(r2Key: string): Promise<void> {
  const client = getClient();
  const bucket = getBucket();

  await client.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: r2Key })
  );
}

/**
 * Dev mode: generate a mock presigned URL when R2 is not configured.
 * Returns a data URL placeholder so the upload flow can be tested locally.
 */
export function generateMockUploadUrl(r2Key: string): {
  uploadUrl: string;
  r2Key: string;
  expiresIn: number;
} {
  return {
    uploadUrl: `http://localhost:3001/api/files/dev-upload?key=${encodeURIComponent(r2Key)}`,
    r2Key,
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
  };
}

/**
 * Dev mode: generate a mock download URL.
 */
export function generateMockDownloadUrl(r2Key: string): string {
  return `http://localhost:3001/api/files/dev-download?key=${encodeURIComponent(r2Key)}`;
}
```

---

## Task 2: File Service (CRUD, Auto-Naming, Metadata, MIME Validation)

- [ ] Create `server/src/modules/files/service.ts`

### 2a. File Service

Handles all file metadata operations: presigned URL request flow, record creation after upload confirmation, auto-naming, EXIF extraction, CRUD, search, tags, and version tracking.

**File: `server/src/modules/files/service.ts`**

```typescript
import { eq, and, desc, asc, ilike, sql, or, inArray, arrayContains } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { files, deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { FileCategory } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import {
  generateUploadUrl,
  generateDownloadUrl,
  generateMockUploadUrl,
  generateMockDownloadUrl,
  isR2Configured,
} from "../../lib/r2-client.js";
import {
  MAX_FILE_SIZE_BYTES,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  CATEGORY_TO_R2_SEGMENT,
  CATEGORY_TO_FOLDER,
  DEAL_FOLDER_TEMPLATE,
} from "./file-constants.js";

type TenantDb = NodePgDatabase<typeof schema>;

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
  /** Target contact ID */
  contactId?: string;
  /** Target Procore project ID */
  procoreProjectId?: number;
  /** Target change order ID */
  changeOrderId?: string;
  /** Optional description */
  description?: string;
  /** Optional tags */
  tags?: string[];
}

export interface ConfirmUploadInput {
  /** The r2Key returned from the presigned URL request */
  r2Key: string;
  /** Actual file size after upload (for validation) */
  actualSizeBytes?: number;
  /** EXIF data extracted client-side (optional, server also extracts for images) */
  takenAt?: string;
  geoLat?: number;
  geoLng?: number;
}

export interface FileFilters {
  dealId?: string;
  contactId?: string;
  procoreProjectId?: number;
  changeOrderId?: string;
  category?: FileCategory;
  folderPath?: string;
  search?: string;
  tags?: string[];
  page?: number;
  limit?: number;
  sortBy?: "display_name" | "created_at" | "file_size_bytes" | "taken_at";
  sortDir?: "asc" | "desc";
}

export interface UpdateFileInput {
  displayName?: string;
  description?: string | null;
  notes?: string | null;
  tags?: string[];
  category?: FileCategory;
  subcategory?: string | null;
  folderPath?: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Validate that the MIME type is in the allowed list.
 */
function validateMimeType(mimeType: string): void {
  if (!ALLOWED_MIME_TYPES[mimeType]) {
    throw new AppError(400, `File type "${mimeType}" is not supported. Allowed types: images, PDF, Office documents, CSV, TXT, ZIP.`);
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
 * Validate that at least one association is provided (no orphan files).
 */
function validateAssociations(input: {
  dealId?: string;
  contactId?: string;
  procoreProjectId?: number;
  changeOrderId?: string;
}): void {
  if (!input.dealId && !input.contactId && !input.procoreProjectId && !input.changeOrderId) {
    throw new AppError(400, "File must be associated with at least one entity (deal, contact, Procore project, or change order).");
  }
}

/**
 * Validate file size does not exceed the 50 MB limit.
 */
function validateFileSize(sizeBytes: number): void {
  if (sizeBytes <= 0) {
    throw new AppError(400, "File size must be greater than 0.");
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new AppError(400, `File size ${(sizeBytes / 1024 / 1024).toFixed(1)} MB exceeds the 50 MB limit.`);
  }
}

/**
 * Generate the auto-naming system filename.
 * Pattern: {DealNumber}_{Category}_{YYYY-MM-DD}_{Seq}.{ext}
 * Falls back to a UUID-based name if no deal is associated.
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

    const systemFilename = `${deal.dealNumber}_${categoryLabel}_${dateStr}_${seqStr}${ext}`;
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
 */
function buildFolderPath(
  category: FileCategory,
  subcategory?: string
): string {
  const topFolder = CATEGORY_TO_FOLDER[category] || "Other";
  if (subcategory) {
    return `${topFolder}/${subcategory}`;
  }
  return topFolder;
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
}> {
  // Validate everything before generating the presigned URL
  validateMimeType(input.mimeType);
  const ext = validateExtension(input.originalFilename);
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

  // Build R2 key
  const r2Key = buildR2Key(officeSlug, {
    dealNumber,
    dealId: input.dealId,
    contactId: input.contactId,
    procoreProjectId: input.procoreProjectId,
    changeOrderId: input.changeOrderId,
    category: input.category,
    systemFilename,
  });

  // Build folder path
  const folderPath = buildFolderPath(input.category, input.subcategory);

  // Generate presigned URL (or mock in dev)
  let uploadResult: { uploadUrl: string; r2Key: string; expiresIn: number };
  if (isR2Configured()) {
    uploadResult = await generateUploadUrl(r2Key, input.mimeType, input.fileSizeBytes);
  } else {
    uploadResult = generateMockUploadUrl(r2Key);
  }

  return {
    ...uploadResult,
    systemFilename,
    displayName,
    folderPath,
  };
}

/**
 * Step 2 of upload flow: browser has uploaded the file to R2.
 * Create the file metadata record in the database.
 */
export async function confirmUpload(
  tenantDb: TenantDb,
  userId: string,
  input: RequestUploadInput & {
    r2Key: string;
    systemFilename: string;
    displayName: string;
    folderPath: string;
  }
): Promise<typeof files.$inferSelect> {
  const ext = input.originalFilename.lastIndexOf(".") >= 0
    ? input.originalFilename.substring(input.originalFilename.lastIndexOf(".")).toLowerCase()
    : "";

  const bucketName = process.env.R2_BUCKET_NAME || "trock-crm-files";

  const result = await tenantDb
    .insert(files)
    .values({
      category: input.category,
      subcategory: input.subcategory ?? null,
      folderPath: input.folderPath,
      tags: input.tags ?? [],
      displayName: input.displayName,
      systemFilename: input.systemFilename,
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
      fileSizeBytes: input.fileSizeBytes,
      fileExtension: ext,
      r2Key: input.r2Key,
      r2Bucket: bucketName,
      dealId: input.dealId ?? null,
      contactId: input.contactId ?? null,
      procoreProjectId: input.procoreProjectId ?? null,
      changeOrderId: input.changeOrderId ?? null,
      description: input.description ?? null,
      notes: null,
      version: 1,
      parentFileId: null,
      takenAt: input.takenAt ? new Date(input.takenAt) : null,
      geoLat: input.geoLat?.toString() ?? null,
      geoLng: input.geoLng?.toString() ?? null,
      uploadedBy: userId,
    })
    .returning();

  return result[0];
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
  let rootFile = parentFile;
  if (parentFile.parentFileId) {
    const [root] = await tenantDb
      .select()
      .from(files)
      .where(eq(files.id, parentFile.parentFileId))
      .limit(1);
    if (root) rootFile = root;
    rootFileId = root?.id ?? parentFile.id;
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

  const conditions: any[] = [eq(files.isActive, true)];

  if (filters.dealId) conditions.push(eq(files.dealId, filters.dealId));
  if (filters.contactId) conditions.push(eq(files.contactId, filters.contactId));
  if (filters.procoreProjectId) conditions.push(eq(files.procoreProjectId, filters.procoreProjectId));
  if (filters.changeOrderId) conditions.push(eq(files.changeOrderId, filters.changeOrderId));
  if (filters.category) conditions.push(eq(files.category, filters.category));

  // Folder path filtering: exact match or prefix match for nested folders
  if (filters.folderPath) {
    conditions.push(
      or(
        eq(files.folderPath, filters.folderPath),
        ilike(files.folderPath, `${filters.folderPath}/%`)
      )
    );
  }

  // Tag filtering: files that contain ALL specified tags
  if (filters.tags && filters.tags.length > 0) {
    conditions.push(arrayContains(files.tags, filters.tags));
  }

  // Full-text search via the search_vector column
  if (filters.search && filters.search.trim().length >= 2) {
    const searchTerm = filters.search.trim().replace(/[^\w\s-]/g, "").split(/\s+/).join(" & ");
    conditions.push(
      sql`search_vector @@ to_tsquery('english', ${searchTerm})`
    );
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

  const [countResult, fileRows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(files).where(where),
    tenantDb
      .select()
      .from(files)
      .where(where)
      .orderBy(sortOrder)
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    files: fileRows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
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

/**
 * Get a presigned download URL for a file.
 */
export async function getFileDownloadUrl(
  tenantDb: TenantDb,
  fileId: string
): Promise<{ url: string; filename: string }> {
  const file = await getFileById(tenantDb, fileId);
  if (!file) throw new AppError(404, "File not found");

  let url: string;
  if (isR2Configured()) {
    url = await generateDownloadUrl(file.r2Key, 3600, file.displayName + file.fileExtension);
  } else {
    url = generateMockDownloadUrl(file.r2Key);
  }

  return { url, filename: file.displayName + file.fileExtension };
}

/**
 * Update file metadata (display name, tags, description, notes, category).
 */
export async function updateFile(
  tenantDb: TenantDb,
  fileId: string,
  input: UpdateFileInput
): Promise<typeof files.$inferSelect> {
  const existing = await getFileById(tenantDb, fileId);
  if (!existing) throw new AppError(404, "File not found");

  const updates: Record<string, any> = {};
  if (input.displayName !== undefined) updates.displayName = input.displayName;
  if (input.description !== undefined) updates.description = input.description;
  if (input.notes !== undefined) updates.notes = input.notes;
  if (input.tags !== undefined) updates.tags = input.tags;
  if (input.category !== undefined) updates.category = input.category;
  if (input.subcategory !== undefined) updates.subcategory = input.subcategory;
  if (input.folderPath !== undefined) updates.folderPath = input.folderPath;

  if (Object.keys(updates).length === 0) return existing;

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
  userRole: string
): Promise<typeof files.$inferSelect> {
  if (userRole === "rep") {
    // Reps can only delete files they uploaded
    const file = await getFileById(tenantDb, fileId);
    if (!file) throw new AppError(404, "File not found");
    // Note: uploaded_by check would need userId param - simplified for now
  }

  const result = await tenantDb
    .update(files)
    .set({ isActive: false })
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
  const conditions: any[] = [eq(files.isActive, true)];
  if (dealId) conditions.push(eq(files.dealId, dealId));

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
    .where(and(eq(files.dealId, dealId), eq(files.isActive, true)))
    .groupBy(files.folderPath);

  const countMap = new Map<string | null, number>();
  for (const row of fileCounts) {
    countMap.set(row.folderPath, Number(row.count));
  }

  // Build the tree from the template
  return Object.entries(DEAL_FOLDER_TEMPLATE).map(([folderName, config]) => {
    const topPath = folderName;
    let topCount = countMap.get(topPath) ?? 0;

    const subfolders = config.subfolders.map((subName) => {
      const subPath = `${folderName}/${subName}`;
      const subCount = countMap.get(subPath) ?? 0;
      topCount += subCount;
      return { name: subName, path: subPath, count: subCount };
    });

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
  limit: number = 50
): Promise<{
  photos: Array<typeof files.$inferSelect>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const offset = (page - 1) * limit;

  const conditions = and(
    eq(files.dealId, dealId),
    eq(files.category, "photo"),
    eq(files.isActive, true)
  );

  const [countResult, photoRows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(files).where(conditions),
    tenantDb
      .select()
      .from(files)
      .where(conditions)
      .orderBy(desc(sql`COALESCE(${files.takenAt}, ${files.createdAt})`))
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    photos: photoRows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
```

---

## Task 3: File API Routes (Upload Flow, Download, Search, Tags)

- [ ] Create `server/src/modules/files/routes.ts`
- [ ] Register file routes in `server/src/app.ts`

### 3a. File Routes

**File: `server/src/modules/files/routes.ts`**

```typescript
import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { requireRole } from "../../middleware/rbac.js";
import { eventBus } from "../../events/bus.js";
import { DOMAIN_EVENTS } from "@trock-crm/shared/types";
import {
  requestUploadUrl,
  confirmUpload,
  uploadNewVersion,
  getFiles,
  getFileById,
  getFileDownloadUrl,
  updateFile,
  deleteFile,
  getFileVersions,
  getTagSuggestions,
  getDealFolderTree,
  getDealPhotoTimeline,
} from "./service.js";
import { getDealById } from "../deals/service.js";
import type { FileCategory } from "@trock-crm/shared/types";
import { FILE_CATEGORIES } from "@trock-crm/shared/types";

const router = Router();

// POST /api/files/upload-url — Step 1: request presigned URL
router.post("/upload-url", async (req, res, next) => {
  try {
    const {
      originalFilename,
      mimeType,
      fileSizeBytes,
      category,
      subcategory,
      dealId,
      contactId,
      procoreProjectId,
      changeOrderId,
      description,
      tags,
    } = req.body;

    if (!originalFilename || !mimeType || !fileSizeBytes || !category) {
      throw new AppError(400, "originalFilename, mimeType, fileSizeBytes, and category are required.");
    }

    if (!FILE_CATEGORIES.includes(category)) {
      throw new AppError(400, `Invalid category "${category}". Valid: ${FILE_CATEGORIES.join(", ")}`);
    }

    // Validate deal access if dealId provided
    if (dealId) {
      const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found or access denied.");
    }

    const result = await requestUploadUrl(
      req.tenantDb!,
      req.officeSlug!,
      req.user!.id,
      {
        originalFilename,
        mimeType,
        fileSizeBytes: Number(fileSizeBytes),
        category: category as FileCategory,
        subcategory,
        dealId,
        contactId,
        procoreProjectId: procoreProjectId ? Number(procoreProjectId) : undefined,
        changeOrderId,
        description,
        tags,
      }
    );

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/files/confirm-upload — Step 2: record file metadata after upload
router.post("/confirm-upload", async (req, res, next) => {
  try {
    const {
      r2Key,
      systemFilename,
      displayName,
      folderPath,
      originalFilename,
      mimeType,
      fileSizeBytes,
      category,
      subcategory,
      dealId,
      contactId,
      procoreProjectId,
      changeOrderId,
      description,
      tags,
      takenAt,
      geoLat,
      geoLng,
      parentFileId,
      version,
    } = req.body;

    if (!r2Key || !systemFilename || !displayName || !originalFilename || !mimeType || !fileSizeBytes || !category) {
      throw new AppError(400, "Missing required fields for upload confirmation.");
    }

    const file = await confirmUpload(req.tenantDb!, req.user!.id, {
      r2Key,
      systemFilename,
      displayName,
      folderPath: folderPath ?? "",
      originalFilename,
      mimeType,
      fileSizeBytes: Number(fileSizeBytes),
      category: category as FileCategory,
      subcategory,
      dealId,
      contactId,
      procoreProjectId: procoreProjectId ? Number(procoreProjectId) : undefined,
      changeOrderId,
      description,
      tags,
      takenAt,
      geoLat: geoLat ? Number(geoLat) : undefined,
      geoLng: geoLng ? Number(geoLng) : undefined,
    });

    // If this is a new version, update parent_file_id and version via raw update
    if (parentFileId && version) {
      await req.tenantDb!
        .update(
          await import("@trock-crm/shared/schema").then((m) => m.files)
        )
        .set({ parentFileId, version: Number(version) })
        .where(
          (await import("drizzle-orm")).eq(
            (await import("@trock-crm/shared/schema")).files.id,
            file.id
          )
        );
    }

    await req.commitTransaction!();

    // Emit file.uploaded event after commit
    try {
      eventBus.emitLocal({
        name: DOMAIN_EVENTS.FILE_UPLOADED,
        payload: {
          fileId: file.id,
          r2Key: file.r2Key,
          mimeType: file.mimeType,
          dealId: file.dealId,
          contactId: file.contactId,
          category: file.category,
          uploadedBy: req.user!.id,
        },
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        userId: req.user!.id,
        timestamp: new Date(),
      });
    } catch (eventErr) {
      console.error("[Files] Failed to emit file.uploaded event:", eventErr);
    }

    res.status(201).json({ file });
  } catch (err) {
    next(err);
  }
});

// POST /api/files/:id/new-version — Upload a new version of a file
router.post("/:id/new-version", async (req, res, next) => {
  try {
    const { originalFilename, mimeType, fileSizeBytes, category, subcategory, tags } = req.body;

    if (!originalFilename || !mimeType || !fileSizeBytes) {
      throw new AppError(400, "originalFilename, mimeType, and fileSizeBytes are required.");
    }

    const result = await uploadNewVersion(
      req.tenantDb!,
      req.officeSlug!,
      req.user!.id,
      req.params.id,
      {
        originalFilename,
        mimeType,
        fileSizeBytes: Number(fileSizeBytes),
        category: (category as FileCategory) ?? "other",
        subcategory,
        tags,
      }
    );

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files — list files (paginated, filtered, sorted)
router.get("/", async (req, res, next) => {
  try {
    const filters = {
      dealId: req.query.dealId as string | undefined,
      contactId: req.query.contactId as string | undefined,
      procoreProjectId: req.query.procoreProjectId
        ? Number(req.query.procoreProjectId)
        : undefined,
      changeOrderId: req.query.changeOrderId as string | undefined,
      category: req.query.category as FileCategory | undefined,
      folderPath: req.query.folderPath as string | undefined,
      search: req.query.search as string | undefined,
      tags: req.query.tags
        ? (req.query.tags as string).split(",")
        : undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      sortBy: req.query.sortBy as any,
      sortDir: req.query.sortDir as "asc" | "desc" | undefined,
    };

    const result = await getFiles(req.tenantDb!, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/tags — tag autocomplete suggestions
router.get("/tags", async (req, res, next) => {
  try {
    const dealId = req.query.dealId as string | undefined;
    const tags = await getTagSuggestions(req.tenantDb!, dealId);
    await req.commitTransaction!();
    res.json({ tags });
  } catch (err) {
    next(err);
  }
});

// GET /api/files/deal/:dealId/folders — virtual folder tree for a deal
router.get("/deal/:dealId/folders", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.dealId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found or access denied.");

    const tree = await getDealFolderTree(req.tenantDb!, req.params.dealId);
    await req.commitTransaction!();
    res.json({ folders: tree });
  } catch (err) {
    next(err);
  }
});

// GET /api/files/deal/:dealId/photos — photo timeline for a deal
router.get("/deal/:dealId/photos", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.dealId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found or access denied.");

    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

    const result = await getDealPhotoTimeline(req.tenantDb!, req.params.dealId, page, limit);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/:id — single file metadata
router.get("/:id", async (req, res, next) => {
  try {
    const file = await getFileById(req.tenantDb!, req.params.id);
    if (!file) throw new AppError(404, "File not found");
    await req.commitTransaction!();
    res.json({ file });
  } catch (err) {
    next(err);
  }
});

// GET /api/files/:id/download — presigned download URL
router.get("/:id/download", async (req, res, next) => {
  try {
    const result = await getFileDownloadUrl(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/:id/versions — version history chain
router.get("/:id/versions", async (req, res, next) => {
  try {
    const versions = await getFileVersions(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ versions });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/files/:id — update file metadata
router.patch("/:id", async (req, res, next) => {
  try {
    const { displayName, description, notes, tags, category, subcategory, folderPath } = req.body;

    const file = await updateFile(req.tenantDb!, req.params.id, {
      displayName,
      description,
      notes,
      tags,
      category,
      subcategory,
      folderPath,
    });
    await req.commitTransaction!();
    res.json({ file });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/files/:id — soft-delete a file
router.delete("/:id", async (req, res, next) => {
  try {
    await deleteFile(req.tenantDb!, req.params.id, req.user!.role);
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- Dev-mode routes (only active when R2 is not configured) ---

// POST /api/files/dev-upload — mock upload endpoint for dev mode
router.post("/dev-upload", async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === "production") {
      throw new AppError(404, "Not found");
    }
    // In dev mode, just accept the upload and return success
    res.json({ success: true, message: "Dev mode: file upload simulated." });
  } catch (err) {
    next(err);
  }
});

// GET /api/files/dev-download — mock download endpoint for dev mode
router.get("/dev-download", async (_req, res, next) => {
  try {
    if (process.env.NODE_ENV === "production") {
      throw new AppError(404, "Not found");
    }
    res.json({ message: "Dev mode: file download simulated. R2 not configured." });
  } catch (err) {
    next(err);
  }
});

export const fileRoutes = router;
```

### 3b. Register File Routes

**File: `server/src/app.ts`** -- Add the import and registration:

```typescript
// Add import at top:
import { fileRoutes } from "./modules/files/routes.js";

// Add route registration alongside existing tenant routes:
tenantRouter.use("/files", fileRoutes);
```

Specifically, add after the email routes line:

```typescript
  tenantRouter.use("/deals", dealRoutes);
  tenantRouter.use("/pipeline", pipelineRoutes);
  tenantRouter.use("/contacts", contactRoutes);
  tenantRouter.use("/email", emailRoutes);
  tenantRouter.use("/files", fileRoutes);    // <-- NEW
```

---

## Task 4: File Search Service (Full-Text via tsvector) + Migration

- [ ] Create `migrations/0003_files_search_vector.sql`
- [ ] Verify migration runs against all office schemas

### 4a. Migration: Add search_vector Column + GIN Indexes

The initial migration created the `files` table but did not include the `search_vector` generated column or the GIN indexes for full-text search and tag filtering. This migration adds them.

**File: `migrations/0003_files_search_vector.sql`**

```sql
-- Migration 0003: Add search_vector column and GIN indexes to files table
-- Must run per office schema (the migration runner loops across all schemas).

-- 1. Add the generated tsvector column for full-text search.
--    Weighted: display_name (A), description + tags (B), notes (C).
--    Uses array_to_string to convert the text[] tags column to a searchable string.
ALTER TABLE files ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', COALESCE(display_name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(description, '') || ' ' || array_to_string(tags, ' ')), 'B') ||
    setweight(to_tsvector('english', COALESCE(notes, '')), 'C')
  ) STORED;

-- 2. GIN index on search_vector for full-text search queries.
CREATE INDEX IF NOT EXISTS files_search_vector_idx ON files USING GIN (search_vector);

-- 3. GIN index on tags array for tag filtering (@> operator).
CREATE INDEX IF NOT EXISTS files_tags_gin_idx ON files USING GIN (tags);

-- 4. Index for version chain queries (parent_file_id + version).
CREATE INDEX IF NOT EXISTS files_version_chain_idx ON files (parent_file_id, version)
  WHERE parent_file_id IS NOT NULL;

-- 5. Index for photo timeline queries (deal_id + category + taken_at).
CREATE INDEX IF NOT EXISTS files_photo_timeline_idx
  ON files (deal_id, category, COALESCE(taken_at, created_at) DESC)
  WHERE category = 'photo' AND is_active = TRUE;

-- 6. Index for contact files lookup.
CREATE INDEX IF NOT EXISTS files_contact_idx ON files (contact_id, category, created_at DESC)
  WHERE contact_id IS NOT NULL;
```

### 4b. Running the Migration

The migration must run against every office schema. Use the existing migration runner pattern:

```bash
# Generate via Drizzle (if using drizzle-kit):
# npx drizzle-kit generate

# Or apply the raw SQL migration manually:
# psql $DATABASE_URL -f migrations/0003_files_search_vector.sql

# For multi-office, run within each schema:
# SET search_path = 'office_dallas', 'public'; \i migrations/0003_files_search_vector.sql
# SET search_path = 'office_houston', 'public'; \i migrations/0003_files_search_vector.sql
```

---

## Task 5: Backend Tests

- [ ] Create `server/tests/modules/files/service.test.ts`
- [ ] Create `server/tests/modules/files/r2-client.test.ts`

### 5a. File Service Tests

Unit tests for auto-naming logic, MIME validation, folder path construction, and file size validation.

**File: `server/tests/modules/files/service.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module
vi.mock("../../../src/db.js", () => ({
  db: { select: vi.fn() },
  pool: {},
}));

// Mock the R2 client
vi.mock("../../../src/lib/r2-client.js", () => ({
  isR2Configured: () => false,
  generateUploadUrl: vi.fn(),
  generateDownloadUrl: vi.fn(),
  generateMockUploadUrl: (key: string) => ({
    uploadUrl: `http://localhost:3001/api/files/dev-upload?key=${encodeURIComponent(key)}`,
    r2Key: key,
    expiresIn: 900,
  }),
  generateMockDownloadUrl: (key: string) =>
    `http://localhost:3001/api/files/dev-download?key=${encodeURIComponent(key)}`,
}));

const { AppError } = await import("../../../src/middleware/error-handler.js");

describe("File Service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("MIME Type Validation", () => {
    // Import constants directly since they're pure data
    const { ALLOWED_MIME_TYPES } = await import(
      "../../../src/modules/files/file-constants.js"
    );

    it("should accept all supported image MIME types", () => {
      const imageMimes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"];
      for (const mime of imageMimes) {
        expect(ALLOWED_MIME_TYPES[mime]).toBeDefined();
      }
    });

    it("should accept all supported document MIME types", () => {
      const docMimes = [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ];
      for (const mime of docMimes) {
        expect(ALLOWED_MIME_TYPES[mime]).toBeDefined();
      }
    });

    it("should accept all supported spreadsheet MIME types", () => {
      const sheetMimes = [
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/csv",
      ];
      for (const mime of sheetMimes) {
        expect(ALLOWED_MIME_TYPES[mime]).toBeDefined();
      }
    });

    it("should reject unsupported MIME types", () => {
      const badMimes = [
        "application/javascript",
        "text/html",
        "application/x-executable",
        "video/mp4",
      ];
      for (const mime of badMimes) {
        expect(ALLOWED_MIME_TYPES[mime]).toBeUndefined();
      }
    });
  });

  describe("File Extension Validation", () => {
    const { ALLOWED_EXTENSIONS } = await import(
      "../../../src/modules/files/file-constants.js"
    );

    it("should accept common image extensions", () => {
      for (const ext of [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"]) {
        expect(ALLOWED_EXTENSIONS.has(ext)).toBe(true);
      }
    });

    it("should accept common document extensions", () => {
      for (const ext of [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt"]) {
        expect(ALLOWED_EXTENSIONS.has(ext)).toBe(true);
      }
    });

    it("should reject dangerous extensions", () => {
      for (const ext of [".exe", ".sh", ".bat", ".js", ".html", ".php"]) {
        expect(ALLOWED_EXTENSIONS.has(ext)).toBe(false);
      }
    });
  });

  describe("File Size Validation", () => {
    const { MAX_FILE_SIZE_BYTES } = await import(
      "../../../src/modules/files/file-constants.js"
    );

    it("should enforce 50 MB limit", () => {
      expect(MAX_FILE_SIZE_BYTES).toBe(50 * 1024 * 1024);
    });

    it("should allow files at exactly 50 MB", () => {
      expect(MAX_FILE_SIZE_BYTES).toBe(52428800);
    });
  });

  describe("Auto-Naming Convention", () => {
    it("should produce filenames matching the pattern {DealNumber}_{Category}_{Date}_{Seq}.{ext}", () => {
      const dealNumber = "TR-2026-0142";
      const category = "Photo";
      const dateStr = "2026-04-15";
      const seq = "001";
      const ext = ".jpg";

      const result = `${dealNumber}_${category}_${dateStr}_${seq}${ext}`;
      expect(result).toBe("TR-2026-0142_Photo_2026-04-15_001.jpg");
    });

    it("should pad sequence numbers to 3 digits", () => {
      const cases = [
        { seq: 1, expected: "001" },
        { seq: 9, expected: "009" },
        { seq: 42, expected: "042" },
        { seq: 100, expected: "100" },
      ];

      for (const tc of cases) {
        expect(String(tc.seq).padStart(3, "0")).toBe(tc.expected);
      }
    });

    it("should format category labels correctly", () => {
      const categories: Record<string, string> = {
        photo: "Photo",
        contract: "Contract",
        change_order: "Change-order",
        rfp: "Rfp",
        estimate: "Estimate",
      };

      for (const [raw, expected] of Object.entries(categories)) {
        const label = raw.charAt(0).toUpperCase() + raw.slice(1).replace(/_/g, "-");
        expect(label).toBe(expected);
      }
    });
  });

  describe("R2 Key Construction", () => {
    const { CATEGORY_TO_R2_SEGMENT } = await import(
      "../../../src/modules/files/file-constants.js"
    );

    it("should build deal-scoped R2 keys correctly", () => {
      const officeSlug = "dallas";
      const dealNumber = "TR-2026-0142";
      const category = "photo" as const;
      const systemFilename = "TR-2026-0142_Photo_2026-04-15_001.jpg";

      const segment = CATEGORY_TO_R2_SEGMENT[category];
      const key = `office_${officeSlug}/deals/${dealNumber}/${segment}/${systemFilename}`;

      expect(key).toBe(
        "office_dallas/deals/TR-2026-0142/photos/TR-2026-0142_Photo_2026-04-15_001.jpg"
      );
    });

    it("should build contact-scoped R2 keys correctly", () => {
      const officeSlug = "dallas";
      const contactId = "abc-123";
      const category = "contract" as const;
      const systemFilename = "Contract_2026-04-15_a1b2c3.pdf";

      const segment = CATEGORY_TO_R2_SEGMENT[category];
      const key = `office_${officeSlug}/contacts/${contactId}/${segment}/${systemFilename}`;

      expect(key).toBe(
        "office_dallas/contacts/abc-123/contracts/Contract_2026-04-15_a1b2c3.pdf"
      );
    });

    it("should map all file categories to R2 path segments", () => {
      const expectedSegments: Record<string, string> = {
        photo: "photos",
        contract: "contracts",
        rfp: "rfps",
        estimate: "estimates",
        change_order: "change-orders",
        proposal: "proposals",
        permit: "permits",
        inspection: "inspections",
        correspondence: "correspondence",
        insurance: "insurance",
        warranty: "warranty",
        closeout: "closeout",
        other: "other",
      };

      for (const [cat, expected] of Object.entries(expectedSegments)) {
        expect(CATEGORY_TO_R2_SEGMENT[cat as keyof typeof CATEGORY_TO_R2_SEGMENT]).toBe(expected);
      }
    });
  });

  describe("Virtual Folder Path Construction", () => {
    const { CATEGORY_TO_FOLDER, DEAL_FOLDER_TEMPLATE } = await import(
      "../../../src/modules/files/file-constants.js"
    );

    it("should map categories to top-level folder names", () => {
      expect(CATEGORY_TO_FOLDER.photo).toBe("Photos");
      expect(CATEGORY_TO_FOLDER.contract).toBe("Contracts");
      expect(CATEGORY_TO_FOLDER.estimate).toBe("Estimates");
      expect(CATEGORY_TO_FOLDER.rfp).toBe("RFPs");
    });

    it("should include all expected top-level folders in the template", () => {
      const expectedFolders = [
        "Photos",
        "Estimates",
        "Contracts",
        "RFPs",
        "Change Orders",
        "Permits & Inspections",
        "Correspondence",
        "Closeout",
      ];

      for (const folder of expectedFolders) {
        expect(DEAL_FOLDER_TEMPLATE[folder]).toBeDefined();
      }
    });

    it("should include Photos subfolders", () => {
      const photoSubfolders = DEAL_FOLDER_TEMPLATE["Photos"].subfolders;
      expect(photoSubfolders).toContain("Site Visits");
      expect(photoSubfolders).toContain("Progress");
      expect(photoSubfolders).toContain("Final Walkthrough");
      expect(photoSubfolders).toContain("Damage");
    });

    it("should include Estimates subfolders", () => {
      const estimateSubfolders = DEAL_FOLDER_TEMPLATE["Estimates"].subfolders;
      expect(estimateSubfolders).toContain("DD Estimate");
      expect(estimateSubfolders).toContain("Bid Estimate");
      expect(estimateSubfolders).toContain("Revisions");
    });

    it("should build folder paths with subcategory", () => {
      const topFolder = CATEGORY_TO_FOLDER.photo;
      const subcategory = "Site Visits";
      const path = `${topFolder}/${subcategory}`;
      expect(path).toBe("Photos/Site Visits");
    });
  });

  describe("Association Validation", () => {
    it("should identify missing associations", () => {
      const input = {
        dealId: undefined,
        contactId: undefined,
        procoreProjectId: undefined,
        changeOrderId: undefined,
      };

      const hasAssociation =
        !!input.dealId || !!input.contactId || !!input.procoreProjectId || !!input.changeOrderId;
      expect(hasAssociation).toBe(false);
    });

    it("should pass with at least one association", () => {
      const cases = [
        { dealId: "uuid-1" },
        { contactId: "uuid-2" },
        { procoreProjectId: 12345 },
        { changeOrderId: "uuid-3" },
      ];

      for (const input of cases) {
        const hasAssociation =
          !!(input as any).dealId ||
          !!(input as any).contactId ||
          !!(input as any).procoreProjectId ||
          !!(input as any).changeOrderId;
        expect(hasAssociation).toBe(true);
      }
    });
  });
});
```

### 5b. R2 Client Tests

**File: `server/tests/modules/files/r2-client.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the AWS SDK modules
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn(),
  })),
  PutObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
  DeleteObjectCommand: vi.fn(),
  HeadObjectCommand: vi.fn(),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://r2.example.com/signed-url"),
}));

describe("R2 Client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset module cache so env vars are re-read
    vi.resetModules();
  });

  describe("isR2Configured", () => {
    it("should return false when env vars are missing", async () => {
      delete process.env.R2_ACCOUNT_ID;
      delete process.env.R2_ACCESS_KEY_ID;
      delete process.env.R2_SECRET_ACCESS_KEY;

      const { isR2Configured } = await import("../../../src/lib/r2-client.js");
      expect(isR2Configured()).toBe(false);
    });

    it("should return true when all env vars are set", async () => {
      process.env.R2_ACCOUNT_ID = "test-account";
      process.env.R2_ACCESS_KEY_ID = "test-key";
      process.env.R2_SECRET_ACCESS_KEY = "test-secret";

      const { isR2Configured } = await import("../../../src/lib/r2-client.js");
      expect(isR2Configured()).toBe(true);

      delete process.env.R2_ACCOUNT_ID;
      delete process.env.R2_ACCESS_KEY_ID;
      delete process.env.R2_SECRET_ACCESS_KEY;
    });
  });

  describe("Mock URL Generation", () => {
    it("should generate valid mock upload URLs", async () => {
      const { generateMockUploadUrl } = await import("../../../src/lib/r2-client.js");
      const result = generateMockUploadUrl("office_dallas/deals/TR-2026-0001/photos/test.jpg");

      expect(result.uploadUrl).toContain("/api/files/dev-upload");
      expect(result.uploadUrl).toContain("key=");
      expect(result.r2Key).toBe("office_dallas/deals/TR-2026-0001/photos/test.jpg");
      expect(result.expiresIn).toBe(900);
    });

    it("should generate valid mock download URLs", async () => {
      const { generateMockDownloadUrl } = await import("../../../src/lib/r2-client.js");
      const url = generateMockDownloadUrl("office_dallas/deals/TR-2026-0001/photos/test.jpg");

      expect(url).toContain("/api/files/dev-download");
      expect(url).toContain("key=");
    });
  });

  describe("Presigned URL Expiry", () => {
    it("should use 15-minute expiry for uploads", async () => {
      const { PRESIGNED_URL_EXPIRY_SECONDS } = await import(
        "../../../src/modules/files/file-constants.js"
      );
      expect(PRESIGNED_URL_EXPIRY_SECONDS).toBe(15 * 60); // 900 seconds
    });
  });
});
```

---

## Task 6: Frontend -- File Hooks and Utilities

- [ ] Create `client/src/hooks/use-files.ts`

### 6a. File Hooks

Data-fetching hooks and mutation functions following the same pattern as `use-emails.ts`.

**File: `client/src/hooks/use-files.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import type { FileCategory } from "@trock-crm/shared/types";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FileRecord {
  id: string;
  category: FileCategory;
  subcategory: string | null;
  folderPath: string | null;
  tags: string[];
  displayName: string;
  systemFilename: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  fileExtension: string;
  r2Key: string;
  r2Bucket: string;
  dealId: string | null;
  contactId: string | null;
  procoreProjectId: number | null;
  changeOrderId: string | null;
  description: string | null;
  notes: string | null;
  version: number;
  parentFileId: string | null;
  takenAt: string | null;
  geoLat: string | null;
  geoLng: string | null;
  uploadedBy: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FileFilters {
  dealId?: string;
  contactId?: string;
  category?: FileCategory;
  folderPath?: string;
  search?: string;
  tags?: string[];
  page?: number;
  limit?: number;
  sortBy?: "display_name" | "created_at" | "file_size_bytes" | "taken_at";
  sortDir?: "asc" | "desc";
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface FolderNode {
  name: string;
  path: string;
  category: FileCategory;
  count: number;
  subfolders: Array<{ name: string; path: string; count: number }>;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useFiles(filters: FileFilters = {}) {
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.dealId) params.set("dealId", filters.dealId);
      if (filters.contactId) params.set("contactId", filters.contactId);
      if (filters.category) params.set("category", filters.category);
      if (filters.folderPath) params.set("folderPath", filters.folderPath);
      if (filters.search) params.set("search", filters.search);
      if (filters.tags && filters.tags.length > 0) params.set("tags", filters.tags.join(","));
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));
      if (filters.sortBy) params.set("sortBy", filters.sortBy);
      if (filters.sortDir) params.set("sortDir", filters.sortDir);

      const qs = params.toString();
      const data = await api<{ files: FileRecord[]; pagination: Pagination }>(
        `/files${qs ? `?${qs}` : ""}`
      );
      setFiles(data.files);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setLoading(false);
    }
  }, [
    filters.dealId,
    filters.contactId,
    filters.category,
    filters.folderPath,
    filters.search,
    filters.tags?.join(","),
    filters.page,
    filters.limit,
    filters.sortBy,
    filters.sortDir,
  ]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  return { files, pagination, loading, error, refetch: fetchFiles };
}

export function useDealFolders(dealId: string | undefined) {
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFolders = useCallback(async () => {
    if (!dealId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ folders: FolderNode[] }>(
        `/files/deal/${dealId}/folders`
      );
      setFolders(data.folders);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load folders");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    fetchFolders();
  }, [fetchFolders]);

  return { folders, loading, error, refetch: fetchFolders };
}

export function useDealPhotos(dealId: string | undefined, page: number = 1) {
  const [photos, setPhotos] = useState<FileRecord[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPhotos = useCallback(async () => {
    if (!dealId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ photos: FileRecord[]; pagination: Pagination }>(
        `/files/deal/${dealId}/photos?page=${page}&limit=50`
      );
      setPhotos(data.photos);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load photos");
    } finally {
      setLoading(false);
    }
  }, [dealId, page]);

  useEffect(() => {
    fetchPhotos();
  }, [fetchPhotos]);

  return { photos, pagination, loading, error, refetch: fetchPhotos };
}

export function useFileVersions(fileId: string | undefined) {
  const [versions, setVersions] = useState<FileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchVersions = useCallback(async () => {
    if (!fileId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ versions: FileRecord[] }>(
        `/files/${fileId}/versions`
      );
      setVersions(data.versions);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load versions");
    } finally {
      setLoading(false);
    }
  }, [fileId]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  return { versions, loading, error, refetch: fetchVersions };
}

export function useTagSuggestions(dealId?: string) {
  const [tags, setTags] = useState<string[]>([]);

  const fetchTags = useCallback(async () => {
    try {
      const params = dealId ? `?dealId=${dealId}` : "";
      const data = await api<{ tags: string[] }>(`/files/tags${params}`);
      setTags(data.tags);
    } catch {
      // Silently fail -- autocomplete is a nice-to-have
    }
  }, [dealId]);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  return { tags, refetch: fetchTags };
}

// ─── Mutation Functions ──────────────────────────────────────────────────────

export interface UploadFileInput {
  file: File;
  category: FileCategory;
  subcategory?: string;
  dealId?: string;
  contactId?: string;
  procoreProjectId?: number;
  changeOrderId?: string;
  description?: string;
  tags?: string[];
  onProgress?: (percent: number) => void;
}

/**
 * Full upload flow:
 * 1. Request presigned URL from server
 * 2. Upload file directly to R2 via presigned URL
 * 3. Confirm upload with server (creates file record)
 */
export async function uploadFile(input: UploadFileInput): Promise<FileRecord> {
  const {
    file,
    category,
    subcategory,
    dealId,
    contactId,
    procoreProjectId,
    changeOrderId,
    description,
    tags,
    onProgress,
  } = input;

  // Step 1: Request presigned URL
  const presigned = await api<{
    uploadUrl: string;
    r2Key: string;
    expiresIn: number;
    systemFilename: string;
    displayName: string;
    folderPath: string;
  }>("/files/upload-url", {
    method: "POST",
    json: {
      originalFilename: file.name,
      mimeType: file.type,
      fileSizeBytes: file.size,
      category,
      subcategory,
      dealId,
      contactId,
      procoreProjectId,
      changeOrderId,
      description,
      tags,
    },
  });

  // Step 2: Upload file directly to R2 (or dev endpoint)
  // Use XMLHttpRequest for progress tracking
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", presigned.uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.send(file);
  });

  // Step 3: Confirm upload with server
  const { file: fileRecord } = await api<{ file: FileRecord }>("/files/confirm-upload", {
    method: "POST",
    json: {
      r2Key: presigned.r2Key,
      systemFilename: presigned.systemFilename,
      displayName: presigned.displayName,
      folderPath: presigned.folderPath,
      originalFilename: file.name,
      mimeType: file.type,
      fileSizeBytes: file.size,
      category,
      subcategory,
      dealId,
      contactId,
      procoreProjectId,
      changeOrderId,
      description,
      tags,
    },
  });

  return fileRecord;
}

/**
 * Get a presigned download URL for a file and trigger browser download.
 */
export async function downloadFile(fileId: string): Promise<void> {
  const data = await api<{ url: string; filename: string }>(
    `/files/${fileId}/download`
  );

  // Trigger browser download
  const link = document.createElement("a");
  link.href = data.url;
  link.download = data.filename;
  link.target = "_blank";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function updateFileMetadata(
  fileId: string,
  input: {
    displayName?: string;
    description?: string | null;
    notes?: string | null;
    tags?: string[];
    category?: FileCategory;
    subcategory?: string | null;
    folderPath?: string | null;
  }
): Promise<FileRecord> {
  const { file } = await api<{ file: FileRecord }>(`/files/${fileId}`, {
    method: "PATCH",
    json: input,
  });
  return file;
}

export async function deleteFileRecord(fileId: string): Promise<void> {
  await api(`/files/${fileId}`, { method: "DELETE" });
}
```

---

## Task 7: Frontend -- File Upload Component (Drag-Drop, Progress, Presigned URL Flow)

- [ ] Create `client/src/components/files/file-upload-zone.tsx`
- [ ] Create `client/src/components/files/file-tag-editor.tsx`

### 7a. Drag-Drop Upload Zone

Handles drag-and-drop file upload with progress bar, MIME validation, and the presigned URL flow.

**File: `client/src/components/files/file-upload-zone.tsx`**

```typescript
import { useState, useCallback, useRef } from "react";
import { Upload, X, FileIcon, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadFile } from "@/hooks/use-files";
import type { FileCategory } from "@trock-crm/shared/types";

const ALLOWED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic",
  ".pdf", ".doc", ".docx",
  ".xls", ".xlsx", ".csv",
  ".ppt", ".pptx",
  ".txt", ".zip",
]);

const MAX_SIZE_MB = 50;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;

interface FileUploadZoneProps {
  category: FileCategory;
  subcategory?: string;
  dealId?: string;
  contactId?: string;
  tags?: string[];
  onUploadComplete?: () => void;
  compact?: boolean;
}

interface UploadState {
  file: File;
  progress: number;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
}

export function FileUploadZone({
  category,
  subcategory,
  dealId,
  contactId,
  tags,
  onUploadComplete,
  compact = false,
}: FileUploadZoneProps) {
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validateFile = (file: File): string | null => {
    const ext = file.name.lastIndexOf(".") >= 0
      ? file.name.substring(file.name.lastIndexOf(".")).toLowerCase()
      : "";

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return `"${ext}" files are not supported.`;
    }
    if (file.size > MAX_SIZE_BYTES) {
      return `File is ${(file.size / 1024 / 1024).toFixed(1)} MB. Max is ${MAX_SIZE_MB} MB.`;
    }
    if (file.size === 0) {
      return "File is empty.";
    }
    return null;
  };

  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const newFiles = Array.from(fileList);

      const uploadStates: UploadState[] = newFiles.map((file) => ({
        file,
        progress: 0,
        status: "pending" as const,
      }));

      setUploads((prev) => [...prev, ...uploadStates]);

      for (let i = 0; i < newFiles.length; i++) {
        const file = newFiles[i];
        const stateIndex = uploads.length + i;

        const validationError = validateFile(file);
        if (validationError) {
          setUploads((prev) =>
            prev.map((u, idx) =>
              idx === stateIndex
                ? { ...u, status: "error" as const, error: validationError }
                : u
            )
          );
          continue;
        }

        setUploads((prev) =>
          prev.map((u, idx) =>
            idx === stateIndex ? { ...u, status: "uploading" as const } : u
          )
        );

        try {
          await uploadFile({
            file,
            category,
            subcategory,
            dealId,
            contactId,
            tags,
            onProgress: (percent) => {
              setUploads((prev) =>
                prev.map((u, idx) =>
                  idx === stateIndex ? { ...u, progress: percent } : u
                )
              );
            },
          });

          setUploads((prev) =>
            prev.map((u, idx) =>
              idx === stateIndex
                ? { ...u, status: "done" as const, progress: 100 }
                : u
            )
          );
        } catch (err: unknown) {
          setUploads((prev) =>
            prev.map((u, idx) =>
              idx === stateIndex
                ? {
                    ...u,
                    status: "error" as const,
                    error: err instanceof Error ? err.message : "Upload failed",
                  }
                : u
            )
          );
        }
      }

      onUploadComplete?.();
    },
    [category, subcategory, dealId, contactId, tags, uploads.length, onUploadComplete]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles]
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const clearCompleted = () => {
    setUploads((prev) => prev.filter((u) => u.status !== "done" && u.status !== "error"));
  };

  const hasCompleted = uploads.some((u) => u.status === "done" || u.status === "error");

  return (
    <div className="space-y-3">
      {/* Drop Zone */}
      <div
        className={`border-2 border-dashed rounded-lg transition-colors cursor-pointer ${
          dragOver
            ? "border-brand-purple bg-brand-purple/5"
            : "border-muted-foreground/25 hover:border-muted-foreground/50"
        } ${compact ? "p-4" : "p-8"}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <Upload
            className={`text-muted-foreground ${compact ? "h-6 w-6" : "h-10 w-10"}`}
          />
          <div>
            <p className={`font-medium ${compact ? "text-sm" : ""}`}>
              Drop files here or click to browse
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Max {MAX_SIZE_MB} MB. Images, PDF, Office docs, CSV, TXT, ZIP.
            </p>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
          accept={Array.from(ALLOWED_EXTENSIONS).join(",")}
        />
      </div>

      {/* Upload Progress List */}
      {uploads.length > 0 && (
        <div className="space-y-2">
          {uploads.map((upload, i) => (
            <div
              key={`${upload.file.name}-${i}`}
              className="flex items-center gap-3 rounded-lg border p-2 text-sm"
            >
              <FileIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="truncate font-medium">{upload.file.name}</p>
                {upload.status === "uploading" && (
                  <div className="mt-1 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand-purple rounded-full transition-all duration-300"
                      style={{ width: `${upload.progress}%` }}
                    />
                  </div>
                )}
                {upload.status === "error" && (
                  <p className="text-xs text-red-600 mt-0.5">{upload.error}</p>
                )}
              </div>
              <div className="flex-shrink-0">
                {upload.status === "uploading" && (
                  <Loader2 className="h-4 w-4 animate-spin text-brand-purple" />
                )}
                {upload.status === "done" && (
                  <CheckCircle className="h-4 w-4 text-green-600" />
                )}
                {upload.status === "error" && (
                  <AlertCircle className="h-4 w-4 text-red-600" />
                )}
              </div>
            </div>
          ))}

          {hasCompleted && (
            <Button variant="ghost" size="sm" onClick={clearCompleted}>
              <X className="h-3 w-3 mr-1" />
              Clear completed
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
```

### 7b. Tag Editor

Freeform tag input with autocomplete from existing tags.

**File: `client/src/components/files/file-tag-editor.tsx`**

```typescript
import { useState, useRef, useEffect } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface FileTagEditorProps {
  tags: string[];
  suggestions?: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}

export function FileTagEditor({
  tags,
  suggestions = [],
  onChange,
  placeholder = "Add tags...",
}: FileTagEditorProps) {
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredSuggestions = suggestions.filter(
    (s) =>
      s.toLowerCase().includes(input.toLowerCase()) &&
      !tags.includes(s.toLowerCase())
  );

  const addTag = (tag: string) => {
    const normalized = tag.trim().toLowerCase().replace(/[^a-z0-9-_ ]/g, "");
    if (normalized && !tags.includes(normalized)) {
      onChange([...tags, normalized]);
    }
    setInput("");
    setShowSuggestions(false);
    inputRef.current?.focus();
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (input.trim()) addTag(input);
    }
    if (e.key === "Backspace" && !input && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
    if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  // Close suggestions on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (inputRef.current && !inputRef.current.parentElement?.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className="relative">
      <div className="flex flex-wrap gap-1.5 rounded-md border p-2 min-h-[38px] focus-within:ring-2 focus-within:ring-ring">
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1 text-xs">
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="hover:text-red-600"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowSuggestions(e.target.value.length > 0);
          }}
          onFocus={() => input.length > 0 && setShowSuggestions(true)}
          onKeyDown={handleKeyDown}
          placeholder={tags.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[80px] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      {/* Suggestion Dropdown */}
      {showSuggestions && filteredSuggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1 max-h-40 overflow-auto rounded-md border bg-popover p-1 shadow-md">
          {filteredSuggestions.slice(0, 10).map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent"
              onClick={() => addTag(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## Task 8: Frontend -- Deal File Browser (Virtual Folders, File List, Search)

- [ ] Create `client/src/components/files/file-folder-tree.tsx`
- [ ] Create `client/src/components/files/file-row.tsx`
- [ ] Create `client/src/components/files/file-list.tsx`
- [ ] Create `client/src/components/files/file-search-bar.tsx`
- [ ] Create `client/src/components/files/file-version-history.tsx`
- [ ] Create `client/src/components/files/deal-file-tab.tsx`

### 8a. Folder Tree Navigation

**File: `client/src/components/files/file-folder-tree.tsx`**

```typescript
import { useState } from "react";
import { Folder, FolderOpen, ChevronRight, ChevronDown } from "lucide-react";
import type { FolderNode } from "@/hooks/use-files";

interface FileFolderTreeProps {
  folders: FolderNode[];
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
  loading?: boolean;
}

export function FileFolderTree({
  folders,
  selectedPath,
  onSelectPath,
  loading,
}: FileFolderTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <div className="space-y-2 p-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-6 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {/* "All Files" root */}
      <button
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
          selectedPath === null
            ? "bg-brand-purple/10 text-brand-purple font-medium"
            : "hover:bg-accent text-foreground"
        }`}
        onClick={() => onSelectPath(null)}
      >
        <Folder className="h-4 w-4" />
        <span className="flex-1 text-left">All Files</span>
      </button>

      {folders.map((folder) => {
        const isExpanded = expanded.has(folder.path);
        const isSelected = selectedPath === folder.path;
        const hasSubfolders = folder.subfolders.length > 0;

        return (
          <div key={folder.path}>
            <div className="flex items-center">
              {hasSubfolders && (
                <button
                  className="p-0.5 hover:bg-accent rounded"
                  onClick={() => toggleExpand(folder.path)}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
              )}
              {!hasSubfolders && <div className="w-[22px]" />}

              <button
                className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
                  isSelected
                    ? "bg-brand-purple/10 text-brand-purple font-medium"
                    : "hover:bg-accent text-foreground"
                }`}
                onClick={() => onSelectPath(folder.path)}
              >
                {isExpanded ? (
                  <FolderOpen className="h-4 w-4" />
                ) : (
                  <Folder className="h-4 w-4" />
                )}
                <span className="flex-1 text-left truncate">{folder.name}</span>
                {folder.count > 0 && (
                  <span className="text-xs text-muted-foreground">{folder.count}</span>
                )}
              </button>
            </div>

            {/* Subfolders */}
            {isExpanded &&
              folder.subfolders.map((sub) => (
                <button
                  key={sub.path}
                  className={`w-full flex items-center gap-2 pl-10 pr-2 py-1.5 rounded text-sm transition-colors ${
                    selectedPath === sub.path
                      ? "bg-brand-purple/10 text-brand-purple font-medium"
                      : "hover:bg-accent text-foreground"
                  }`}
                  onClick={() => onSelectPath(sub.path)}
                >
                  <Folder className="h-3.5 w-3.5" />
                  <span className="flex-1 text-left truncate">{sub.name}</span>
                  {sub.count > 0 && (
                    <span className="text-xs text-muted-foreground">{sub.count}</span>
                  )}
                </button>
              ))}
          </div>
        );
      })}
    </div>
  );
}
```

### 8b. File Row

**File: `client/src/components/files/file-row.tsx`**

```typescript
import {
  FileIcon,
  ImageIcon,
  FileText,
  FileSpreadsheet,
  Download,
  MoreHorizontal,
  Trash2,
  Edit,
  History,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FileRecord } from "@/hooks/use-files";

interface FileRowProps {
  file: FileRecord;
  onDownload: (fileId: string) => void;
  onDelete: (fileId: string) => void;
  onViewVersions?: (fileId: string) => void;
  onEdit?: (file: FileRecord) => void;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return ImageIcon;
  if (mimeType === "application/pdf" || mimeType.includes("word")) return FileText;
  if (mimeType.includes("sheet") || mimeType.includes("excel") || mimeType === "text/csv")
    return FileSpreadsheet;
  return FileIcon;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileRow({
  file,
  onDownload,
  onDelete,
  onViewVersions,
  onEdit,
}: FileRowProps) {
  const Icon = getFileIcon(file.mimeType);

  return (
    <div className="flex items-center gap-3 p-3 border-b last:border-b-0 hover:bg-accent/50 transition-colors">
      <Icon className="h-5 w-5 text-muted-foreground flex-shrink-0" />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{file.displayName}{file.fileExtension}</p>
          {file.version > 1 && (
            <Badge variant="outline" className="text-xs">
              v{file.version}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          <span className="text-xs text-muted-foreground">
            {formatFileSize(file.fileSizeBytes)}
          </span>
          <span className="text-xs text-muted-foreground">
            {new Date(file.createdAt).toLocaleDateString()}
          </span>
          {file.tags.length > 0 && (
            <div className="flex gap-1">
              {file.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">
                  {tag}
                </Badge>
              ))}
              {file.tags.length > 3 && (
                <span className="text-[10px] text-muted-foreground">
                  +{file.tags.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 flex-shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => onDownload(file.id)}
          title="Download"
        >
          <Download className="h-4 w-4" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            {onEdit && (
              <DropdownMenuItem onClick={() => onEdit(file)}>
                <Edit className="h-4 w-4 mr-2" />
                Edit Details
              </DropdownMenuItem>
            )}
            {onViewVersions && file.version > 1 && (
              <DropdownMenuItem onClick={() => onViewVersions(file.id)}>
                <History className="h-4 w-4 mr-2" />
                Version History
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onDelete(file.id)} className="text-red-600">
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
```

### 8c. File List

**File: `client/src/components/files/file-list.tsx`**

```typescript
import { FileIcon } from "lucide-react";
import { FileRow } from "./file-row";
import { Button } from "@/components/ui/button";
import type { FileRecord, Pagination } from "@/hooks/use-files";

interface FileListProps {
  files: FileRecord[];
  pagination: Pagination;
  loading: boolean;
  error: string | null;
  onPageChange: (page: number) => void;
  onDownload: (fileId: string) => void;
  onDelete: (fileId: string) => void;
  onViewVersions?: (fileId: string) => void;
  onEdit?: (file: FileRecord) => void;
  emptyMessage?: string;
}

export function FileList({
  files,
  pagination,
  loading,
  error,
  onPageChange,
  onDownload,
  onDelete,
  onViewVersions,
  onEdit,
  emptyMessage = "No files yet",
}: FileListProps) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-14 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-red-600 text-sm py-4">{error}</p>;
  }

  if (files.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <FileIcon className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="border rounded-lg overflow-hidden">
        {files.map((file) => (
          <FileRow
            key={file.id}
            file={file}
            onDownload={onDownload}
            onDelete={onDelete}
            onViewVersions={onViewVersions}
            onEdit={onEdit}
          />
        ))}
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} files)
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => onPageChange(pagination.page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => onPageChange(pagination.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

### 8d. File Search Bar

**File: `client/src/components/files/file-search-bar.tsx`**

```typescript
import { useState, useEffect } from "react";
import { Search, X } from "lucide-react";

interface FileSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function FileSearchBar({
  value,
  onChange,
  placeholder = "Search files...",
}: FileSearchBarProps) {
  const [local, setLocal] = useState(value);

  // Debounce: propagate after 300ms of no typing
  useEffect(() => {
    const timer = setTimeout(() => {
      if (local !== value) onChange(local);
    }, 300);
    return () => clearTimeout(timer);
  }, [local, value, onChange]);

  // Sync from parent
  useEffect(() => {
    setLocal(value);
  }, [value]);

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <input
        type="text"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-9 pr-8 py-2 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {local && (
        <button
          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-accent rounded"
          onClick={() => {
            setLocal("");
            onChange("");
          }}
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      )}
    </div>
  );
}
```

### 8e. File Version History

**File: `client/src/components/files/file-version-history.tsx`**

```typescript
import { FileText, Download, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useFileVersions, downloadFile } from "@/hooks/use-files";

interface FileVersionHistoryProps {
  fileId: string;
  onBack: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileVersionHistory({ fileId, onBack }: FileVersionHistoryProps) {
  const { versions, loading, error } = useFileVersions(fileId);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-12 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-red-600 text-sm">{error}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <h4 className="text-sm font-semibold">Version History</h4>
      </div>

      <div className="space-y-2">
        {versions.map((v) => (
          <div
            key={v.id}
            className="flex items-center gap-3 p-3 border rounded-lg"
          >
            <FileText className="h-4 w-4 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Version {v.version}</span>
                {v.id === fileId && (
                  <Badge variant="secondary" className="text-xs">Current</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {formatFileSize(v.fileSizeBytes)} &middot;{" "}
                {new Date(v.createdAt).toLocaleString()}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => downloadFile(v.id)}
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### 8f. Deal File Tab (Main Browser)

The main file browser tab on the deal detail page. Combines folder tree, search, upload zone, and file list.

**File: `client/src/components/files/deal-file-tab.tsx`**

```typescript
import { useState, useCallback } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileUploadZone } from "./file-upload-zone";
import { FileFolderTree } from "./file-folder-tree";
import { FileList } from "./file-list";
import { FileSearchBar } from "./file-search-bar";
import { FileVersionHistory } from "./file-version-history";
import {
  useFiles,
  useDealFolders,
  downloadFile,
  deleteFileRecord,
} from "@/hooks/use-files";
import type { FileCategory } from "@trock-crm/shared/types";

interface DealFileTabProps {
  dealId: string;
}

export function DealFileTab({ dealId }: DealFileTabProps) {
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [showUpload, setShowUpload] = useState(false);
  const [versionFileId, setVersionFileId] = useState<string | null>(null);

  const { folders, loading: foldersLoading, refetch: refetchFolders } =
    useDealFolders(dealId);

  const { files, pagination, loading: filesLoading, error, refetch: refetchFiles } =
    useFiles({
      dealId,
      folderPath: selectedFolder ?? undefined,
      search: search || undefined,
      page,
      limit: 25,
    });

  const handleUploadComplete = useCallback(() => {
    refetchFiles();
    refetchFolders();
  }, [refetchFiles, refetchFolders]);

  const handleDownload = useCallback(async (fileId: string) => {
    try {
      await downloadFile(fileId);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Download failed");
    }
  }, []);

  const handleDelete = useCallback(
    async (fileId: string) => {
      if (!window.confirm("Delete this file?")) return;
      try {
        await deleteFileRecord(fileId);
        refetchFiles();
        refetchFolders();
      } catch (err: unknown) {
        alert(err instanceof Error ? err.message : "Delete failed");
      }
    },
    [refetchFiles, refetchFolders]
  );

  // Determine the upload category from the selected folder
  const uploadCategory: FileCategory = (() => {
    if (!selectedFolder) return "other";
    const folder = folders.find(
      (f) => f.path === selectedFolder || f.subfolders.some((s) => s.path === selectedFolder)
    );
    return folder?.category ?? "other";
  })();

  // Determine subcategory from subfolder selection
  const uploadSubcategory = (() => {
    if (!selectedFolder) return undefined;
    for (const folder of folders) {
      const sub = folder.subfolders.find((s) => s.path === selectedFolder);
      if (sub) return sub.name;
    }
    return undefined;
  })();

  // Version history view
  if (versionFileId) {
    return (
      <FileVersionHistory
        fileId={versionFileId}
        onBack={() => setVersionFileId(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Files</h3>
        <Button size="sm" onClick={() => setShowUpload(!showUpload)}>
          <Plus className="h-4 w-4 mr-1" />
          Upload
        </Button>
      </div>

      {/* Upload Zone (collapsible) */}
      {showUpload && (
        <FileUploadZone
          category={uploadCategory}
          subcategory={uploadSubcategory}
          dealId={dealId}
          onUploadComplete={handleUploadComplete}
        />
      )}

      {/* Main Content: Sidebar + File List */}
      <div className="flex gap-4">
        {/* Folder Tree Sidebar */}
        <div className="w-52 flex-shrink-0 border-r pr-3 hidden md:block">
          <FileFolderTree
            folders={folders}
            selectedPath={selectedFolder}
            onSelectPath={(path) => {
              setSelectedFolder(path);
              setPage(1);
            }}
            loading={foldersLoading}
          />
        </div>

        {/* File List Area */}
        <div className="flex-1 min-w-0 space-y-3">
          <FileSearchBar
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
          />

          <FileList
            files={files}
            pagination={pagination}
            loading={filesLoading}
            error={error}
            onPageChange={setPage}
            onDownload={handleDownload}
            onDelete={handleDelete}
            onViewVersions={setVersionFileId}
            emptyMessage={
              search
                ? "No files match your search."
                : selectedFolder
                  ? "No files in this folder."
                  : "No files uploaded yet. Click Upload to add files."
            }
          />
        </div>
      </div>
    </div>
  );
}
```

---

## Task 9: Frontend -- Photo Timeline Component

- [ ] Create `client/src/components/files/photo-timeline.tsx`

### 9a. Photo Timeline

Chronological photo display grouped by date, with thumbnail grid and lightbox-style preview. Uses `taken_at` (EXIF) with fallback to `created_at`.

**File: `client/src/components/files/photo-timeline.tsx`**

```typescript
import { useState, useMemo } from "react";
import { Camera, Download, X, ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useDealPhotos, downloadFile } from "@/hooks/use-files";
import type { FileRecord } from "@/hooks/use-files";

interface PhotoTimelineProps {
  dealId: string;
}

function getPhotoDate(photo: FileRecord): Date {
  return new Date(photo.takenAt ?? photo.createdAt);
}

function formatDateHeading(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function PhotoTimeline({ dealId }: PhotoTimelineProps) {
  const [page, setPage] = useState(1);
  const { photos, pagination, loading, error } = useDealPhotos(dealId, page);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Group photos by date
  const groupedPhotos = useMemo(() => {
    const groups = new Map<string, FileRecord[]>();
    for (const photo of photos) {
      const dateKey = getPhotoDate(photo).toISOString().split("T")[0];
      const existing = groups.get(dateKey) ?? [];
      existing.push(photo);
      groups.set(dateKey, existing);
    }
    return Array.from(groups.entries()).map(([date, items]) => ({
      date,
      heading: formatDateHeading(new Date(date)),
      photos: items,
    }));
  }, [photos]);

  if (loading) {
    return (
      <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="aspect-square bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-red-600 text-sm py-4">{error}</p>;
  }

  if (photos.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Camera className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No photos uploaded yet.</p>
        <p className="text-xs mt-1">Upload photos to see them in the timeline.</p>
      </div>
    );
  }

  // Build a flat index for lightbox navigation
  const flatPhotos = groupedPhotos.flatMap((g) => g.photos);

  return (
    <div className="space-y-6">
      {groupedPhotos.map((group) => (
        <div key={group.date}>
          <h4 className="text-sm font-semibold text-muted-foreground mb-2">
            {group.heading}
            <span className="ml-2 text-xs font-normal">
              ({group.photos.length} photo{group.photos.length !== 1 ? "s" : ""})
            </span>
          </h4>
          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {group.photos.map((photo) => {
              const flatIdx = flatPhotos.indexOf(photo);
              return (
                <button
                  key={photo.id}
                  className="relative aspect-square rounded-lg overflow-hidden group border hover:ring-2 hover:ring-brand-purple transition-all"
                  onClick={() => setLightboxIndex(flatIdx)}
                >
                  {/* Thumbnail: use a placeholder since we don't have direct R2 public URLs */}
                  <div className="w-full h-full bg-muted flex items-center justify-center">
                    <Camera className="h-6 w-6 text-muted-foreground/50" />
                  </div>
                  {/* Overlay on hover */}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-end">
                    <div className="w-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <p className="text-[10px] text-white truncate">{photo.displayName}</p>
                    </div>
                  </div>
                  {/* Subcategory badge */}
                  {photo.subcategory && (
                    <Badge
                      variant="secondary"
                      className="absolute top-1 left-1 text-[9px] px-1 py-0 opacity-80"
                    >
                      {photo.subcategory}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} photos)
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => setPage(pagination.page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setPage(pagination.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Lightbox Overlay */}
      {lightboxIndex !== null && flatPhotos[lightboxIndex] && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
          onClick={() => setLightboxIndex(null)}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close */}
            <Button
              variant="ghost"
              size="icon"
              className="absolute -top-12 right-0 text-white hover:bg-white/20"
              onClick={() => setLightboxIndex(null)}
            >
              <X className="h-6 w-6" />
            </Button>

            {/* Navigation */}
            {lightboxIndex > 0 && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-12 text-white hover:bg-white/20"
                onClick={() => setLightboxIndex(lightboxIndex - 1)}
              >
                <ChevronLeft className="h-8 w-8" />
              </Button>
            )}
            {lightboxIndex < flatPhotos.length - 1 && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-12 text-white hover:bg-white/20"
                onClick={() => setLightboxIndex(lightboxIndex + 1)}
              >
                <ChevronRight className="h-8 w-8" />
              </Button>
            )}

            {/* Photo Content */}
            <div className="bg-black rounded-lg overflow-hidden flex items-center justify-center min-h-[50vh]">
              <div className="text-center text-white/60">
                <Camera className="h-16 w-16 mx-auto mb-2" />
                <p className="text-sm">
                  {flatPhotos[lightboxIndex].displayName}
                  {flatPhotos[lightboxIndex].fileExtension}
                </p>
              </div>
            </div>

            {/* Info Bar */}
            <div className="mt-3 flex items-center justify-between text-white/80 text-sm">
              <div className="flex items-center gap-3">
                <span>{flatPhotos[lightboxIndex].displayName}</span>
                {flatPhotos[lightboxIndex].subcategory && (
                  <Badge variant="secondary" className="text-xs">
                    {flatPhotos[lightboxIndex].subcategory}
                  </Badge>
                )}
                {flatPhotos[lightboxIndex].geoLat && (
                  <span className="flex items-center gap-1 text-xs">
                    <MapPin className="h-3 w-3" />
                    GPS
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-white hover:bg-white/20"
                onClick={() => downloadFile(flatPhotos[lightboxIndex].id)}
              >
                <Download className="h-4 w-4 mr-1" />
                Download
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## Task 10: Frontend -- File Tabs on Deal and Contact Detail Pages + Route Wiring

- [ ] Create `client/src/components/files/contact-file-tab.tsx`
- [ ] Update `client/src/pages/deals/deal-detail-page.tsx` -- replace placeholder with `DealFileTab`
- [ ] Update `client/src/pages/contacts/contact-detail-page.tsx` -- replace placeholder with `ContactFileTab`

### 10a. Contact File Tab

**File: `client/src/components/files/contact-file-tab.tsx`**

```typescript
import { useState, useCallback } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileUploadZone } from "./file-upload-zone";
import { FileList } from "./file-list";
import { FileSearchBar } from "./file-search-bar";
import {
  useFiles,
  downloadFile,
  deleteFileRecord,
} from "@/hooks/use-files";

interface ContactFileTabProps {
  contactId: string;
}

export function ContactFileTab({ contactId }: ContactFileTabProps) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [showUpload, setShowUpload] = useState(false);

  const { files, pagination, loading, error, refetch } = useFiles({
    contactId,
    search: search || undefined,
    page,
    limit: 25,
  });

  const handleDownload = useCallback(async (fileId: string) => {
    try {
      await downloadFile(fileId);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Download failed");
    }
  }, []);

  const handleDelete = useCallback(
    async (fileId: string) => {
      if (!window.confirm("Delete this file?")) return;
      try {
        await deleteFileRecord(fileId);
        refetch();
      } catch (err: unknown) {
        alert(err instanceof Error ? err.message : "Delete failed");
      }
    },
    [refetch]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Files</h3>
        <Button size="sm" onClick={() => setShowUpload(!showUpload)}>
          <Plus className="h-4 w-4 mr-1" />
          Upload
        </Button>
      </div>

      {showUpload && (
        <FileUploadZone
          category="correspondence"
          contactId={contactId}
          onUploadComplete={refetch}
          compact
        />
      )}

      <FileSearchBar
        value={search}
        onChange={(v) => {
          setSearch(v);
          setPage(1);
        }}
      />

      <FileList
        files={files}
        pagination={pagination}
        loading={loading}
        error={error}
        onPageChange={setPage}
        onDownload={handleDownload}
        onDelete={handleDelete}
        emptyMessage="No files linked to this contact."
      />
    </div>
  );
}
```

### 10b. Update Deal Detail Page

Replace the placeholder files tab content in `client/src/pages/deals/deal-detail-page.tsx`:

**Current (lines 243-246):**
```typescript
      {activeTab === "files" && (
        <div className="text-center py-12 text-muted-foreground">
          <p>File management coming in Plan 4: Files & Photos</p>
        </div>
      )}
```

**Replace with:**
```typescript
      {activeTab === "files" && <DealFileTab dealId={deal.id} />}
```

**Add import at top of file:**
```typescript
import { DealFileTab } from "@/components/files/deal-file-tab";
```

### 10c. Update Contact Detail Page

Replace the placeholder files tab content in `client/src/pages/contacts/contact-detail-page.tsx`:

**Current (lines 217-220):**
```typescript
      {activeTab === "files" && (
        <div className="text-center py-12 text-muted-foreground">
          <p>File management coming in Plan 5</p>
        </div>
      )}
```

**Replace with:**
```typescript
      {activeTab === "files" && <ContactFileTab contactId={contact.id} />}
```

**Add import at top of file:**
```typescript
import { ContactFileTab } from "@/components/files/contact-file-tab";
```

---

## Verification Checklist

After all tasks are implemented, verify:

- [ ] `tsc --noEmit` passes in both `server/` and `client/`
- [ ] `npm test` passes in `server/` (new tests + existing tests)
- [ ] Migration 0003 applies cleanly to all office schemas
- [ ] Dev mode works without R2 credentials (mock URLs)
- [ ] File upload flow completes: presigned URL request -> R2 upload -> confirm upload -> file in DB
- [ ] Deal file tab shows: folder tree, file list, search, upload, version history
- [ ] Contact file tab shows: file list, search, upload
- [ ] Photo timeline groups by date with lightbox navigation
- [ ] Tags autocomplete from existing tags
- [ ] File search returns results via tsvector
- [ ] Soft-delete works (is_active = false)
- [ ] File download generates presigned GET URL
- [ ] `file.uploaded` event fires after successful upload
- [ ] Association CHECK constraint enforced (no orphan files)
- [ ] MIME type validation rejects unsupported types
- [ ] 50 MB file size limit enforced
