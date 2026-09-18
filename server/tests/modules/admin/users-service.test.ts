import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../../../../server/src/db.js", () => ({
  db: {
    execute: dbMocks.execute,
    select: dbMocks.select,
    update: dbMocks.update,
    insert: dbMocks.insert,
    transaction: dbMocks.transaction,
  },
}));

import { getUsersWithStats, listUsers, updateUser } from "../../../../server/src/modules/admin/users-service.js";

function createSelectChain(result: unknown) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(result),
      })),
    })),
  };
}

function createUpdateChain(result: unknown) {
  return {
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue(result),
      })),
    })),
  };
}

describe("listUsers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes users with explicit access to the requested office", async () => {
    dbMocks.execute.mockResolvedValueOnce({
      rows: [
        {
          id: "user-1",
          email: "primary@example.com",
          display_name: "Primary User",
          role: "director",
          office_id: "office-1",
          reports_to: "manager-1",
          is_active: true,
          created_at: "2026-04-21T12:00:00.000Z",
        },
        {
          id: "user-2",
          email: "cross@example.com",
          display_name: "Cross Office User",
          role: "rep",
          office_id: "office-3",
          reports_to: null,
          is_active: true,
          created_at: "2026-04-21T12:00:00.000Z",
        },
      ],
    });

    const users = await listUsers("office-1");

    expect(users).toEqual([
      {
        id: "user-1",
        email: "primary@example.com",
        displayName: "Primary User",
        role: "director",
        officeId: "office-1",
        reportsTo: "manager-1",
        isActive: true,
        createdAt: "2026-04-21T12:00:00.000Z",
      },
      {
        id: "user-2",
        email: "cross@example.com",
        displayName: "Cross Office User",
        role: "rep",
        officeId: "office-3",
        reportsTo: null,
        isActive: true,
        createdAt: "2026-04-21T12:00:00.000Z",
      },
    ]);
    expect(dbMocks.execute).toHaveBeenCalledOnce();
  });

  it("wraps user updates in a transaction", async () => {
    const existingUser = {
      id: "user-1",
      email: "rep@example.com",
      displayName: "Existing Rep",
      role: "rep",
      officeId: "office-1",
      reportsTo: null,
      isActive: true,
      notificationPrefs: {},
      createdAt: "2026-04-21T12:00:00.000Z",
      updatedAt: "2026-04-21T12:00:00.000Z",
    };

    const updatedUser = {
      ...existingUser,
      displayName: "Updated Rep",
    };

    const tx = {
      select: vi.fn().mockImplementationOnce(() => createSelectChain([existingUser])),
      update: vi.fn().mockImplementationOnce(() => createUpdateChain([updatedUser])),
      insert: vi.fn(),
    };

    dbMocks.transaction.mockImplementationOnce(async (callback: (trx: typeof tx) => Promise<unknown>) => callback(tx));
    dbMocks.select.mockImplementationOnce(() => createSelectChain([existingUser]));
    dbMocks.update.mockImplementationOnce(() => createUpdateChain([updatedUser]));

    const result = await updateUser("user-1", {
      displayName: "Updated Rep",
    });

    expect(result).toEqual(updatedUser);
    expect(dbMocks.transaction).toHaveBeenCalledOnce();
    expect(tx.select).toHaveBeenCalledOnce();
    expect(tx.update).toHaveBeenCalledOnce();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("refuses a role change into field_contractor before any flag guard can matter (Codex #1067 P2)", async () => {
    // Codex suggested re-running the roster-flag guards on a role-only PATCH, on the theory that
    // `PATCH { role: "field_contractor" }` skips them and strands estimates_jobs=true on a contractor.
    // That transition never lands: evaluateUpdateUserGuards 403s ANY move into or out of field_contractor
    // (isFieldContractorTransition), because contractors are managed by the field-invite flow. This test
    // pins the guard that makes a re-validation block unnecessary — if this 403 is ever relaxed, the flag
    // invariant needs a role-change arm and this test is where that will surface.
    const existingEstimator = {
      id: "user-2",
      email: "estimator@example.com",
      displayName: "Sidney Gibson",
      role: "rep",
      officeId: "office-1",
      reportsTo: null,
      isActive: true,
      generatesSales: false,
      estimatesJobs: true,
      notificationPrefs: {},
      createdAt: "2026-04-21T12:00:00.000Z",
      updatedAt: "2026-04-21T12:00:00.000Z",
    };

    const tx = {
      select: vi.fn().mockImplementationOnce(() => createSelectChain([existingEstimator])),
      update: vi.fn(),
      insert: vi.fn(),
    };
    dbMocks.transaction.mockImplementationOnce(async (callback: (trx: typeof tx) => Promise<unknown>) => callback(tx));

    await expect(updateUser("user-2", { role: "field_contractor" }, "admin-1")).rejects.toThrow(
      /Field contractors are managed in the field-user flow/
    );
    expect(tx.update).not.toHaveBeenCalled();
  });
});

describe("getUsersWithStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps a user's base role while exposing their effective role in the selected office", async () => {
    // The global Users table must keep showing the home role, but the notification-recipient picker lives
    // in an active office and needs the grant override. If the SQL stops selecting/mapping effective_role,
    // a base rep with an admin grant becomes impossible to assign again.
    dbMocks.execute.mockResolvedValueOnce({
      rows: [
        {
          id: "override-user",
          email: "override@example.com",
          display_name: "Override User",
          role: "rep",
          effective_role: "admin",
          office_id: "office-home",
          reports_to: null,
          is_active: true,
          generates_sales: false,
          estimates_jobs: false,
          office_name: "Home",
          extra_office_count: 1,
        },
      ],
    });
    // Earlier updateUser tests deliberately queue select implementations. clearAllMocks preserves that
    // queue, so reset this one before making the three independent lookup reads below.
    dbMocks.select.mockReset();
    dbMocks.select.mockImplementation(() => ({ from: vi.fn().mockResolvedValue([]) }));

    const result = await getUsersWithStats("office-active");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "override-user",
      role: "rep",
      effectiveRole: "admin",
      officeId: "office-home",
    });
    expect(dbMocks.execute).toHaveBeenCalledOnce();
  });
});
