import { beforeEach, describe, expect, it, vi } from "vitest";
import { deals, leads, userOfficeAccess, users } from "@trock-crm/shared/schema";

function createTenantDb(state: {
  dealRows?: any[];
  leadRows?: any[];
  officeAccessRows?: any[];
}) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              if (table === deals) return state.dealRows ?? [];
              if (table === leads) return state.leadRows ?? [];
              return [];
            }),
          })),
        })),
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            if (table === userOfficeAccess) return state.officeAccessRows ?? [];
            if (table === users) return [];
            return [];
          }),
        })),
      })),
    })),
  } as any;
}

describe("collaboration access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows cross-office admin owner access when allowAdmin is enabled", async () => {
    const { assertDealOwnerAccess } = await import("../../src/lib/collaboration-access.js");
    const tenantDb = createTenantDb({
      dealRows: [{ id: "deal-1", assignedRepId: "rep-1", sourceLeadId: null, officeCode: "hou", assigneeOfficeId: "office-2" }],
    });

    await expect(
      assertDealOwnerAccess(
        tenantDb,
        "deal-1",
        { id: "admin-1", role: "admin", officeId: "office-1", activeOfficeId: "office-1" },
        { allowAdmin: true }
      )
    ).resolves.toMatchObject({ id: "deal-1" });
  });

  it("allows a non-owner director owner-access when allowDirector is enabled (office-wide, e.g. RFP readiness)", async () => {
    const { assertDealOwnerAccess } = await import("../../src/lib/collaboration-access.js");
    const tenantDb = createTenantDb({
      dealRows: [{ id: "deal-1", assignedRepId: "rep-2", sourceLeadId: null, officeCode: "dal", assigneeOfficeId: "office-1" }],
    });

    await expect(
      assertDealOwnerAccess(
        tenantDb,
        "deal-1",
        { id: "director-1", role: "director", officeId: "office-1", activeOfficeId: "office-1" },
        { allowAdmin: true, allowDirector: true }
      )
    ).resolves.toMatchObject({ id: "deal-1" });
  });

  it("does not extend the director override to a non-owner rep", async () => {
    const { assertDealOwnerAccess } = await import("../../src/lib/collaboration-access.js");
    const tenantDb = createTenantDb({
      dealRows: [{ id: "deal-1", assignedRepId: "rep-2", sourceLeadId: null, officeCode: "dal", assigneeOfficeId: "office-1" }],
    });

    await expect(
      assertDealOwnerAccess(
        tenantDb,
        "deal-1",
        { id: "rep-1", role: "rep", officeId: "office-1", activeOfficeId: "office-1" },
        { allowAdmin: true, allowDirector: true }
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("matches office access by explicit viewer office instead of first-row fallback", async () => {
    const { assertDealCollaboratorAccess } = await import("../../src/lib/collaboration-access.js");
    const tenantDb = createTenantDb({
      dealRows: [{ id: "deal-1", assignedRepId: "rep-1", sourceLeadId: null, officeCode: null, assigneeOfficeId: "office-2" }],
      officeAccessRows: [{ officeId: "office-1" }],
    });

    await expect(
      assertDealCollaboratorAccess(tenantDb, "deal-1", {
        id: "director-1",
        role: "director",
        officeId: "office-1",
        activeOfficeId: "office-1",
      })
    ).resolves.toMatchObject({ id: "deal-1" });
  });

  // office_code is a cosmetic project-number prefix, not an access boundary: a deal/lead stamped with a
  // DIFFERENT prefix than the viewer's office (e.g. a Dallas rep's ATL-prefixed deal) must still be
  // accessible — it lives in the viewer's tenant schema. (Pre-fix the guard 403'd on the prefix mismatch.)
  it("grants collaborator access to a deal whose office_code differs from the viewer's office (cosmetic prefix)", async () => {
    const { assertDealCollaboratorAccess } = await import("../../src/lib/collaboration-access.js");
    const tenantDb = createTenantDb({
      dealRows: [{ id: "deal-1", assignedRepId: "rep-1", sourceLeadId: null, officeCode: "atl", assigneeOfficeId: "office-1" }],
    });

    await expect(
      assertDealCollaboratorAccess(tenantDb, "deal-1", {
        id: "rep-1",
        role: "rep",
        officeId: "office-1",
        activeOfficeId: "office-1",
      })
    ).resolves.toMatchObject({ id: "deal-1" });
  });

  it("grants collaborator access to a lead whose office_code differs from the viewer's office (cosmetic prefix)", async () => {
    const { assertLeadCollaboratorAccess } = await import("../../src/lib/collaboration-access.js");
    const tenantDb = createTenantDb({
      leadRows: [{ id: "lead-1", assignedRepId: "rep-1", officeCode: "atl", assigneeOfficeId: "office-1" }],
    });

    await expect(
      assertLeadCollaboratorAccess(tenantDb, "lead-1", {
        id: "rep-1",
        role: "rep",
        officeId: "office-1",
        activeOfficeId: "office-1",
      })
    ).resolves.toMatchObject({ id: "lead-1" });
  });

  it("denies collaborator access only when the viewer has no office at all", async () => {
    const { assertDealCollaboratorAccess } = await import("../../src/lib/collaboration-access.js");
    const tenantDb = createTenantDb({
      dealRows: [{ id: "deal-1", assignedRepId: "rep-1", sourceLeadId: null, officeCode: "dfw", assigneeOfficeId: "office-1" }],
    });

    await expect(
      assertDealCollaboratorAccess(tenantDb, "deal-1", {
        id: "rep-1",
        role: "rep",
        officeId: null,
        activeOfficeId: null,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("keeps legacy unassigned records accessible within the tenant schema", async () => {
    const { assertLeadCollaboratorAccess } = await import("../../src/lib/collaboration-access.js");
    const tenantDb = createTenantDb({
      leadRows: [{ id: "lead-1", assignedRepId: null, officeCode: null, assigneeOfficeId: null }],
    });

    await expect(
      assertLeadCollaboratorAccess(tenantDb, "lead-1", {
        id: "director-1",
        role: "director",
        officeId: "office-1",
        activeOfficeId: "office-1",
      })
    ).resolves.toMatchObject({ id: "lead-1" });
  });
});
