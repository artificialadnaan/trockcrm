import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.user = { id: "admin-1", role: "admin" };
    next();
  }),
  requireAdmin: vi.fn((_req: any, _res: any, next: any) => next()),
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

import { errorHandler } from "../../../src/middleware/error-handler.js";
import * as migrationService from "../../../src/modules/migration/service.js";
import { migrationRouter } from "../../../src/modules/migration/routes.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", migrationRouter);
  app.use(errorHandler);
  return app;
}

describe("migration route error handling", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it.each([
    ["/api/migration/summary", migrationService.getMigrationSummary],
    ["/api/migration/exceptions", migrationService.getMigrationExceptions],
    ["/api/migration/runs", migrationService.getImportRuns],
  ])("sanitizes internal error details for %s", async (path, mockedHandler) => {
    vi.mocked(mockedHandler).mockRejectedValueOnce(
      new Error("PostgreSQL syntax error near SELECT * FROM staged_deals\n at internal-stack-frame")
    );

    const response = await request(buildApp()).get(path);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { message: "Internal server error" } });
    expect(JSON.stringify(response.body)).not.toMatch(/PostgreSQL|SELECT|staged_deals|stack/i);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
