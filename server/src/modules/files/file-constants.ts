import { isPostgresCalendarDate, isPostgresTzOffset } from "../../lib/pg-timestamp.js";
import type { FileCategory } from "@trock-crm/shared/types";

/**
 * Maximum file size in bytes (200 MB).
 */
export const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;

/**
 * Presigned URL expiry in seconds (30 minutes).
 */
export const PRESIGNED_URL_EXPIRY_SECONDS = 30 * 60;

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
  // Email exports
  "message/rfc822": ".eml",
  "application/vnd.ms-outlook": ".msg",
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
  ".eml", ".msg",
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
 * Build the virtual folder path for a file from its category (+ optional subcategory + date). Shared by
 * the upload path (requestUploadUrl) and the category backfill so a re-typed file lands in the folder
 * matching its new category, consistent with new uploads.
 */
export function buildFolderPath(category: FileCategory, subcategory?: string, dateForBucket?: Date): string {
  const topFolder = CATEGORY_TO_FOLDER[category] || "Other";
  let path = topFolder;
  if (subcategory) {
    path = `${topFolder}/${subcategory}`;
  }
  // For photo files, append the year-month bucket.
  if (category === "photo" && dateForBucket) {
    const yearMonth = dateForBucket.toISOString().slice(0, 7); // "YYYY-MM"
    path = `${path}/${yearMonth}`;
  }
  return path;
}

/**
 * Validate/normalize a date query param for the Files filter. Accepts a date-only "YYYY-MM-DD" (bucketed
 * as a business-tz calendar day downstream) or a full ISO timestamp (must contain a 'T'). Returning
 * undefined DROPS the filter rather than letting bad input reach the SQL ::date / ::timestamptz cast in
 * getFiles (which would surface as a 500 instead of an ignored param). The UI only ever sends valid
 * <input type="date"> values; this guards the directly-reachable endpoint against the two classes that
 * Date.parse accepts but Postgres rejects:
 *   - calendar day-overflow ("2026-02-30", "2026-04-31") — Date.parse silently rolls these forward, so we
 *     reject any date-only value that does not round-trip back to the same string;
 *   - reduced-precision ISO ("2026", "2026-07") — Date.parse accepts these but '2026'::date errors, so a
 *     non-date-only value must carry an explicit time component ('T').
 */
export function parseFileDateParam(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v) return undefined;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (dateOnly) {
    // Round-trips through a UTC Date to reject month- AND day-overflow (2026-13-45, 2026-02-30,
    // 2026-04-31), and checks the YEAR separately because the round-trip is faithful for year zero and
    // therefore cannot catch it — Postgres has no year 0, JavaScript does. See lib/pg-timestamp.ts.
    return isPostgresCalendarDate(dateOnly[1], dateOnly[2], dateOnly[3]) ? v : undefined;
  }

  // Not date-only: require an explicit time component so reduced-precision forms ("2026", "2026-07") are
  // dropped here instead of surfacing as a 500 at the SQL cast.
  if (!v.includes("T")) return undefined;
  if (Number.isNaN(Date.parse(v))) return undefined;
  // `Date.parse` is necessary but NOT sufficient, in two independent ways, and BOTH end as an unmapped
  // 500 at the `::timestamptz` cast rather than the documented "drop the invalid date filter":
  //   1. it NORMALIZES calendar overflow ("2026-02-30T00:00:00Z" silently becomes March 2) and reports
  //      success, and it accepts year 0000, which Postgres has no concept of;
  //   2. it accepts timezone offsets out to ±23:59, while Postgres caps at ±15:59.
  // Both bounds are owned by lib/pg-timestamp.ts and shared with the feed's cursor validator, because
  // these two used to disagree and each carried a hole the other did not.
  const parts = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/.exec(v);
  if (!parts) return undefined;
  if (!isPostgresCalendarDate(parts[1], parts[2], parts[3])) return undefined;
  if (!isPostgresTzOffset(parts[4])) return undefined;
  return v;
}

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
  "message/rfc822": [".eml"],
  "application/vnd.ms-outlook": [".msg"],
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
