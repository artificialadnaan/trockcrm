import type { UserRole } from "@trock-crm/shared/types";

/**
 * Who may use the field app at all.
 *
 * Deliberately its OWN module with no runtime imports (the UserRole import is type-only and erased). Both
 * the request middleware and background work need this rule — the middleware gates the enqueue, and a job
 * that runs minutes later has to re-apply it because the account may have been deactivated in between. If
 * the constant lived in field-auth.ts, the worker's dynamic import of the AI-report job would drag the whole
 * auth graph (jwt verification, the user service, the local-auth gate) into a workspace that needs none of
 * it, purely to read five strings.
 */
export const FIELD_APP_ALLOWED_ROLE_SET = new Set<UserRole>([
  "admin",
  "director",
  "rep",
  "construction",
  "field_contractor",
]);
