import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.user = {
      id: "user-1",
      email: "director@trock.dev",
      displayName: "Director User",
      role: "director",
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    next();
  }),
  requireAdmin: vi.fn((_req: any, res: any, _next: any) => {
    res.status(403).json({ error: { message: "Requires one of: admin" } });
  }),
}));

vi.mock("../../../src/middleware/auth.js", () => ({
  authMiddleware: mocks.authMiddleware,
}));

vi.mock("../../../src/middleware/rbac.js", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("../../../src/modules/migration/service.js", () => ({
  getMigrationSummary: vi.fn(),
  getMigrationExceptions: vi.fn(),
  getImportRuns: vi.fn(),
  createImportRun: vi.fn(),
  completeImportRun: vi.fn(),
  listStagedCompanies: vi.fn(),
  approveStagedCompany: vi.fn(),
  rejectStagedCompany: vi.fn(),
  listStagedProperties: vi.fn(),
  approveStagedProperty: vi.fn(),
  rejectStagedProperty: vi.fn(),
  listStagedLeads: vi.fn(),
  approveStagedLead: vi.fn(),
  rejectStagedLead: vi.fn(),
  listStagedDeals: vi.fn(),
  approveStagedDeal: vi.fn(),
  rejectStagedDeal: vi.fn(),
  batchApproveStagedDeals: vi.fn(),
  listStagedContacts: vi.fn(),
  approveStagedContact: vi.fn(),
  rejectStagedContact: vi.fn(),
  mergeStagedContact: vi.fn(),
  batchApproveStagedContacts: vi.fn(),
}));

vi.mock("../../../src/modules/migration/validator.js", () => ({
  validateStagedDeals: vi.fn(),
  validateStagedContacts: vi.fn(),
  validateStagedActivities: vi.fn(),
  validateStagedCompanies: vi.fn(),
  validateStagedProperties: vi.fn(),
  validateStagedLeads: vi.fn(),
}));

import { migrationRouter } from "../../../src/modules/migration/routes.js";

describe("migration router scoping", () => {
  beforeEach(() => {
    mocks.authMiddleware.mockClear();
    mocks.requireAdmin.mockClear();
  });

  it("does not intercept unrelated /api routes for non-admin users", async () => {
    const app = express();
    app.use("/api", migrationRouter);
    app.get("/api/notifications/unread-count", (_req, res) => {
      res.json({ count: 0 });
    });

    const response = await request(app).get("/api/notifications/unread-count");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: 0 });
    expect(mocks.authMiddleware).not.toHaveBeenCalled();
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
  });

  it("still protects actual migration endpoints", async () => {
    const app = express();
    app.use("/api", migrationRouter);

    const response = await request(app).get("/api/migration/summary");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Requires one of: admin" } });
    expect(mocks.authMiddleware).toHaveBeenCalledOnce();
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
  });
});
