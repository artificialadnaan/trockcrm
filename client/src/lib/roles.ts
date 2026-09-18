// Role helpers kept OUT of @/lib/auth on purpose: auth.tsx is mocked in ~36 test files (vi.mock
// replaces the whole module), so importing a helper from there would force every one of those mocks
// to re-export it. This module is not mocked, so consumers get the real implementation everywhere.

export type RoleBearer = { role?: string | null; baseRole?: string | null };

/**
 * The roles that may open a CRM report workspace: everyone who reads reports at all.
 *
 * Exported as ONE list because the report index and the routes it links to have to agree. When they are
 * written out separately they drift, and the failure is silent in both directions — a card that redirects
 * the instant it is clicked, or a route with no gate under a card that has one. Both happened here: QC
 * Reports was listed for `construction` users its route rejects, and Sales Review was listed AND ungated,
 * so those users were served team-wide sales data instead of being turned away.
 *
 * `construction` and `field_contractor` are the roles this excludes. Reports are a sales-side surface;
 * field roles reach their own through T-Rock Cam and the field module.
 */
export const REPORT_VIEWER_ROLES = ["admin", "director", "rep"] as const;

/**
 * Whether the user is a GLOBAL admin — matches the server's base-role gate for user-provisioning
 * pages (requireGlobalAdmin). Uses the HOME role (`baseRole`), falling back to the effective `role`
 * when baseRole isn't present yet (right after login, where effective role == base role anyway), so
 * an office-scoped admin override can never read as a global admin client-side.
 */
export function isGlobalAdmin(user: RoleBearer | null | undefined): boolean {
  if (!user) return false;
  return (user.baseRole ?? user.role) === "admin";
}
