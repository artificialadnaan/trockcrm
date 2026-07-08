import { BUSINESS_TIMEZONE } from "../../lib/period.js";

/** "YYYY-MM-DD" for the America/Chicago calendar day of `at` (DST-safe via Intl; en-CA yields YYYY-MM-DD). */
export function businessDateStamp(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * Prepend an archive block to a deal's description, preserving the original.
 * Empty/whitespace `existing` -> just the block (no leading blank lines). `reason` is trimmed;
 * callers guarantee it is non-empty.
 */
export function buildArchivedDescription(
  existing: string | null | undefined,
  reason: string,
  at: Date,
): string {
  const block = `[Archived ${businessDateStamp(at)} — ${reason.trim()}]`;
  const prior = (existing ?? "").trim();
  return prior.length > 0 ? `${block}\n\n${prior}` : block;
}
