/**
 * Which roles may reach which CRM surface.
 *
 * Mirrors the web sidebar's per-item `roles` (client/src/components/layout/sidebar.tsx:65-71), which is
 * the established policy and is pinned there by nav.test.tsx — including the explicit assertion that a
 * `construction` user sees no Contacts entry.
 *
 * WHY THIS EXISTS AT ALL: `requireCrmUser` on the server admits `construction`, so these requests
 * SUCCEED. The role boundary for CRM surfaces is a client-side policy on the web too, which means an app
 * that merely renders every screen to every signed-in CRM user is not "permissive" — it is a hole. A
 * construction user would get the office-wide contact directory (phones, emails, notes, linked deals)
 * and the deals pipeline, neither of which they can see on the web.
 *
 * Kept as DATA rather than scattered `role === "rep"` checks so the policy is one table to compare
 * against the sidebar, and so granting a surface later is a one-line change in a single place.
 */
export type CrmSurface = "deals" | "contacts" | "companies";

const SURFACE_ROLES: Record<CrmSurface, readonly string[]> = {
  deals: ["admin", "director", "rep"],
  contacts: ["admin", "director", "rep"],
  companies: ["admin", "director", "rep"],
};

export const CRM_SURFACES = Object.keys(SURFACE_ROLES) as CrmSurface[];

export function canAccessSurface(role: string | null | undefined, surface: CrmSurface): boolean {
  return typeof role === "string" && SURFACE_ROLES[surface].includes(role);
}

export function accessibleSurfaces(role: string | null | undefined): CrmSurface[] {
  return CRM_SURFACES.filter((surface) => canAccessSurface(role, surface));
}

/**
 * Does this role have anything to do in the app at all?
 *
 * DERIVED, never hardcoded to a role name. Today `construction` passes the server's CRM boundary but
 * reaches zero surfaces, so signing in would land them in an app with every screen hidden — worse than a
 * clear message at the door. When a later phase grants construction a surface, this stops refusing them
 * automatically, with no second place to remember to update.
 */
export function hasAnyCrmSurface(role: string | null | undefined): boolean {
  return accessibleSurfaces(role).length > 0;
}
