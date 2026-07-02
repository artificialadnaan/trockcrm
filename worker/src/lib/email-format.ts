/**
 * Small shared helpers for worker email jobs (HTML escaping + job-payload normalization). Extracted so the
 * field-scorecard and RFP email jobs share one implementation instead of each keeping an identical copy.
 */

/** Escape the five HTML-significant characters for safe interpolation into an email body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Trim a value to a non-empty string, or null (used to normalize optional job-payload text fields). */
export function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Guard for a tenant schema identifier before interpolating it into SQL (office_<slug> only). */
export function isSafeTenantSchema(value: unknown): value is string {
  return typeof value === "string" && /^office_[a-z0-9_]+$/.test(value);
}
