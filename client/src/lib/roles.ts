// Role helpers kept OUT of @/lib/auth on purpose: auth.tsx is mocked in ~36 test files (vi.mock
// replaces the whole module), so importing a helper from there would force every one of those mocks
// to re-export it. This module is not mocked, so consumers get the real implementation everywhere.

export type RoleBearer = { role?: string | null; baseRole?: string | null };

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
