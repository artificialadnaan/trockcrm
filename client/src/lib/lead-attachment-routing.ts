import type { FileCategory } from "@/lib/file-utils";
import { getFileExtension } from "@/lib/file-utils";

export const CLIENT_PROVIDED_DOCS_TAG = "client_provided_docs";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif"]);

export function inferClientProvidedDocsCategory(file: File): FileCategory {
  const ext = getFileExtension(file.name);
  return file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(ext) ? "photo" : "other";
}
