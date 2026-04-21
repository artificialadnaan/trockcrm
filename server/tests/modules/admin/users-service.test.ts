import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("../../../../server/src/db.js", () => ({
  db: {
    execute: dbMocks.execute,
  },
}));

import { listUsers } from "../../../../server/src/modules/admin/users-service.js";

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
          is_active: true,
          created_at: "2026-04-21T12:00:00.000Z",
        },
        {
          id: "user-2",
          email: "cross@example.com",
          display_name: "Cross Office User",
          role: "rep",
          office_id: "office-3",
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
        isActive: true,
        createdAt: "2026-04-21T12:00:00.000Z",
      },
      {
        id: "user-2",
        email: "cross@example.com",
        displayName: "Cross Office User",
        role: "rep",
        officeId: "office-3",
        isActive: true,
        createdAt: "2026-04-21T12:00:00.000Z",
      },
    ]);
    expect(dbMocks.execute).toHaveBeenCalledOnce();
  });
});
