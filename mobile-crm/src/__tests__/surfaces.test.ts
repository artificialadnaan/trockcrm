import { CRM_SURFACES, accessibleSurfaces, canAccessSurface, hasAnyCrmSurface } from "../auth/surfaces";

/**
 * The CRM surface policy, mirroring client/src/components/layout/sidebar.tsx:65-71.
 *
 * The trap this guards: the SERVER's requireCrmUser admits `construction`, so every contacts and deals
 * request from that role SUCCEEDS. The role boundary for these surfaces is client-side on the web too —
 * which means an app that simply renders every screen to every signed-in CRM user is not permissive, it
 * is a hole. A construction user would get the office-wide contact directory (phones, emails, notes,
 * linked deals) and the deals pipeline, neither of which they can reach on the web.
 */
describe("CRM surface policy", () => {
  it.each(["admin", "director", "rep"])("grants %s every current surface", (role) => {
    // Exact list, in SURFACE_ROLES order — the point is that adding a surface is a deliberate act that
    // has to be acknowledged here, not something that quietly widens what a role can reach.
    expect(accessibleSurfaces(role)).toEqual(["deals", "leads", "contacts", "companies"]);
    expect(hasAnyCrmSurface(role)).toBe(true);
  });

  it("grants construction nothing", () => {
    // nav.test.tsx pins the same thing on the web: a construction user sees no Contacts entry, and the
    // sidebar's Deals/Contacts/Companies items are all roles: ["admin","director","rep"].
    expect(accessibleSurfaces("construction")).toEqual([]);
    expect(hasAnyCrmSurface("construction")).toBe(false);
  });

  // DERIVED from CRM_SURFACES, not hand-listed. The hand-written version was missing `leads` — the one
  // surface added since it was written, which is exactly how a per-item list goes quietly incomplete
  // while still passing. A refusal list that does not enumerate itself protects only what it remembers.
  it.each(CRM_SURFACES)("refuses construction the %s surface", (surface) => {
    expect(canAccessSurface("construction", surface)).toBe(false);
  });

  it.each([null, undefined, "", "field_contractor", "sales_manager", "Admin"])(
    "refuses %p",
    (role) => {
      expect(hasAnyCrmSurface(role as string | null)).toBe(false);
    },
  );

  it("derives the no-surface refusal rather than naming a role", () => {
    // If a later phase grants construction a surface, hasAnyCrmSurface stops refusing them with no
    // second place to remember. This asserts the derivation, not the current answer.
    const derived = accessibleSurfaces("construction").length > 0;
    expect(hasAnyCrmSurface("construction")).toBe(derived);
  });
});
