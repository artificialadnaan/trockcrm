// deals.project_number is text; keep API/script writes within the import/staging column size.
export const PROJECT_NUMBER_MAX_LENGTH = 100;

// Strict canonical form for newly-generated project numbers. Single-digit non-zero
// project-type code, exactly 5 digits, one-or-more lowercase letter suffix (allows
// rollover from "a" to "aa" once the per-prefix sequence wraps).
// Example: DFW-1-12345-a, ATL-2-54321-aaa
//
// This governs numbers the GENERATOR produces (buildProjectNumber validates its own
// output against it). It is intentionally narrow and must NOT be loosened.
export const CANONICAL_PROJECT_NUMBER_REGEX_STRICT =
  /^(DFW|ATL)-[1-9]-[0-9]{5}-[a-z]+$/;

// True if the string contains an ASCII control character: C0 controls (codes 0x00-0x1F,
// which include tab/newline/CR) or DEL (0x7F). Such characters break URL params,
// exact-match lookups, CSV round-trips, and log lines, so a project number must never
// contain them. Checked by char code (not a regex literal) to keep the source free of
// invisible control bytes.
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * ACCEPTED guard for project numbers on import / PATCH / display paths.
 *
 * The generator owns the forward canonical format (CANONICAL_PROJECT_NUMBER_REGEX_STRICT),
 * so ACCEPTED's only job is to never reject a value that already exists in production.
 * Production contains 270+ distinct historical formats (custom rep codes, dot- and
 * space-separated codes, mixed case, embedded descriptions) that predate canonical
 * numbering. Enumerating them by regex is what failed previously; instead this is a
 * single bounded "any sane string" rule.
 *
 * Returns true iff, after trimming outer whitespace, the value is a non-empty string
 * of at most PROJECT_NUMBER_MAX_LENGTH characters containing no ASCII control chars.
 * Internal whitespace and punctuation are preserved (e.g. an embedded description like
 * "...-Garage door Repair" is a real production value and must pass).
 */
export function isAcceptedProjectNumber(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > PROJECT_NUMBER_MAX_LENGTH) return false;
  if (hasControlCharacter(trimmed)) return false;
  return true;
}

export function isStrictCanonicalProjectNumber(value: string): boolean {
  return CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test(value);
}

export class ProjectNumberValidationError extends Error {
  readonly code = "PROJECT_NUMBER_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ProjectNumberValidationError";
  }
}

/**
 * Normalizes a project-number input for storage.
 *
 * - null / undefined / empty / whitespace-only -> null ("no project number"); this
 *   matches the HubSpot import path (normalizeHubSpotProjectNumber) so blank cells
 *   never raise, they clear the field.
 * - a non-string (other than null/undefined) is a caller programming error -> throws.
 * - an over-length or control-char-bearing value -> throws ProjectNumberValidationError.
 * - otherwise returns the trimmed value (internal characters preserved).
 */
export function normalizeProjectNumberInput(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new ProjectNumberValidationError("projectNumber must be a string");
  }

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (!isAcceptedProjectNumber(trimmed)) {
    throw new ProjectNumberValidationError(
      trimmed.length > PROJECT_NUMBER_MAX_LENGTH
        ? `projectNumber must not exceed ${PROJECT_NUMBER_MAX_LENGTH} characters`
        : "projectNumber must not contain control characters"
    );
  }

  return trimmed;
}
