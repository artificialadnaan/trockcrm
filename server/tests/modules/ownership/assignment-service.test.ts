import { describe, expect, it, vi } from "vitest";
import {
  assignCompanyOwnerToSelf,
  assignContactOwnerToSelf,
  reassignCompanyOwner,
  reassignContactOwner,
} from "../../../src/modules/ownership/assignment-service.js";

const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const DIRECTOR_ID = "00000000-0000-4000-8000-000000000002";
const REP_1_ID = "00000000-0000-4000-8000-000000000011";
const REP_2_ID = "00000000-0000-4000-8000-000000000012";
const FIELD_CONTRACTOR_ID = "00000000-0000-4000-8000-000000000021";

function createTenantDb(options: {
  updateRows?: Array<Record<string, unknown>>;
  selectRows?: Array<Array<Record<string, unknown>>>;
}) {
  const updateSets: Array<Record<string, unknown>> = [];
  const selectRows = [...(options.selectRows ?? [])];
  const updateRows = [...(options.updateRows ?? [])];

  return {
    updateSets,
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateSets.push(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => updateRows.shift() ?? []),
          })),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => selectRows.shift() ?? []),
        })),
      })),
    })),
  };
}

describe("company/contact owner assignment", () => {
  it("lets a rep assign an unassigned company to themselves", async () => {
    const tenantDb = createTenantDb({
      updateRows: [[{ id: "company-1", ownerId: REP_1_ID }]],
    });

    const company = await assignCompanyOwnerToSelf(tenantDb as never, "company-1", {
      id: REP_1_ID,
      role: "rep",
    });

    expect(company).toMatchObject({ id: "company-1", ownerId: REP_1_ID });
    expect(tenantDb.updateSets[0]).toMatchObject({ ownerId: REP_1_ID });
  });

  it("rejects rep self-assignment when the company is already owned", async () => {
    const tenantDb = createTenantDb({
      updateRows: [[]],
      selectRows: [[{ id: "company-1", ownerId: REP_2_ID, isActive: true }]],
    });

    await expect(
      assignCompanyOwnerToSelf(tenantDb as never, "company-1", {
        id: REP_1_ID,
        role: "rep",
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not report inactive unassigned records as already owned", async () => {
    const tenantDb = createTenantDb({
      updateRows: [[]],
      selectRows: [[{ id: "company-1", ownerId: null, isActive: false }]],
    });

    await expect(
      assignCompanyOwnerToSelf(tenantDb as never, "company-1", {
        id: REP_1_ID,
        role: "rep",
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lets an admin reassign an owned company and clear it back to unassigned", async () => {
    const assignDb = createTenantDb({
      selectRows: [[{ id: DIRECTOR_ID, isActive: true, role: "director" }]],
      updateRows: [[{ id: "company-1", ownerId: DIRECTOR_ID }]],
    });

    await expect(
      reassignCompanyOwner(assignDb as never, "company-1", DIRECTOR_ID, {
        id: ADMIN_ID,
        role: "admin",
      })
    ).resolves.toMatchObject({ ownerId: DIRECTOR_ID });

    const clearDb = createTenantDb({
      updateRows: [[{ id: "company-1", ownerId: null }]],
    });

    await expect(
      reassignCompanyOwner(clearDb as never, "company-1", null, {
        id: ADMIN_ID,
        role: "admin",
      })
    ).resolves.toMatchObject({ ownerId: null });
  });

  it("rejects reassignment to an active non-CRM user", async () => {
    const tenantDb = createTenantDb({
      selectRows: [[{ id: FIELD_CONTRACTOR_ID, isActive: true, role: "field_contractor" }]],
    });

    await expect(
      reassignCompanyOwner(tenantDb as never, "company-1", FIELD_CONTRACTOR_ID, {
        id: ADMIN_ID,
        role: "admin",
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(tenantDb.update).not.toHaveBeenCalled();
  });

  it("rejects malformed reassignment owner ids before querying users", async () => {
    const companyDb = createTenantDb({});
    await expect(
      reassignCompanyOwner(companyDb as never, "company-1", "not-a-uuid", {
        id: ADMIN_ID,
        role: "admin",
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(companyDb.select).not.toHaveBeenCalled();
    expect(companyDb.update).not.toHaveBeenCalled();

    const contactDb = createTenantDb({});
    await expect(
      reassignContactOwner(contactDb as never, "contact-1", "", {
        id: DIRECTOR_ID,
        role: "director",
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(contactDb.select).not.toHaveBeenCalled();
    expect(contactDb.update).not.toHaveBeenCalled();
  });

  it("rejects rep reassignment to another user", async () => {
    const tenantDb = createTenantDb({});

    await expect(
      reassignCompanyOwner(tenantDb as never, "company-1", REP_2_ID, {
        id: REP_1_ID,
        role: "rep",
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("lets a rep assign an unassigned contact to themselves and blocks already-owned contacts", async () => {
    const assignDb = createTenantDb({
      updateRows: [[{ id: "contact-1", ownerId: REP_1_ID }]],
    });

    await expect(
      assignContactOwnerToSelf(assignDb as never, "contact-1", {
        id: REP_1_ID,
        role: "rep",
      })
    ).resolves.toMatchObject({ ownerId: REP_1_ID });

    const alreadyOwnedDb = createTenantDb({
      updateRows: [[]],
      selectRows: [[{ id: "contact-1", ownerId: REP_2_ID, isActive: true }]],
    });

    await expect(
      assignContactOwnerToSelf(alreadyOwnedDb as never, "contact-1", {
        id: REP_1_ID,
        role: "rep",
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("lets a director reassign contacts but rejects inactive target users", async () => {
    const assignDb = createTenantDb({
      selectRows: [[{ id: REP_2_ID, isActive: true, role: "rep" }]],
      updateRows: [[{ id: "contact-1", ownerId: REP_2_ID }]],
    });

    await expect(
      reassignContactOwner(assignDb as never, "contact-1", REP_2_ID, {
        id: DIRECTOR_ID,
        role: "director",
      })
    ).resolves.toMatchObject({ ownerId: REP_2_ID });

    const inactiveDb = createTenantDb({
      selectRows: [[{ id: REP_2_ID, isActive: false, role: "rep" }]],
    });

    await expect(
      reassignContactOwner(inactiveDb as never, "contact-1", REP_2_ID, {
        id: DIRECTOR_ID,
        role: "director",
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
