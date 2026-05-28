// deals.project_number is text; keep API/script writes within the import/staging column size.
export const PROJECT_NUMBER_MAX_LENGTH = 100;

// Strict canonical form for newly-generated project numbers. Single-digit non-zero
// project-type code, exactly 5 digits, one-or-more lowercase letter suffix (allows
// rollover from "a" to "aa" once the per-prefix sequence wraps).
// Example: DFW-1-12345-a, ATL-2-54321-aaa
export const CANONICAL_PROJECT_NUMBER_REGEX_STRICT =
  /^(DFW|ATL)-[1-9]-[0-9]{5}-[a-z]+$/;

// Lenient canonical form: allows multi-digit or letter project-type codes that exist
// in production from legacy imports. Requires the central numeric component to have
// at least five digits to preserve the existing rejection of short numbers like
// "DFW-1-1234-aa" while accepting the operator-confirmed legacy examples below.
// Examples: DFW-a-05826-ad (letter type-code), DFW-10-12345-aa (multi-digit type-code)
const ACCEPTED_LEGACY_CANONICAL_REGEX =
  /^(DFW|ATL)-[A-Za-z0-9]{1,4}-[0-9]{5,8}-[a-zA-Z]+$/;

// Custom rep-prefix alphanumeric codes used historically before canonical numbering
// was introduced. Must start with an uppercase letter and be 7-20 chars (the floor
// is just under the shortest operator example, KMRPMTND/8 chars). NOTE: this is a
// permissive sanity check, NOT a precise allowlist. Because production contains
// free-form rep codes we cannot fully enumerate, this pattern cannot distinguish a
// genuine legacy code from a plausible-looking uppercase token (e.g. "PENDING" or a
// hyphen-less "DFW12345" would also pass). The floor/letter-start only filter out
// short scratch tokens ("TODO", "TBD"). This is acceptable because the projectNumber
// field is admin/director-only, so values are entered deliberately, not by reps.
// Examples: KMPWINTERS, KMTIDESNDDEMO, KMRPMLVRRR, KMRPMLVIN, ASRPMLVIUN, KMRPMTND
const ACCEPTED_CUSTOM_REP_PREFIX_REGEX = /^[A-Z][A-Z0-9]{6,19}$/;

// Legacy import date-suffix codes: a non-zero leading project-type digit (matching
// the [1-9] convention enforced by the strict canonical form), hyphen, a code of
// 2-9 chars (uppercase letters/digits, which may contain a literal dot), an optional
// middle alphabetic segment, then a 6-digit (MMDDYY) date suffix.
// Examples: 1-TLV.1-091625, 1-TND.1-081425, 1-THR.1-FCP-092425,
//           2-TAT3-111325, 2-MPA1-100225, 2-CSP.1-101325
const ACCEPTED_LEGACY_DATE_SUFFIX_REGEX =
  /^[1-9]-[A-Z][A-Z0-9.]{1,8}(?:-[A-Z]+)?-[0-9]{6}$/;

const ACCEPTED_PROJECT_NUMBER_REGEXES = [
  CANONICAL_PROJECT_NUMBER_REGEX_STRICT,
  ACCEPTED_LEGACY_CANONICAL_REGEX,
  ACCEPTED_CUSTOM_REP_PREFIX_REGEX,
  ACCEPTED_LEGACY_DATE_SUFFIX_REGEX,
] as const;

export function isAcceptedProjectNumber(value: string): boolean {
  return ACCEPTED_PROJECT_NUMBER_REGEXES.some((regex) => regex.test(value));
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

export function normalizeProjectNumberInput(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new ProjectNumberValidationError("projectNumber must be a string");
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new ProjectNumberValidationError("projectNumber cannot be blank");
  }
  if (trimmed.length > PROJECT_NUMBER_MAX_LENGTH) {
    throw new ProjectNumberValidationError(
      `projectNumber must not exceed ${PROJECT_NUMBER_MAX_LENGTH} characters`
    );
  }
  if (!isAcceptedProjectNumber(trimmed)) {
    throw new ProjectNumberValidationError(
      "projectNumber must match canonical format DFW-1-12345-aa or ATL-1-12345-aa, or a recognized legacy format"
    );
  }

  return trimmed;
}
