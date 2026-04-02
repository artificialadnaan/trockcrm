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
 * Reverse mapping: MIME type -> allowed extensions for that MIME.
 * Used to validate that the declared MIME type matches the file extension.
 */
export const MIME_TO_EXTENSIONS: Record<string, string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "image/heic": [".heic"],
  "image/heif": [".heic"],
  "application/pdf": [".pdf"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.ms-excel": [".xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "text/csv": [".csv"],
  "application/vnd.ms-powerpoint": [".ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
  "text/plain": [".txt"],
  "application/zip": [".zip"],
  "application/x-zip-compressed": [".zip"],
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
