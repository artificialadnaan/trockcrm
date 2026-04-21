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
}));

vi.mock("../../../../server/src/middleware/auth.js", () => ({
  authMiddleware: mocks.authMiddleware,
}));

vi.mock("../../../../server/src/middleware/rbac.js", () => ({
  requireAdmin: mocks.requireAdmin,
  requireDirector: mocks.requireDirector,
}));

vi.mock("../../../../server/src/db.js", () => ({
  pool: {
    query: vi.fn(),
  },
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
});
