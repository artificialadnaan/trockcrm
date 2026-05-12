export type FileMediaKind = "image" | "pdf" | "video" | "document" | "file";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm"]);
const DOCUMENT_EXTENSIONS = new Set(["doc", "docx", "xls", "xlsx", "csv", "txt", "zip"]);

function extensionFromValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const withoutQuery = value.split("?")[0]?.split("#")[0] ?? value;
  const match = withoutQuery.match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function getFileMediaKind(input: {
  mimeType?: string | null;
  fileExtension?: string | null;
  displayName?: string | null;
  originalFilename?: string | null;
  r2Key?: string | null;
  externalUrl?: string | null;
  externalThumbnailUrl?: string | null;
}): FileMediaKind {
  const mimeType = input.mimeType?.toLowerCase() ?? "";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("video/")) return "video";
  if (
    mimeType.includes("word") ||
    mimeType.includes("excel") ||
    mimeType.includes("sheet") ||
    mimeType === "text/csv" ||
    mimeType === "text/plain" ||
    mimeType.includes("zip")
  ) {
    return "document";
  }

  const extension =
    input.fileExtension?.replace(/^\./, "").toLowerCase() ||
    extensionFromValue(input.displayName) ||
    extensionFromValue(input.originalFilename) ||
    extensionFromValue(input.r2Key) ||
    extensionFromValue(input.externalUrl) ||
    extensionFromValue(input.externalThumbnailUrl);

  if (!extension) return "file";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === "pdf") return "pdf";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  return "file";
}
