/**
 * Empty-string hardening for the deal update (PATCH) path.
 *
 * updateDeal writes the relationship id fields straight into Postgres `uuid`
 * columns (`if (input.<field> !== undefined) updates.<col> = input.<field>`).
 * An empty (or whitespace-only) string fails the uuid cast (22P02 -> 500), and
 * an explicit `null` is rejected upstream ("…cannot be cleared once set" for
 * company/property/sourceLead). The only correct shape for "not provided" is to
 * OMIT the field — which is exactly what BLUE's #636 made the deal form do
 * client-side. This enforces the same shape server-side so ANY caller (not just
 * the form) is safe.
 *
 * Scope: blank-string -> omit, for the relationship uuid fields only.
 *   - `null` passes through untouched, so existing clear-semantics are unchanged
 *     (rejected for company/property/sourceLead; allowed for
 *     assignedRep/projectType/region).
 *   - Non-uuid fields are never inspected or modified.
 */

/**
 * The deal-update body fields that map to Postgres `uuid` columns. Kept in sync
 * with UpdateDealInput / the deals schema relationship columns.
 */
export const UUID_DEAL_PATCH_FIELDS = [
  "companyId",
  "propertyId",
  "assignedRepId",
  "primaryContactId",
  "sourceLeadId",
  "projectTypeId",
  "regionId",
] as const;

export type UuidDealPatchField = (typeof UUID_DEAL_PATCH_FIELDS)[number];

function isBlankString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length === 0;
}

/**
 * Remove blank-string values for the relationship uuid fields from `body`
 * (mutates in place). Returns the field names that were stripped, so the caller
 * can observe/log the coercion. Explicit `null` and non-uuid fields are left
 * untouched.
 */
export function stripBlankUuidPatchFields(
  body: Record<string, unknown>
): UuidDealPatchField[] {
  const stripped: UuidDealPatchField[] = [];
  for (const field of UUID_DEAL_PATCH_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(body, field) &&
      isBlankString(body[field])
    ) {
      delete body[field];
      stripped.push(field);
    }
  }
  return stripped;
}
