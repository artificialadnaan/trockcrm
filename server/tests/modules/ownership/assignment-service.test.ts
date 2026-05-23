import { beforeEach, describe, expect, it, vi } from "vitest";

const listUsersMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/modules/admin/users-service.js", () => ({
  listUsers: listUsersMock,
}));

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
const UUID_V7_OWNER_ID = "00000000-0000-7000-8000-000000000022";
const UUID_V7_COMPANY_ID = "00000000-0000-7000-8000-000000000101";
const OFFICE_ID = "00000000-0000-4000-8000-0000000000aa";
const COMPANY_ID = "00000000-0000-4000-8000-000000000101";
const CONTACT_ID = "00000000-0000-4000-8000-000000000201";

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
  beforeEach(() => {
    listUsersMock.mockReset();
    listUsersMock.mockResolvedValue([
      { id: ADMIN_ID, displayName: "Admin User", isActive: true },
      { id: DIRECTOR_ID, displayName: "Director User", isActive: true },
      { id: REP_1_ID, displayName: "Rep One", isActive: true },
      { id: REP_2_ID, displayName: "Rep Two", isActive: true },
      { id: UUID_V7_OWNER_ID, displayName: "Version Seven", isActive: true },
    ]);
  });

  it("lets a rep assign an unassigned company to themselves", async () => {
    const tenantDb = createTenantDb({
      updateRows: [[{ id: COMPANY_ID, ownerId: REP_1_ID }]],
    });

    const company = await assignCompanyOwnerToSelf(tenantDb as never, COMPANY_ID, {
      id: REP_1_ID,
      role: "rep",
    });

    expect(company).toMatchObject({ id: COMPANY_ID, ownerId: REP_1_ID });
    expect(tenantDb.updateSets[0]).toMatchObject({ ownerId: REP_1_ID });
  });

  it("rejects rep self-assignment when the company is already owned", async () => {
    const tenantDb = createTenantDb({
      updateRows: [[]],
      selectRows: [[{ id: COMPANY_ID, ownerId: REP_2_ID, isActive: true }]],
    });

    await expect(
      assignCompanyOwnerToSelf(tenantDb as never, COMPANY_ID, {
        id: REP_1_ID,
        role: "rep",
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not report inactive unassigned records as already owned", async () => {
    const tenantDb = createTenantDb({
      updateRows: [[]],
      selectRows: [[{ id: COMPANY_ID, ownerId: null, isActive: false }]],
    });

    await expect(
      assignCompanyOwnerToSelf(tenantDb as never, COMPANY_ID, {
        id: REP_1_ID,
        role: "rep",
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lets an admin reassign an owned company and clear it back to unassigned", async () => {
    const assignDb = createTenantDb({
      selectRows: [[{ id: DIRECTOR_ID, isActive: true, role: "director" }]],
      updateRows: [[{ id: COMPANY_ID, ownerId: DIRECTOR_ID }]],
    });

    await expect(
      reassignCompanyOwner(assignDb as never, COMPANY_ID, DIRECTOR_ID, {
        id: ADMIN_ID,
        role: "admin",
        activeOfficeId: OFFICE_ID,
      })
    ).resolves.toMatchObject({ ownerId: DIRECTOR_ID });

    const clearDb = createTenantDb({
      updateRows: [[{ id: COMPANY_ID, ownerId: null }]],
    });

    await expect(
      reassignCompanyOwner(clearDb as never, COMPANY_ID, null, {
        id: ADMIN_ID,
        role: "admin",
        activeOfficeId: OFFICE_ID,
      })
    ).resolves.toMatchObject({ ownerId: null });
  });

  it("rejects reassignment to a CRM user outside the current office assignee set", async () => {
    listUsersMock.mockResolvedValue([{ id: REP_1_ID, displayName: "Rep One", isActive: true }]);
    const tenantDb = createTenantDb({
      selectRows: [[{ id: REP_2_ID, isActive: true, role: "rep" }]],
      updateRows: [[{ id: COMPANY_ID, ownerId: REP_2_ID }]],
    });

    await expect(
      reassignCompanyOwner(tenantDb as never, COMPANY_ID, REP_2_ID, {
        id: ADMIN_ID,
        role: "admin",
        activeOfficeId: OFFICE_ID,
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(listUsersMock).toHaveBeenCalledWith(OFFICE_ID);
    expect(tenantDb.update).not.toHaveBeenCalled();
  });

  it("accepts a valid active CRM owner in the current office assignee set", async () => {
    const tenantDb = createTenantDb({
      selectRows: [[{ id: REP_2_ID, isActive: true, role: "rep" }]],
      updateRows: [[{ id: COMPANY_ID, ownerId: REP_2_ID }]],
    });

    await expect(
      reassignCompanyOwner(tenantDb as never, COMPANY_ID, REP_2_ID, {
        id: ADMIN_ID,
        role: "admin",
        activeOfficeId: OFFICE_ID,
      })
    ).resolves.toMatchObject({ ownerId: REP_2_ID });

    expect(listUsersMock).toHaveBeenCalledWith(OFFICE_ID);
  });

  it("rejects reassignment to an active non-CRM user", async () => {
    const tenantDb = createTenantDb({
      selectRows: [[{ id: FIELD_CONTRACTOR_ID, isActive: true, role: "field_contractor" }]],
    });

    await expect(
      reassignCompanyOwner(tenantDb as never, COMPANY_ID, FIELD_CONTRACTOR_ID, {
        id: ADMIN_ID,
        role: "admin",
        activeOfficeId: OFFICE_ID,
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(tenantDb.update).not.toHaveBeenCalled();
  });

  it("rejects malformed reassignment owner ids before querying users", async () => {
    const companyDb = createTenantDb({});
    await expect(
      reassignCompanyOwner(companyDb as never, COMPANY_ID, "not-a-uuid", {
        id: ADMIN_ID,
        role: "admin",
        activeOfficeId: OFFICE_ID,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(companyDb.select).not.toHaveBeenCalled();
    expect(companyDb.update).not.toHaveBeenCalled();

    const contactDb = createTenantDb({});
    await expect(
      reassignContactOwner(contactDb as never, CONTACT_ID, "", {
        id: DIRECTOR_ID,
        role: "director",
        activeOfficeId: OFFICE_ID,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(contactDb.select).not.toHaveBeenCalled();
    expect(contactDb.update).not.toHaveBeenCalled();
  });

  it("rejects rep reassignment to another user", async () => {
    const tenantDb = createTenantDb({});

    await expect(
      reassignCompanyOwner(tenantDb as never, COMPANY_ID, REP_2_ID, {
        id: REP_1_ID,
        role: "rep",
        activeOfficeId: OFFICE_ID,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("lets a rep assign an unassigned contact to themselves and blocks already-owned contacts", async () => {
    const assignDb = createTenantDb({
      updateRows: [[{ id: CONTACT_ID, ownerId: REP_1_ID }]],
    });

    await expect(
      assignContactOwnerToSelf(assignDb as never, CONTACT_ID, {
        id: REP_1_ID,
        role: "rep",
      })
    ).resolves.toMatchObject({ ownerId: REP_1_ID });

    const alreadyOwnedDb = createTenantDb({
      updateRows: [[]],
      selectRows: [[{ id: CONTACT_ID, ownerId: REP_2_ID, isActive: true }]],
    });

    await expect(
      assignContactOwnerToSelf(alreadyOwnedDb as never, CONTACT_ID, {
        id: REP_1_ID,
        role: "rep",
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("lets a director reassign contacts but rejects inactive target users", async () => {
    const assignDb = createTenantDb({
      selectRows: [[{ id: REP_2_ID, isActive: true, role: "rep" }]],
      updateRows: [[{ id: CONTACT_ID, ownerId: REP_2_ID }]],
    });

    await expect(
      reassignContactOwner(assignDb as never, CONTACT_ID, REP_2_ID, {
        id: DIRECTOR_ID,
        role: "director",
        activeOfficeId: OFFICE_ID,
      })
    ).resolves.toMatchObject({ ownerId: REP_2_ID });

    const inactiveDb = createTenantDb({
      selectRows: [[{ id: REP_2_ID, isActive: false, role: "rep" }]],
    });

    await expect(
      reassignContactOwner(inactiveDb as never, CONTACT_ID, REP_2_ID, {
        id: DIRECTOR_ID,
        role: "director",
        activeOfficeId: OFFICE_ID,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects malformed record ids before touching UUID columns", async () => {
    const companyAssignDb = createTenantDb({
      updateRows: [[{ id: "not-a-uuid", ownerId: REP_1_ID }]],
    });
    await expect(
      assignCompanyOwnerToSelf(companyAssignDb as never, "not-a-uuid", {
        id: REP_1_ID,
        role: "rep",
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(companyAssignDb.update).not.toHaveBeenCalled();

    const companyReassignDb = createTenantDb({
      updateRows: [[{ id: "not-a-uuid", ownerId: null }]],
    });
    await expect(
      reassignCompanyOwner(companyReassignDb as never, "not-a-uuid", null, {
        id: ADMIN_ID,
        role: "admin",
        activeOfficeId: OFFICE_ID,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(companyReassignDb.update).not.toHaveBeenCalled();
  });

  it("accepts version-agnostic UUIDs for owner and record ids", async () => {
    const tenantDb = createTenantDb({
      selectRows: [[{ id: UUID_V7_OWNER_ID, isActive: true, role: "rep" }]],
      updateRows: [[{ id: UUID_V7_COMPANY_ID, ownerId: UUID_V7_OWNER_ID }]],
    });

    await expect(
      reassignCompanyOwner(tenantDb as never, UUID_V7_COMPANY_ID, UUID_V7_OWNER_ID, {
        id: ADMIN_ID,
        role: "admin",
        activeOfficeId: OFFICE_ID,
      })
    ).resolves.toMatchObject({ id: UUID_V7_COMPANY_ID, ownerId: UUID_V7_OWNER_ID });
  });
});
