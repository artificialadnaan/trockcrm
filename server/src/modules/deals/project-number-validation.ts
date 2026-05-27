export const CANONICAL_PROJECT_NUMBER_REGEX = /^(DFW|ATL)-[0-9]+-[0-9]{5}-[a-z]{2}$/;
// deals.project_number is text; keep API/script writes within the import/staging column size.
export const PROJECT_NUMBER_MAX_LENGTH = 100;

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
  if (!CANONICAL_PROJECT_NUMBER_REGEX.test(trimmed)) {
    throw new ProjectNumberValidationError(
      "projectNumber must match canonical format DFW-1-12345-aa or ATL-1-12345-aa"
    );
  }

  return trimmed;
}
