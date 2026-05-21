import { AppError } from "../middleware/error-handler.js";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertOptionalIsoDateQueryParam(
  value: unknown,
  fieldName: string
): string | undefined {
  if (value == null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new AppError(400, `${fieldName} must be an ISO date in YYYY-MM-DD format`);
  }

  const trimmed = value.trim();
  if (!ISO_DATE_RE.test(trimmed)) {
    throw new AppError(400, `${fieldName} must be an ISO date in YYYY-MM-DD format`);
  }

  const [year, month, day] = trimmed.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new AppError(400, `${fieldName} must be an ISO date in YYYY-MM-DD format`);
  }

  return trimmed;
}
