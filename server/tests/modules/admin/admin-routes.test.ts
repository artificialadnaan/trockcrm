import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.user = {
      id: "user-1",
      email: "admin@trock.dev",
      displayName: "Admin User",
      role: "admin",
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    next();
  }),
  requireDirector: vi.fn((_req: any, _res: any, next: any) => next()),
  tenantMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.tenantDb = {};
    req.commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  }),
}));

vi.mock("../../../src/middleware/auth.js", () => ({
  authMiddleware: mocks.authMiddleware,
}));

vi.mock("../../../src/middleware/rbac.js", () => ({
  requireAdmin: vi.fn((_req: any, _res: any, next: any) => next()),
  requireDirector: mocks.requireDirector,
}));

vi.mock("../../../src/middleware/tenant.js", () => ({
  tenantMiddleware: mocks.tenantMiddleware,
}));

vi.mock("../../../src/modules/admin/admin-reporting-service.js", () => ({
  getAdminDataScrubOverview: vi.fn().mockResolvedValue({
    summary: {
      openDuplicateContacts: 1,
      resolvedDuplicateContacts7d: 1,
      openOwnershipGaps: 2,
      recentScrubActions7d: 3,
    },
    backlogBuckets: [],
    ownershipCoverage: [],
    scrubActivityByUser: [],
  }),
}));

import { adminRoutes } from "../../../src/modules/admin/routes.js";

describe("admin data scrub routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the admin data scrub overview on the admin route family", async () => {
    const app = express();
    app.use("/api", adminRoutes);

    const response = await request(app).get("/api/admin/data-scrub/overview");

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({
      openDuplicateContacts: 1,
      resolvedDuplicateContacts7d: 1,
      openOwnershipGaps: 2,
      recentScrubActions7d: 3,
    });
    expect(mocks.authMiddleware).toHaveBeenCalledOnce();
    expect(mocks.requireDirector).toHaveBeenCalledOnce();
    expect(mocks.tenantMiddleware).toHaveBeenCalledOnce();
  });
});
