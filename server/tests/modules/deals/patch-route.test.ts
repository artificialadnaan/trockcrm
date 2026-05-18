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

async function invokePatch(
  body: Record<string, unknown>,
  user: TestUser,
  options: {
    selectedProperty?: {
      companyId?: string | null;
      address: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
    } | null;
  } = {}
) {
  const handler = findPatchHandler();
  const selectedProperty =
    options.selectedProperty ??
    (typeof body.propertyId === "string"
      ? {
          companyId: "company-1",
          address: "100 Property Way",
          city: "Dallas",
          state: "TX",
          zip: "75201",
        }
      : null);
  const req = {
    params: { id: "deal-1" },
    query: {},
    body,
    user,
    tenantDb: {
      execute: vi.fn(async () => ({ rows: [] })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => (
              selectedProperty
                ? [selectedProperty]
                : []
            )),
          })),
        })),
      })),
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

  it("does not force cleanup validation when migrationMode is requested without an actual relationship repair", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal());

    const { req, res, error } = await invokePatch(
      {
        description: "Trying to update without repairing lineage",
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
        description: "Trying to update without repairing lineage",
      }),
      "rep",
      "rep-1",
      "office-1"
    );
  });

  it("allows company/property relationship repair without invoking the post-RFP scope guard", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal());

    const { req, res, error } = await invokePatch(
      {
        companyId: "company-1",
        propertyId: "property-1",
      },
      createUser("rep")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(scopingServiceMocks.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({
        companyId: "company-1",
        propertyId: "property-1",
      }),
      "rep",
      "rep-1",
      "office-1"
    );
  });

  it("allows scope-locked direct deal fields during cleanup relationship repair and tags the scope audit", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal());
    scopingServiceMocks.assertDealScopingWriteAllowed.mockResolvedValue({
      adminOverride: false,
      lockState: {
        locked: true,
        submittedAt: new Date("2026-05-12T12:00:00.000Z"),
        reason: "rfp_submission",
      },
    });

    const { req, res, error } = await invokePatch(
      {
        companyId: "company-1",
        propertyId: "property-1",
        projectTypeId: "project-type-2",
      },
      createUser("rep")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(scopingServiceMocks.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      { role: "rep", forceEditAfterRfp: false, cleanupMode: true }
    );
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({
        companyId: "company-1",
        propertyId: "property-1",
        projectTypeId: "project-type-2",
        migrationMode: true,
      }),
      "rep",
      "rep-1",
      "office-1"
    );
    expect(auditMocks.writeAuditLog).toHaveBeenNthCalledWith(
      2,
      req.tenantDb,
      expect.objectContaining({
        tableName: "deals",
        recordId: "deal-1",
        action: "legacy_cleanup_scope_change",
        changedBy: "rep-1",
        actorName: "rep user",
        entityType: "deal",
        changes: expect.objectContaining({
          projectTypeId: {
            from: "project-type-1",
            to: "project-type-2",
          },
        }),
        fullRow: expect.objectContaining({
          route: "deals",
          cleanupMode: true,
        }),
      })
    );
  });

  it("surfaces the service lineage rejection when companyId replacement is attempted", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal({
      companyId: "company-1",
      propertyId: "property-1",
    }));
    dealsServiceMocks.updateDeal.mockRejectedValueOnce(
      new AppError(400, "companyId is immutable once established")
    );

    const { error } = await invokePatch(
      {
        companyId: "company-2",
      },
      createUser("rep"),
      {
        selectedProperty: {
          companyId: "company-2",
          address: "100 Property Way",
          city: "Dallas",
          state: "TX",
          zip: "75201",
        },
      }
    );

    expect(error).toMatchObject({
      statusCode: 400,
      message: "companyId is immutable once established",
    });
    expect(scopingServiceMocks.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
  });

  it("surfaces the service lineage rejection when propertyId replacement is attempted", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal({
      companyId: "company-1",
      propertyId: "property-1",
    }));
    dealsServiceMocks.updateDeal.mockRejectedValueOnce(
      new AppError(400, "propertyId is immutable once established")
    );

    const { error } = await invokePatch(
      {
        propertyId: "property-2",
      },
      createUser("rep")
    );

    expect(error).toMatchObject({
      statusCode: 400,
      message: "propertyId is immutable once established",
    });
    expect(scopingServiceMocks.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
  });

  it("still honors the scope-readonly guard for scope-defining deal fields", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal());
    scopingServiceMocks.assertDealScopingWriteAllowed.mockRejectedValue(
      new AppError(403, "Scope is read-only after RFP submission", "SCOPE_READ_ONLY_AFTER_RFP")
    );

    const { error } = await invokePatch(
      {
        projectTypeId: "project-type-2",
      },
      createUser("rep")
    );

    expect(error).toMatchObject({
      statusCode: 403,
      message: "Scope is read-only after RFP submission",
    });
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
  });

  it("still blocks scope-defining edits on non-legacy deals even if a relationship field is present", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal({
      sourceLeadId: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
    }));
    scopingServiceMocks.assertDealScopingWriteAllowed.mockRejectedValue(
      new AppError(403, "Scope is read-only after RFP submission", "SCOPE_READ_ONLY_AFTER_RFP")
    );

    const { error } = await invokePatch(
      {
        companyId: "company-1",
        projectTypeId: "project-type-2",
      },
      createUser("rep")
    );

    expect(error).toMatchObject({
      statusCode: 403,
      message: "Scope is read-only after RFP submission",
    });
    expect(scopingServiceMocks.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      { role: "rep", forceEditAfterRfp: false }
    );
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
  });

  it("rejects partial relationship repair on legacy direct patches when scope-locked fields are also changing", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal({
      companyId: null,
      propertyId: null,
    }));
    scopingServiceMocks.assertDealScopingWriteAllowed.mockRejectedValue(
      new AppError(403, "Scope is read-only after RFP submission", "SCOPE_READ_ONLY_AFTER_RFP")
    );

    const { error } = await invokePatch(
      {
        companyId: "company-1",
        projectTypeId: "project-type-2",
      },
      createUser("rep")
    );

    expect(error).toMatchObject({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });
    expect(scopingServiceMocks.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      { role: "rep", forceEditAfterRfp: false }
    );
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
  });

  it("still rejects cleanup relationship repair when the selected property belongs to a different company", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal());

    const { error } = await invokePatch(
      {
        companyId: "company-1",
        propertyId: "property-1",
        projectTypeId: "project-type-2",
      },
      createUser("rep"),
      {
        selectedProperty: {
          companyId: "company-2",
          address: "100 Property Way",
          city: "Dallas",
          state: "TX",
          zip: "75201",
        },
      }
    );

    expect(error).toMatchObject({
      statusCode: 400,
      message: "Property does not belong to the company",
    });
    expect(scopingServiceMocks.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      { role: "rep", forceEditAfterRfp: false, cleanupMode: true }
    );
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
  });

  it("syncs deal address fields from the selected property instead of trusting client-supplied address", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal());

    const { req, error } = await invokePatch(
      {
        companyId: "company-1",
        propertyId: "property-1",
        propertyAddress: "Client typed address",
        propertyCity: "Client City",
        propertyState: "ZZ",
        propertyZip: "00000",
      },
      createUser("rep"),
      {
        selectedProperty: {
          companyId: "company-1",
          address: "5000 Triangle Pkwy",
          city: "Peachtree Corners",
          state: "GA",
          zip: "30092",
        },
      }
    );

    expect(error).toBeNull();
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({
        propertyId: "property-1",
        propertyAddress: "5000 Triangle Pkwy",
        propertyCity: "Peachtree Corners",
        propertyState: "GA",
        propertyZip: "30092",
      }),
      "rep",
      "rep-1",
      "office-1"
    );
  });

  it("does not overwrite an existing attached deal address when propertyId is unchanged", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal({
      companyId: "company-1",
      propertyId: "property-1",
      propertyAddress: "Existing manual address",
      propertyCity: "Dallas",
      propertyState: "TX",
      propertyZip: "75201",
    }));

    const { req, error } = await invokePatch(
      {
        description: "Unrelated edit",
        companyId: "company-1",
        propertyId: "property-1",
        propertyAddress: "Client typed address",
        propertyCity: "Client City",
        propertyState: "ZZ",
        propertyZip: "00000",
      },
      createUser("rep"),
      {
        selectedProperty: {
          companyId: "company-1",
          address: "5000 Triangle Pkwy",
          city: "Peachtree Corners",
          state: "GA",
          zip: "30092",
        },
      }
    );

    expect(error).toBeNull();
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.not.objectContaining({
        propertyAddress: expect.anything(),
        propertyCity: expect.anything(),
        propertyState: expect.anything(),
        propertyZip: expect.anything(),
      }),
      "rep",
      "rep-1",
      "office-1"
    );
  });

  it("does not revalidate historical company/property mismatches when relationship ids are unchanged", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal({
      companyId: "company-1",
      propertyId: "property-1",
      propertyAddress: "Existing manual address",
      propertyCity: "Dallas",
      propertyState: "TX",
      propertyZip: "75201",
    }));

    const { req, error } = await invokePatch(
      {
        description: "Unrelated edit",
        companyId: "company-1",
        propertyId: "property-1",
      },
      createUser("rep"),
      {
        selectedProperty: {
          companyId: "company-2",
          address: "5000 Triangle Pkwy",
          city: "Peachtree Corners",
          state: "GA",
          zip: "30092",
        },
      }
    );

    expect(error).toBeNull();
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({
        description: "Unrelated edit",
        companyId: "company-1",
        propertyId: "property-1",
      }),
      "rep",
      "rep-1",
      "office-1"
    );
  });

  it("rejects relationship repair when the selected property belongs to a different company", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal());

    const { error } = await invokePatch(
      {
        companyId: "company-1",
        propertyId: "property-1",
      },
      createUser("rep"),
      {
        selectedProperty: {
          companyId: "company-2",
          address: "5000 Triangle Pkwy",
          city: "Peachtree Corners",
          state: "GA",
          zip: "30092",
        },
      }
    );

    expect(error).toMatchObject({
      statusCode: 400,
      message: "Property does not belong to the company",
    });
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
  });

  it("rejects company repair when the existing property belongs to a different company", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(baseDeal({
      companyId: null,
      propertyId: "property-1",
    }));

    const { error } = await invokePatch(
      {
        companyId: "company-1",
      },
      createUser("rep"),
      {
        selectedProperty: {
          companyId: "company-2",
          address: "5000 Triangle Pkwy",
          city: "Peachtree Corners",
          state: "GA",
          zip: "30092",
        },
      }
    );

    expect(error).toMatchObject({
      statusCode: 400,
      message: "Property does not belong to the company",
    });
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
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
});
