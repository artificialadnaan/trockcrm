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

import { listUsers, updateUser } from "../../../../server/src/modules/admin/users-service.js";

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
});
