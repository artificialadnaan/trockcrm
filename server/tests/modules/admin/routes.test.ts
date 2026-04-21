import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.user = {
      id: "admin-1",
      email: "admin@trock.dev",
      displayName: "Admin User",
      role: "admin",
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    next();
  }),
  requireAdmin: vi.fn((_req: any, _res: any, next: any) => next()),
  requireDirector: vi.fn((_req: any, _res: any, next: any) => next()),
  runOwnershipSync: vi.fn(),
  getAccessibleOffices: vi.fn(),
  getMyCleanupQueue: vi.fn(),
  getOfficeOwnershipQueue: vi.fn(),
  bulkReassignOwnershipQueueRows: vi.fn(),
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  drizzle: vi.fn(),
  tenantClient: {
    query: vi.fn(),
    release: vi.fn(),
  },
}));

vi.mock("../../../../server/src/middleware/auth.js", () => ({
  authMiddleware: mocks.authMiddleware,
}));

vi.mock("../../../../server/src/middleware/rbac.js", () => ({
  requireAdmin: mocks.requireAdmin,
  requireDirector: mocks.requireDirector,
}));

vi.mock("../../../../server/src/modules/auth/service.js", () => ({
  getAccessibleOffices: mocks.getAccessibleOffices,
}));

vi.mock("../../../../server/src/db.js", () => ({
  pool: {
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  },
}));

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: mocks.drizzle,
}));

vi.mock("../../../../server/src/modules/admin/offices-service.js", () => ({
  listOffices: vi.fn(),
  getOfficeById: vi.fn(),
  createOffice: vi.fn(),
  updateOffice: vi.fn(),
}));

vi.mock("../../../../server/src/modules/admin/users-service.js", () => ({
  getUsersWithStats: vi.fn(),
  getUserById: vi.fn(),
  updateUser: vi.fn(),
  grantOfficeAccess: vi.fn(),
  revokeOfficeAccess: vi.fn(),
}));

vi.mock("../../../../server/src/modules/admin/ownership-sync-service.js", () => ({
  runOwnershipSync: mocks.runOwnershipSync,
}));

vi.mock("../../../../server/src/modules/admin/cleanup-queue-service.js", () => ({
  getMyCleanupQueue: mocks.getMyCleanupQueue,
  getOfficeOwnershipQueue: mocks.getOfficeOwnershipQueue,
  bulkReassignOwnershipQueueRows: mocks.bulkReassignOwnershipQueueRows,
}));

vi.mock("../../../../server/src/modules/admin/pipeline-service.js", () => ({
  listPipelineStages: vi.fn(),
  updatePipelineStage: vi.fn(),
  reorderPipelineStages: vi.fn(),
}));

vi.mock("../../../../server/src/modules/admin/audit-service.js", () => ({
  getAuditLog: vi.fn(),
  getAuditLogTables: vi.fn(),
}));

import { adminRoutes } from "../../../../server/src/modules/admin/routes.js";

describe("admin ownership sync routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poolConnect.mockResolvedValue(mocks.tenantClient);
    mocks.drizzle.mockReturnValue({ execute: vi.fn() });
    mocks.tenantClient.query.mockResolvedValue({ rows: [] });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", adminRoutes);
    return app;
  }

  it("wires /admin/ownership-sync/dry-run through the router and passes dryRun=true", async () => {
    mocks.runOwnershipSync.mockResolvedValue({
      assigned: 0,
      unchanged: 0,
      unmatched: 0,
      conflicts: 0,
      inactiveUserConflicts: 0,
      examples: { matched: [], unmatched: [], conflicts: [], inactiveUserConflicts: [] },
    });

    const response = await request(buildApp()).post("/api/admin/ownership-sync/dry-run");

    expect(response.status).toBe(200);
    expect(mocks.authMiddleware).toHaveBeenCalledOnce();
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.runOwnershipSync).toHaveBeenCalledWith({ dryRun: true });
  });

  it("wires /admin/ownership-sync/apply through the router and passes dryRun=false", async () => {
    mocks.runOwnershipSync.mockResolvedValue({
      assigned: 1,
      unchanged: 0,
      unmatched: 0,
      conflicts: 0,
      inactiveUserConflicts: 0,
      examples: { matched: [], unmatched: [], conflicts: [], inactiveUserConflicts: [] },
    });

    const response = await request(buildApp()).post("/api/admin/ownership-sync/apply");

    expect(response.status).toBe(200);
    expect(mocks.authMiddleware).toHaveBeenCalledOnce();
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.runOwnershipSync).toHaveBeenCalledWith({ dryRun: false });
  });

  it("routes /admin/cleanup/office through a cross-office selection without a role override", async () => {
    mocks.getAccessibleOffices.mockResolvedValue([
      { id: "office-1", name: "Office One", slug: "office-one" },
      { id: "office-2", name: "Office Two", slug: "office-two" },
    ]);
    mocks.getOfficeOwnershipQueue.mockResolvedValue({
      rows: [{ recordId: "deal-1" }],
      byReason: [],
    });

    const response = await request(buildApp()).get("/api/admin/cleanup/office?officeId=office-2");

    expect(response.status).toBe(200);
    expect(mocks.getAccessibleOffices).toHaveBeenCalledWith("admin-1", "admin", "office-1");
    expect(mocks.getOfficeOwnershipQueue).toHaveBeenCalledOnce();
    expect(mocks.getOfficeOwnershipQueue).toHaveBeenCalledWith(expect.anything(), "office-2", expect.any(Object));
  });

  it("routes /admin/cleanup/my through tenant auth wiring and returns rows", async () => {
    mocks.tenantClient.query.mockImplementation(async (query: string) => {
      if (query.includes("SELECT slug FROM public.offices")) {
        return { rows: [{ slug: "office-one" }] };
      }
      if (query.includes("information_schema.schemata")) {
        return { rows: [{ schema_name: "office_office-one" }] };
      }
      return { rows: [] };
    });
    mocks.getMyCleanupQueue.mockResolvedValue({
      rows: [
        {
          recordId: "deal-1",
          recordType: "deal",
          recordName: "Queued Deal",
        },
      ],
      byReason: [],
    });

    const response = await request(buildApp()).get("/api/admin/cleanup/my");

    expect(response.status).toBe(200);
    expect(mocks.authMiddleware).toHaveBeenCalledOnce();
    expect(mocks.poolConnect).toHaveBeenCalledOnce();
    expect(mocks.drizzle).toHaveBeenCalledOnce();
    expect(mocks.getMyCleanupQueue).toHaveBeenCalledWith(expect.anything(), "admin-1", "office-1");
    expect(response.body).toEqual({
      rows: [
        {
          recordId: "deal-1",
          recordType: "deal",
          recordName: "Queued Deal",
        },
      ],
    });
  });

  it("routes /admin/cleanup/reassign through a cross-office selection without a role override", async () => {
    mocks.getAccessibleOffices.mockResolvedValue([
      { id: "office-1", name: "Office One", slug: "office-one" },
      { id: "office-2", name: "Office Two", slug: "office-two" },
    ]);
    mocks.bulkReassignOwnershipQueueRows.mockResolvedValue({ updated: 1 });

    const response = await request(buildApp())
      .post("/api/admin/cleanup/reassign")
      .send({
        officeId: "office-2",
        assigneeId: "rep-1",
      rows: [{ recordType: "deal", recordId: "deal-1" }],
    });

    expect(response.status).toBe(200);
    expect(mocks.getAccessibleOffices).toHaveBeenCalledWith("admin-1", "admin", "office-1");
    expect(mocks.bulkReassignOwnershipQueueRows).toHaveBeenCalledOnce();
    expect(mocks.bulkReassignOwnershipQueueRows).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Object),
      expect.objectContaining({ officeId: "office-2", assigneeId: "rep-1" })
    );
  });
});
