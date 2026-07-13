/**
 * Hard allowlist of the tenant database schemas an MCP session may be bound to.
 *
 * SECURITY: This is a *static* allowlist on purpose. The whole point of the scoped
 * session token is that a chat session is cryptographically pinned to ONE office
 * schema, so the model can never reach another tenant's data. The `office` value
 * is therefore matched against this fixed set and used only to *select* a
 * whitelisted schema downstream — it is NEVER interpolated into SQL. Even if the
 * database, the offices table, or a token mint site were tampered with, an office
 * value outside this set cannot pass validation.
 *
 * Keep this in sync with the provisioned tenant schemas (`office_<slug>`).
 */
export const KNOWN_OFFICE_SCHEMAS = [
  "office_dallas",
  "office_atlanta",
  "office_pwauditoffice",
] as const;

export type OfficeSchema = (typeof KNOWN_OFFICE_SCHEMAS)[number];

/**
 * Type guard: is `value` one of the known, allowlisted office schemas?
 *
 * Case-sensitive and exact — no trimming, no normalisation. A value that is not
 * an exact member of {@link KNOWN_OFFICE_SCHEMAS} is rejected.
 */
export function isKnownOfficeSchema(value: unknown): value is OfficeSchema {
  return (
    typeof value === "string" &&
    (KNOWN_OFFICE_SCHEMAS as readonly string[]).includes(value)
  );
}
