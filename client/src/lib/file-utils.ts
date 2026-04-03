/**
 * File utility functions for the frontend.
 * MIME type icons, file size formatting, category labels/colors, auto-naming preview.
 */

// ─── File Categories ────────────────────────────────────────────────────────

export const FILE_CATEGORIES = [
  "photo",
  "contract",
  "rfp",
  "estimate",
  "change_order",
  "proposal",
  "permit",
  "inspection",
  "correspondence",
  "insurance",
  "warranty",
  "closeout",
  "other",
] as const;

export type FileCategory = (typeof FILE_CATEGORIES)[number];

// ─── MIME Type Helpers ──────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heic",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/csv": ".csv",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/plain": ".txt",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
};

export const ALLOWED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic",
  ".pdf", ".doc", ".docx",
  ".xls", ".xlsx", ".csv",
  ".ppt", ".pptx",
  ".txt", ".zip",
]);

export const MAX_FILE_SIZE_MB = 50;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

/**
 * Check if a MIME type is allowed for upload.
 */
export function isAllowedMimeType(mimeType: string): boolean {
  return mimeType in ALLOWED_MIME_TYPES;
}

/**
 * Check if a file extension is allowed for upload.
 */
export function isAllowedExtension(filename: string): boolean {
  const ext = getFileExtension(filename);
  return ALLOWED_EXTENSIONS.has(ext);
}

/**
 * Extract the file extension from a filename (lowercased, with dot).
 */
export function getFileExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex < 0) return "";
  return filename.substring(dotIndex).toLowerCase();
}

// ─── MIME Type to Icon Name Mapping ─────────────────────────────────────────

export type FileIconType = "image" | "pdf" | "word" | "spreadsheet" | "presentation" | "text" | "archive" | "generic";

/**
 * Map a MIME type to an icon type for rendering the correct lucide icon.
 */
export function getMimeIconType(mimeType: string): FileIconType {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.includes("word") || mimeType === "application/msword") return "word";
  if (
    mimeType.includes("sheet") ||
    mimeType.includes("excel") ||
    mimeType === "text/csv" ||
    mimeType === "application/vnd.ms-excel"
  ) {
    return "spreadsheet";
  }
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) return "presentation";
  if (mimeType === "text/plain") return "text";
  if (mimeType.includes("zip")) return "archive";
  return "generic";
}

// ─── File Size Formatting ───────────────────────────────────────────────────

/**
 * Format a file size in bytes to a human-readable string.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ─── Category Labels and Colors ─────────────────────────────────────────────

const CATEGORY_LABELS: Record<FileCategory, string> = {
  photo: "Photo",
  contract: "Contract",
  rfp: "RFP",
  estimate: "Estimate",
  change_order: "Change Order",
  proposal: "Proposal",
  permit: "Permit",
  inspection: "Inspection",
  correspondence: "Correspondence",
  insurance: "Insurance",
  warranty: "Warranty",
  closeout: "Closeout",
  other: "Other",
};

const CATEGORY_COLORS: Record<FileCategory, string> = {
  photo: "bg-blue-100 text-blue-700",
  contract: "bg-green-100 text-green-700",
  rfp: "bg-red-100 text-red-700",
  estimate: "bg-orange-100 text-orange-700",
  change_order: "bg-amber-100 text-amber-700",
  proposal: "bg-indigo-100 text-indigo-700",
  permit: "bg-teal-100 text-teal-700",
  inspection: "bg-cyan-100 text-cyan-700",
  correspondence: "bg-gray-100 text-gray-700",
  insurance: "bg-rose-100 text-rose-700",
  warranty: "bg-emerald-100 text-emerald-700",
  closeout: "bg-slate-100 text-slate-700",
  other: "bg-neutral-100 text-neutral-700",
};

/**
 * Get a human-readable label for a file category.
 */
export function getCategoryLabel(category: FileCategory): string {
  return CATEGORY_LABELS[category] ?? category;
}

/**
 * Get Tailwind color classes for a file category badge.
 */
export function getCategoryColor(category: FileCategory): string {
  return CATEGORY_COLORS[category] ?? "bg-gray-100 text-gray-700";
}

// ─── Auto-Naming Preview ────────────────────────────────────────────────────

/**
 * Generate a preview of the auto-named filename (client-side approximation).
 * Pattern: {DealNumber}_{Category}_{YYYY-MM-DD}_{Seq}.{ext}
 * The server generates the actual filename with proper sequencing.
 */
export function generatePreviewName(
  originalFilename: string,
  category: FileCategory,
  dealNumber?: string
): string {
  const ext = getFileExtension(originalFilename);
  const dateStr = new Date().toISOString().split("T")[0];
  const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1).replace(/_/g, "-");

  if (dealNumber) {
    return `${dealNumber}_${categoryLabel}_${dateStr}_001${ext}`;
  }
  return `${categoryLabel}_${dateStr}${ext}`;
}

// ─── Subcategory Options ────────────────────────────────────────────────────

const SUBCATEGORY_OPTIONS: Partial<Record<FileCategory, string[]>> = {
  photo: ["Site Visits", "Progress", "Final Walkthrough", "Damage"],
  estimate: ["DD Estimate", "Bid Estimate", "Revisions"],
};

/**
 * Get available subcategory options for a file category.
 */
export function getSubcategoryOptions(category: FileCategory): string[] {
  return SUBCATEGORY_OPTIONS[category] ?? [];
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate a file for upload. Returns null if valid, or an error message string.
 */
export function validateFileForUpload(file: File): string | null {
  const ext = getFileExtension(file.name);

  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    return `"${ext || "(none)"}" files are not supported.`;
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `File is ${(file.size / 1024 / 1024).toFixed(1)} MB. Max is ${MAX_FILE_SIZE_MB} MB.`;
  }
  if (file.size === 0) {
    return "File is empty.";
  }
  return null;
}
