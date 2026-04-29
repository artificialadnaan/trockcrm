import { describe, expect, it } from "vitest";

const {
  buildUserCleanupPlan,
  detectEmailConventionCollisions,
  inferCrmRole,
  resolveOfficeSlug,
} = await import("../../../scripts/reconcileUsers.js");

describe("user reconciliation planning", () => {
  it("maps org titles to CRM roles and office schemas conservatively", () => {
    expect(inferCrmRole("CEO")).toBe("admin");
    expect(inferCrmRole("CFO")).toBe("admin");
    expect(inferCrmRole("Director of Sales")).toBe("director");
    expect(inferCrmRole("VP of Construction")).toBe("director");
    expect(inferCrmRole("Project Manager")).toBe("rep");
    expect(resolveOfficeSlug("dfw")).toBe("dallas");
  });

  it("detects first-initial-last-name email collisions even when one address is suffixed", () => {
    const collisions = detectEmailConventionCollisions([
      { name: "Tristan Mitchell", email: "tmitchell@trockgc.com", role: "Superintendent", officeCode: "dfw", manager: "awinters@trockgc.com" },
      { name: "Tim Mitchell", email: "tmitchell2@trockgc.com", role: "VP Client Services", officeCode: "dfw", manager: "ashaw@trockgc.com" },
      { name: "Adam Shaw", email: "ashaw@trockgc.com", role: "CEO", officeCode: "dfw", manager: null },
    ]);

    expect(collisions).toEqual([
      {
        conventionKey: "tmitchell",
        users: ["Tim Mitchell <tmitchell2@trockgc.com>", "Tristan Mitchell <tmitchell@trockgc.com>"],
      },
    ]);
  });

  it("plans creates, soft-deletes, manager updates, and reassignment targets", () => {
    const plan = buildUserCleanupPlan({
      orgUsers: [
        { name: "Adam Shaw", email: "ashaw@trockgc.com", role: "CEO", officeCode: "dfw", manager: null },
        { name: "Derek Barr", email: "dbarr@trockgc.com", role: "Director of Sales", officeCode: "dfw", manager: "ashaw@trockgc.com" },
        { name: "Kevin Scott", email: "kscott@trockgc.com", role: "National Account Manager", officeCode: "dfw", manager: "dbarr@trockgc.com" },
      ],
      dbUsers: [
        { id: "u-adam", email: "ashaw@trockgc.com", displayName: "Adam Shaw", role: "admin", officeSlug: "dallas", reportsTo: "u-old", isActive: true },
        { id: "u-derek", email: "dbarr@trockgc.com", displayName: "Derek Barr", role: "rep", officeSlug: "dallas", reportsTo: null, isActive: true },
        { id: "u-old", email: "old@trockgc.com", displayName: "Old User", role: "rep", officeSlug: "dallas", reportsTo: "u-adam", isActive: true },
      ],
      ownershipCountsByUserId: new Map([
        ["u-old", { deals: 2, leads: 1, tasks: 3 }],
      ]),
    });

    expect(plan.wouldCreate.map((row: any) => row.email)).toEqual(["kscott@trockgc.com"]);
    expect(plan.wouldSoftDelete.map((row: any) => row.email)).toEqual(["old@trockgc.com"]);
    expect(plan.managerMismatches).toEqual([
      { email: "ashaw@trockgc.com", currentManagerEmail: "old@trockgc.com", nextManagerEmail: null, status: "would_update" },
      { email: "dbarr@trockgc.com", currentManagerEmail: null, nextManagerEmail: "ashaw@trockgc.com", status: "would_update" },
      { email: "kscott@trockgc.com", currentManagerEmail: null, nextManagerEmail: "dbarr@trockgc.com", status: "blocked_user_missing" },
    ]);
    expect(plan.reassignmentPlan).toEqual([
      {
        email: "old@trockgc.com",
        displayName: "Old User",
        reassignToEmail: "ashaw@trockgc.com",
        deals: 2,
        leads: 1,
        tasks: 3,
      },
    ]);
  });
});
