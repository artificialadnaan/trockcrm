import type { FileCategory } from "@trock-crm/shared/types";

/**
 * Pure document-type inference for `files.category`.
 *
 * Maps the available per-file signals (filename, MIME type, subcategory, change-order FK) to a valid
 * `FILE_CATEGORIES` enum member. It ALWAYS returns a valid member; `"other"` is the safe fallback (it
 * never throws on unknown/empty input).
 *
 * Used by:
 *  - the manual-upload path (`requestUploadUrl`) — only when the caller's category is `"other"` (the
 *    client default), so an explicit category is always respected; and
 *  - the one-off backfill script (`scripts/backfill-file-categories.ts`) — re-typing existing
 *    `category='other'` rows.
 *
 * Design notes:
 *  - Images are photos: an image MIME (or image extension) ALWAYS wins as `"photo"` before any filename
 *    keyword, so a `contract.jpg` scan is treated as a photo, never mis-filed under a document filter.
 *  - The user's subcategory hint is a stronger signal than the filename. (folderPath is intentionally
 *    excluded — see the note on InferFileCategoryInput.)
 *  - There is no `drawing`/`plan` enum member (so `.dwg/.dxf` → `other`) and no `report` member (so
 *    generated "Photo Report" PDFs stay `other`).
 */

export interface InferFileCategoryInput {
  /** Original filename or display name. */
  filename?: string | null;
  mimeType?: string | null;
  /** User-supplied subcategory hint (e.g. "Permit"). A real signal — unlike folderPath. */
  subcategory?: string | null;
  /** Explicit change-order link — the strongest `change_order` signal. Present on existing rows. */
  changeOrderId?: string | null;
}
// NOTE: folderPath is deliberately NOT a signal. It is DERIVED from the category (CATEGORY_TO_FOLDER),
// and for the only rows we ever infer (category='other') it is always the catch-all folder
// "Correspondence" — which would poison every such file to `correspondence`. The user's subcategory
// hint (carried separately) is the real folder-level signal.

const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "heic",
  "heif",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "svg",
]);

/**
 * Priority-ordered keyword rules. Each maps to a valid `FileCategory`. Order matters: more specific or
 * higher-precedence categories come first (e.g. `change_order` before generic words; `rfp` before
 * `proposal` so "request for proposal" resolves to `rfp`). Patterns run against a lower-cased signal.
 * Deliberately NO "report" rule — generated photo reports have no enum and must stay `other`.
 */
const KEYWORD_RULES: ReadonlyArray<{ category: FileCategory; patterns: readonly RegExp[] }> = [
  { category: "change_order", patterns: [/change[\s_-]?order/, /\bchangeorder\b/, /\bco[\s_-]\d/, /\bco[\s_-]?#/] },
  { category: "rfp", patterns: [/\brfps?\b/, /request[\s_-]?for[\s_-]?proposal/] },
  { category: "contract", patterns: [/\bcontracts?\b/, /\bagreement/, /\bmsa\b/, /\bsow\b/, /scope[\s_-]?of[\s_-]?work/] },
  { category: "estimate", patterns: [/\bestimate/, /\bquote/, /\bquotation/] },
  { category: "proposal", patterns: [/\bproposal/] },
  { category: "permit", patterns: [/\bpermit/] },
  { category: "inspection", patterns: [/\binspection/, /\bpunch[\s_-]?list/, /\bpunchlist/] },
  { category: "insurance", patterns: [/\binsurance/, /\bcoi\b/, /certificate[\s_-]?of[\s_-]?insurance/] },
  { category: "warranty", patterns: [/\bwarrant/] },
  { category: "closeout", patterns: [/close[\s_-]?out/, /\bas[\s_-]?built/, /\bo\s?&\s?m\b/] },
  { category: "correspondence", patterns: [/correspondence/, /\bletter\b/, /\bmemo\b/] },
];

function extensionOf(filename: string): string {
  const match = /\.([a-z0-9]+)\s*$/i.exec(filename.trim());
  return match ? match[1].toLowerCase() : "";
}

function matchKeyword(text: string): FileCategory | null {
  if (!text) return null;
  // Treat "_" as a separator: it's a regex word char, so a leading/trailing \b won't fire next to it
  // (e.g. /\brfps?\b/ would miss "rfp_2026"). The system's own auto-naming uses underscores, so
  // normalize them to spaces before matching.
  const normalized = text.replace(/_/g, " ");
  for (const rule of KEYWORD_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) {
      return rule.category;
    }
  }
  return null;
}

export function inferFileCategory(input: InferFileCategoryInput): FileCategory {
  const filename = (input.filename ?? "").trim();
  const mimeType = (input.mimeType ?? "").toLowerCase().trim();

  // 1. Images are photos, regardless of filename keywords — never doc-classify an image.
  if (mimeType.startsWith("image/") || IMAGE_EXTENSIONS.has(extensionOf(filename))) {
    return "photo";
  }

  // 2. Strongest structured signal: an explicit change-order link.
  if (input.changeOrderId) {
    return "change_order";
  }

  // 3. The user's subcategory hint outranks the filename.
  const fromSubcategory = matchKeyword((input.subcategory ?? "").toLowerCase());
  if (fromSubcategory) {
    return fromSubcategory;
  }

  const fromFilename = matchKeyword(filename.toLowerCase());
  if (fromFilename) {
    return fromFilename;
  }

  // 4. Safe fallback.
  return "other";
}
