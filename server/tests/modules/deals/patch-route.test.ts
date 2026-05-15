import { beforeEach, describe, expect, it, vi } from "vitest";

const dealsServiceMocks = vi.hoisted(() => ({
  getDealById: vi.fn(),
  updateDeal: vi.fn(),
}));
const scopingServiceMocks = vi.hoisted(() => ({
  assertDealScopingWriteAllowed: vi.fn(),
}));
const auditMocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
}));

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: {
    emitLocal: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    setMaxListeners: vi.fn(),
  },
}));

vi.mock("../../../src/modules/deals/service.js", async () => {
  const actual = await vi.importActual("../../../src/modules/deals/service.js");
  return {
    ...(actual as Record<string, unknown>),
    getDealById: dealsServiceMocks.getDealById,
    updateDeal: dealsServiceMocks.updateDeal,
  };
});

vi.mock("../../../src/modules/deals/scoping-service.js", async () => {
  const actual = await vi.importActual("../../../src/modules/deals/scoping-service.js");
  return {
    ...(actual as Record<string, unknown>),
    assertDealScopingWriteAllowed: scopingServiceMocks.assertDealScopingWriteAllowed,
  };
});

vi.mock("../../../src/lib/audit-log.js", () => ({
  writeAuditLog: auditMocks.writeAuditLog,
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const { AppError } = await import("../../../src/middleware/error-handler.js");

type TestUser = {
  id: string;
  role: "admin" | "director" | "rep";
  displayName: string;
  email: string;
  officeId: string;
  activeOfficeId: string;
};

function createUser(role: TestUser["role"]): TestUser {
  return {
    id: `${role}-1`,
    role,
    displayName: `${role} user`,
    email: `${role}@example.com`,
    officeId: "office-1",
    activeOfficeId: "office-1",
  };
}

function baseDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-1",
    name: "Legacy Cleanup Deal",
    assignedRepId: "rep-1",
    companyId: null,
    propertyId: null,
    primaryContactId: null,
    projectType: "Commercial",
    projectTypeId: "project-type-1",
    workflowRoute: "normal",
    sourceLeadId: null,
    stageId: "stage-1",
    stageEnteredAt: new Date("2026-05-01T12:00:00.000Z"),
    pipelineTypeSnapshot: "normal",
    ddEstimate: null,
    bidEstimate: null,
    awardedAmount: null,
    isBidBoardOwned: false,
    bidBoardStageSlug: null,
    bidBoardStageEnteredAt: null,
    bidBoardMirrorSourceEnteredAt: null,
    isReadOnlyMirror: false,
    readOnlySyncedAt: null,
    ...overrides,
  };
}

function findPatchHandler() {
  const layer = (dealRoutes as any).stack.find(
    (entry: any) => entry.route?.path === "/:id" && entry.route?.methods?.patch
  );
  if (!layer) {
    throw new Error("PATCH /:id route not found");
  }

  const routeLayer = layer.route.stack.find((entry: any) => entry.method === "patch");
  if (!routeLayer) {
    throw new Error("PATCH /:id handler not found");
  }

  return routeLayer.handle;
}

async function invokePatch(body: Record<string, unknown>, user: TestUser) {
  const handler = findPatchHandler();
  const req = {
    params: { id: "deal-1" },
    query: {},
    body,
    user,
    tenantDb: {
      execute: vi.fn(async () => ({ rows: [] })),
      insert: vi.fn(() => ({
        values: vi.fn(async () => ({})),
      })),
    },
    commitTransaction: vi.fn(async () => {}),
  } as any;
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  } as any;
  const error = { current: null as unknown };
  const next = vi.fn((err?: unknown) => {
    error.current = err ?? null;
  });

  await handler(req, res, next);
  return { req, res, next, error: error.current };
}

describe("PATCH /api/deals/:id cleanup legacy handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopingServiceMocks.assertDealScopingWriteAllowed.mockResolvedValue({
      adminOverride: false,
      lockState: { locked: false, submittedAt: null, reason: null },
    });
    dealsServiceMocks.updateDeal.mockImplementation(async (_tenantDb, dealId, input) => ({
      id: dealId,
      ...baseDeal(),
      ...input,
    }));
  });

  it("derives cleanup-mode lineage server-side for legacy deals with missing relationships", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal());

    const { req, res, error } = await invokePatch(
      {
        companyId: "company-1",
        propertyId: "property-1",
        migrationMode: true,
      },
      createUser("rep")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({
        companyId: "company-1",
        propertyId: "property-1",
        migrationMode: true,
      }),
      "rep",
      "rep-1",
      "office-1"
    );
    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        tableName: "deals",
        recordId: "deal-1",
        action: "update",
        changedBy: "rep-1",
      })
    );
  });

  it("does not treat unchanged relationship ids as cleanup on legacy deals", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal({
      companyId: "company-1",
      propertyId: null,
    }));

    const { req, res, error } = await invokePatch(
      {
        companyId: "company-1",
        propertyId: null,
        nextStep: "Follow up tomorrow",
        migrationMode: true,
      },
      createUser("rep")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.not.objectContaining({
        migrationMode: true,
      }),
      "rep",
      "rep-1",
      "office-1"
    );
    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("ignores client-supplied migrationMode on normal deals with source lead lineage", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal({
      sourceLeadId: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
    }));

    const { req, res, error } = await invokePatch(
      {
        description: "Keep existing flow",
        migrationMode: true,
      },
      createUser("director")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.not.objectContaining({
        migrationMode: true,
      }),
      "director",
      "director-1",
      "office-1"
    );
    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("returns a clear validation error when legacy cleanup still lacks company/property", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal());

    const { error } = await invokePatch(
      {
        companyId: "company-1",
        migrationMode: true,
      },
      createUser("rep")
    );

    expect(error).toMatchObject({
      statusCode: 400,
      message: "Legacy cleanup requires both company and property before this deal can be saved.",
    });
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
  });

  it("still honors the scope-readonly guard on legacy deals", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal());
    scopingServiceMocks.assertDealScopingWriteAllowed.mockRejectedValue(
      new AppError(403, "Scope is read-only after RFP submission", "SCOPE_READ_ONLY_AFTER_RFP")
    );

    const { error } = await invokePatch(
      {
        companyId: "company-1",
        propertyId: "property-1",
      },
      createUser("rep")
    );

    expect(error).toMatchObject({
      statusCode: 403,
      message: "Scope is read-only after RFP submission",
    });
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
  });

  it("still honors the scope-readonly guard on RFP'd legacy non-cleanup edits", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal({
      companyId: "company-1",
      propertyId: null,
    }));
    scopingServiceMocks.assertDealScopingWriteAllowed.mockRejectedValue(
      new AppError(403, "Scope is read-only after RFP submission", "SCOPE_READ_ONLY_AFTER_RFP")
    );

    const { error } = await invokePatch(
      {
        companyId: "company-1",
        propertyId: null,
        projectTypeId: "project-type-2",
      },
      createUser("rep")
    );

    expect(error).toMatchObject({
      statusCode: 403,
      message: "Scope is read-only after RFP submission",
    });
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("does not force cleanup validation onto non-cleanup legacy PATCH flows", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal());

    const { req, res, error } = await invokePatch(
      {
        description: "Standard legacy deal edit outside cleanup queue",
      },
      createUser("rep")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.not.objectContaining({
        migrationMode: true,
      }),
      "rep",
      "rep-1",
      "office-1"
    );
    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("does not force cleanup validation when legacy edits include unchanged relationship fields", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal({
      companyId: "company-1",
      propertyId: null,
    }));

    const { req, res, error } = await invokePatch(
      {
        nextStep: "Standard legacy note update",
        companyId: "company-1",
        propertyId: null,
        migrationMode: true,
      },
      createUser("rep")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.not.objectContaining({
        migrationMode: true,
      }),
      "rep",
      "rep-1",
      "office-1"
    );
    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("treats actual relationship value changes as cleanup on legacy deals", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal({
      companyId: null,
      propertyId: "property-1",
    }));

    const { req, res, error } = await invokePatch(
      {
        companyId: "company-2",
        propertyId: "property-1",
        migrationMode: true,
      },
      createUser("rep")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({
        companyId: "company-2",
        propertyId: "property-1",
        migrationMode: true,
      }),
      "rep",
      "rep-1",
      "office-1"
    );
    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        fullRow: expect.objectContaining({
          reason: "legacy_cleanup_relationship_repair",
          companyIdBefore: null,
          companyIdAfter: "company-2",
        }),
      })
    );
  });

  it("allows cleanup-mode relationship repair on RFP'd legacy deals", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal({
      companyId: null,
      propertyId: "property-1",
    }));
    scopingServiceMocks.assertDealScopingWriteAllowed.mockResolvedValue({
      adminOverride: false,
      lockState: { locked: true, submittedAt: new Date("2026-05-15T12:00:00.000Z"), reason: "rfp_submission" },
    });

    const { req, res, error } = await invokePatch(
      {
        companyId: "company-9",
        propertyId: "property-1",
        migrationMode: true,
      },
      createUser("rep")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({
        companyId: "company-9",
        propertyId: "property-1",
        migrationMode: true,
      }),
      "rep",
      "rep-1",
      "office-1"
    );
    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        fullRow: expect.objectContaining({
          reason: "legacy_cleanup_relationship_repair",
        }),
      })
    );
  });
});
