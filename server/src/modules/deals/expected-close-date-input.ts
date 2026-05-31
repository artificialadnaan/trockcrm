import { AppError } from "../../middleware/error-handler.js";

const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate the OPTIONAL `expectedCloseDate` carried by a stage-change request body. A no-op when the
 * field is absent/empty; otherwise the value MUST be a string in `YYYY-MM-DD` shape that round-trips
 * as a real calendar date. Anything else throws a clean 400 here so a malformed value never reaches
 * `changeDealStage` / the Postgres `date` column (where it would surface as a generic 500).
 *
 * The `typeof` guard runs FIRST and is load-bearing: `RegExp.test` and template strings coerce
 * non-strings to their string form, so a JSON array like `["2026-12-01"]` would otherwise pass both
 * the shape check and the round-trip check and be assigned to the date column.
 */
export function validateOptionalExpectedCloseDateInput(value: unknown): void {
  if (value == null || value === "") return;
  if (typeof value !== "string" || !ISO_DATE_SHAPE.test(value)) {
    throw new AppError(400, "expectedCloseDate must be an ISO date (YYYY-MM-DD)");
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AppError(400, "expectedCloseDate must be a real calendar date (YYYY-MM-DD)");
  }
}
