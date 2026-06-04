import { beforeEach, describe, expect, it, vi } from "vitest";

const dealsServiceMocks = vi.hoisted(() => ({
  createDeal: vi.fn(),
  getDealById: vi.fn(),
  updateDeal: vi.fn(),
}));
const pipelineServiceMocks = vi.hoisted(() => ({
  getActiveProjectTypes: vi.fn(),
  getStageBySlug: vi.fn(),
}));
const scopingServiceMocks = vi.hoisted(() => ({
  assertDealScopingWriteAllowed: vi.fn(),
}));
const auditMocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
}));
const accessMocks = vi.hoisted(() => ({
  assertDealCollaboratorAccess: vi.fn(),
  assertDealOwnerAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn((_role: string, scope: "mine" | "team" | "all" | undefined) => scope ?? "all"),
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
    createDeal: dealsServiceMocks.createDeal,
    getDealById: dealsServiceMocks.getDealById,
    updateDeal: dealsServiceMocks.updateDeal,
  };
});

vi.mock("../../../src/modules/pipeline/service.js", async () => {
  const actual = await vi.importActual("../../../src/modules/pipeline/service.js");
  return {
    ...(actual as Record<string, unknown>),
    getActiveProjectTypes: pipelineServiceMocks.getActiveProjectTypes,
    getStageBySlug: pipelineServiceMocks.getStageBySlug,
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

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  assertDealOwnerAccess: accessMocks.assertDealOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
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

function findPostHandler(path: string) {
  const layer = (dealRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.post
  );
  if (!layer) {
    throw new Error(`POST ${path} route not found`);
  }

  const routeLayer = layer.route.stack.find((entry: any) => entry.method === "post");
  if (!routeLayer) {
    throw new Error(`POST ${path} handler not found`);
  }

  return routeLayer.handle;
}

async function invokePost(path: string, body: Record<string, unknown>, user: TestUser) {
  const handler = findPostHandler(path);
  let selectCount = 0;
  const req = {
    params: {},
    query: {},
    body,
    user,
    officeSlug: "dallas",
    tenantDb: {
      execute: vi.fn(async () => ({ rows: [] })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              selectCount += 1;
              if (selectCount === 1) return [{ id: "company-1" }];
              return [{ id: "property-1", companyId: "company-1" }];
            }),
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
    accessMocks.assertDealCollaboratorAccess.mockResolvedValue({ id: "deal-1", assignedRepId: "rep-1", officeId: "office-1" });
    accessMocks.assertDealOwnerAccess.mockResolvedValue({ id: "deal-1", assignedRepId: "rep-1", officeId: "office-1" });
    scopingServiceMocks.assertDealScopingWriteAllowed.mockResolvedValue({
      adminOverride: false,
      lockState: { locked: false, submittedAt: null, reason: null },
    });
    pipelineServiceMocks.getActiveProjectTypes.mockResolvedValue([
      { id: "project-type-service", name: "Service", slug: "service" },
    ]);
    pipelineServiceMocks.getStageBySlug.mockResolvedValue({
      id: "stage-opportunity",
      name: "Opportunity",
      slug: "opportunity",
      isTerminal: false,
      isActivePipeline: true,
      workflowFamily: "standard_deal",
    });
    dealsServiceMocks.createDeal.mockImplementation(async (_tenantDb, input) => ({
      id: "deal-created",
      ...baseDeal(),
      ...input,
    }));
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

  // Piece A contract guard: the deal form now lets a rep save a single enrichment field on an existing
  // deal (incl. Bid-Board-Owned) without attaching both a company and a property. The route must accept
  // such a partial PATCH and never apply a "both required" gate to a single-field enrichment save.
  it("accepts a close-date-only enrichment PATCH on a Bid-Board-Owned deal with no company or property", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(
      baseDeal({ isBidBoardOwned: true, companyId: null, propertyId: null, sourceLeadId: null })
    );

    const { req, res, error } = await invokePatch(
      { expectedCloseDate: "2026-09-01" },
      createUser("rep")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({ expectedCloseDate: "2026-09-01" }),
      "rep",
      "rep-1",
      "office-1"
    );
    // With no company/property in the body the route must not touch the uuid columns at all.
    const [, , patch] = dealsServiceMocks.updateDeal.mock.calls[0];
    expect(patch).not.toHaveProperty("companyId");
    expect(patch).not.toHaveProperty("propertyId");
  });

  it("accepts a company-only relationship fill-in on a relationship-less deal without requiring a property", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(
      baseDeal({ isBidBoardOwned: true, companyId: null, propertyId: null, sourceLeadId: null })
    );

    const { req, res, error } = await invokePatch(
      { companyId: "company-1" },
      createUser("rep")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({ companyId: "company-1" }),
      "rep",
      "rep-1",
      "office-1"
    );
    const [, , patch] = dealsServiceMocks.updateDeal.mock.calls[0];
    expect(patch).not.toHaveProperty("propertyId");
  });

  it("accepts a property-only relationship fill-in on a relationship-less deal without requiring a company", async () => {
    dealsServiceMocks.getDealById.mockResolvedValue(
      baseDeal({ isBidBoardOwned: true, companyId: null, propertyId: null, sourceLeadId: null })
    );

    const { req, res, error } = await invokePatch(
      { propertyId: "property-1" },
      createUser("rep"),
      { selectedProperty: { companyId: null, address: "1 A St", city: "Dallas", state: "TX", zip: "75201" } }
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({ propertyId: "property-1" }),
      "rep",
      "rep-1",
      "office-1"
    );
    const [, , patch] = dealsServiceMocks.updateDeal.mock.calls[0];
    expect(patch).not.toHaveProperty("companyId");
  });

  it("rejects projectNumber updates from reps before calling updateDeal", async () => {
    const { error } = await invokePatch(
      { projectNumber: "DFW-1-12345-aa" },
      createUser("rep")
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as InstanceType<typeof AppError>).statusCode).toBe(403);
    expect((error as InstanceType<typeof AppError>).code).toBe("PROJECT_NUMBER_UPDATE_FORBIDDEN");
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
  });

  it("trims projectNumber before the standard create path reaches createDeal", async () => {
    const { req, res, error } = await invokePost(
      "/",
      {
        name: "New project-number deal",
        stageId: "stage-opportunity",
        projectNumber: "  DFW-1-12345-aa  ",
      },
      createUser("admin")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(201);
    expect(dealsServiceMocks.createDeal).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        name: "New project-number deal",
        projectNumber: "DFW-1-12345-aa",
        auditContext: expect.any(Object),
      })
    );
  });

  it("forwards a trimmed projectNumber through service-opportunity create", async () => {
    const { req, res, error } = await invokePost(
      "/service-opportunity",
      {
        name: "Service opportunity",
        companyId: "company-1",
        propertyId: "property-1",
        projectNumber: "  ATL-2-54321-ab  ",
      },
      createUser("director")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(201);
    expect(dealsServiceMocks.createDeal).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        workflowRoute: "service",
        projectNumber: "ATL-2-54321-ab",
        auditContext: expect.any(Object),
      })
    );
  });

  it("coerces a whitespace-only projectNumber to null on service-opportunity create", async () => {
    // Blank/whitespace clears the field rather than throwing (operator decision).
    const { req, res, error } = await invokePost(
      "/service-opportunity",
      {
        name: "Service opportunity",
        companyId: "company-1",
        propertyId: "property-1",
        projectNumber: "   ",
      },
      createUser("admin")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(201);
    expect(dealsServiceMocks.createDeal).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({ projectNumber: null })
    );
  });

  it("rejects an over-length projectNumber on service-opportunity create", async () => {
    const { error } = await invokePost(
      "/service-opportunity",
      {
        name: "Service opportunity",
        companyId: "company-1",
        propertyId: "property-1",
        projectNumber: "a".repeat(101),
      },
      createUser("admin")
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as InstanceType<typeof AppError>).statusCode).toBe(400);
    expect((error as InstanceType<typeof AppError>).code).toBe("PROJECT_NUMBER_INVALID");
    expect(dealsServiceMocks.createDeal).not.toHaveBeenCalled();
  });

  it("rejects projectNumber on standard create for reps", async () => {
    const { error } = await invokePost(
      "/",
      {
        name: "Rep project-number deal",
        stageId: "stage-opportunity",
        projectNumber: "DFW-1-12345-aa",
      },
      createUser("rep")
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as InstanceType<typeof AppError>).statusCode).toBe(403);
    expect((error as InstanceType<typeof AppError>).code).toBe("PROJECT_NUMBER_UPDATE_FORBIDDEN");
    expect(dealsServiceMocks.createDeal).not.toHaveBeenCalled();
  });

  it("rejects projectNumber clears from reps before calling updateDeal", async () => {
    const { error } = await invokePatch(
      { projectNumber: null },
      createUser("rep")
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as InstanceType<typeof AppError>).statusCode).toBe(403);
    expect((error as InstanceType<typeof AppError>).code).toBe("PROJECT_NUMBER_UPDATE_FORBIDDEN");
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
  });

  it("allows admin projectNumber updates through the audited updateDeal path", async () => {
    const { res, error } = await invokePatch(
      { projectNumber: "DFW-1-12345-aa" },
      createUser("admin")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      expect.objectContaining({
        projectNumber: "DFW-1-12345-aa",
        auditContext: expect.any(Object),
      }),
      "admin",
      "admin-1",
      "office-1",
    );
  });

  it("allows director projectNumber updates through the audited updateDeal path", async () => {
    const { res, error } = await invokePatch(
      { projectNumber: "DFW-1-54321-aa" },
      createUser("director")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      expect.objectContaining({
        projectNumber: "DFW-1-54321-aa",
        auditContext: expect.any(Object),
      }),
      "director",
      "director-1",
      "office-1",
    );
  });

  it("allows an admin who does not own the deal to set projectNumber without the owner-only 403", async () => {
    // Deal is owned by a different rep; mock assertDealOwnerAccess to reject so we
    // verify the route bypasses the owner check for projectNumber-only admin patches.
    accessMocks.assertDealCollaboratorAccess.mockResolvedValueOnce({
      id: "deal-1",
      assignedRepId: "other-rep",
      officeId: "office-1",
    });
    accessMocks.assertDealOwnerAccess.mockRejectedValue(
      new AppError(403, "Only the assigned rep can modify this deal")
    );

    const { res, error } = await invokePatch(
      { projectNumber: "DFW-1-12345-aa" },
      createUser("admin")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(accessMocks.assertDealOwnerAccess).not.toHaveBeenCalled();
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      expect.objectContaining({ projectNumber: "DFW-1-12345-aa" }),
      "admin",
      "admin-1",
      "office-1",
    );
  });

  it("allows an admin who does not own the deal to clear projectNumber (null) via the override", async () => {
    accessMocks.assertDealCollaboratorAccess.mockResolvedValueOnce({
      id: "deal-1",
      assignedRepId: "other-rep",
      officeId: "office-1",
    });
    accessMocks.assertDealOwnerAccess.mockRejectedValue(
      new AppError(403, "Only the assigned rep can modify this deal")
    );

    const { res, error } = await invokePatch(
      { projectNumber: null },
      createUser("admin")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(accessMocks.assertDealOwnerAccess).not.toHaveBeenCalled();
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      expect.objectContaining({ projectNumber: null }),
      "admin",
      "admin-1",
      "office-1",
    );
  });

  it("allows a director who does not own the deal to set projectNumber without the owner-only 403", async () => {
    accessMocks.assertDealCollaboratorAccess.mockResolvedValueOnce({
      id: "deal-1",
      assignedRepId: "other-rep",
      officeId: "office-1",
    });
    accessMocks.assertDealOwnerAccess.mockRejectedValue(
      new AppError(403, "Only the assigned rep can modify this deal")
    );

    const { res, error } = await invokePatch(
      { projectNumber: "ATL-2-54321-ab" },
      createUser("director")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(accessMocks.assertDealOwnerAccess).not.toHaveBeenCalled();
  });

  it("still enforces the owner check when an admin patches projectNumber alongside other fields", async () => {
    // Broader PATCH must still respect the ownership check — narrow override is
    // only for projectNumber-only payloads.
    accessMocks.assertDealCollaboratorAccess.mockResolvedValueOnce({
      id: "deal-1",
      assignedRepId: "other-rep",
      officeId: "office-1",
    });
    accessMocks.assertDealOwnerAccess.mockRejectedValue(
      new AppError(403, "Only the assigned rep can modify this deal")
    );

    const { error } = await invokePatch(
      {
        projectNumber: "DFW-1-12345-aa",
        description: "Admin also editing other fields",
      },
      createUser("admin")
    );

    expect(error).toMatchObject({
      statusCode: 403,
      message: "Only the assigned rep can modify this deal",
    });
    expect(accessMocks.assertDealOwnerAccess).toHaveBeenCalled();
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
  });

  it("still enforces the owner check when an admin patches other fields without projectNumber", async () => {
    accessMocks.assertDealCollaboratorAccess.mockResolvedValueOnce({
      id: "deal-1",
      assignedRepId: "other-rep",
      officeId: "office-1",
    });
    accessMocks.assertDealOwnerAccess.mockRejectedValue(
      new AppError(403, "Only the assigned rep can modify this deal")
    );

    const { error } = await invokePatch(
      { description: "Admin trying to edit description on a rep's deal" },
      createUser("admin")
    );

    expect(error).toMatchObject({
      statusCode: 403,
      message: "Only the assigned rep can modify this deal",
    });
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
  });

  it.each([
    ["oversized string", "a".repeat(101)],
  ])("rejects invalid projectNumber payloads before calling updateDeal: %s", async (_label, projectNumber) => {
    const { error } = await invokePatch(
      { projectNumber },
      createUser("admin")
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as InstanceType<typeof AppError>).statusCode).toBe(400);
    expect((error as InstanceType<typeof AppError>).code).toBe("PROJECT_NUMBER_INVALID");
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
  });

  it.each([
    ["empty string", ""],
    ["whitespace-only string", "   "],
  ])("coerces a blank projectNumber to null instead of rejecting: %s", async (_label, projectNumber) => {
    // Per operator decision, blank/whitespace clears the field (parity with the
    // HubSpot import path) rather than throwing a 400.
    const { res, error } = await invokePatch(
      { projectNumber },
      createUser("admin")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      expect.objectContaining({ projectNumber: null }),
      "admin",
      "admin-1",
      "office-1",
    );
  });

  it.each([
    ["lowercase office prefix", "dfw-3-12626-ab"],
    ["short legacy code", "KMH"],
    ["rep code with at-sign", "2-R@37-011426"],
  ])("accepts historical non-canonical projectNumber formats: %s", async (_label, projectNumber) => {
    // The ACCEPTED validator must never reject a value that exists in production.
    const { res, error } = await invokePatch(
      { projectNumber },
      createUser("admin")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      expect.objectContaining({ projectNumber }),
      "admin",
      "admin-1",
      "office-1",
    );
  });

  it.each([
    ["custom rep-prefix code", "KMPWINTERS"],
    ["legacy import date-suffix", "1-TLV.1-091625"],
    ["legacy canonical with single-letter type code", "DFW-a-05826-ad"],
  ])(
    "accepts operator-confirmed legacy projectNumber formats on admin PATCH: %s",
    async (_label, projectNumber) => {
      const { res, error } = await invokePatch({ projectNumber }, createUser("admin"));

      expect(error).toBeNull();
      expect(res.statusCode).toBe(200);
      expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
        expect.anything(),
        "deal-1",
        expect.objectContaining({ projectNumber }),
        "admin",
        "admin-1",
        "office-1",
      );
    }
  );

  it("trims canonical projectNumber values before the audited updateDeal path", async () => {
    const { res, error } = await invokePatch(
      { projectNumber: "  ATL-2-54321-ab  " },
      createUser("admin")
    );

    expect(error).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      expect.objectContaining({
        projectNumber: "ATL-2-54321-ab",
        auditContext: expect.any(Object),
      }),
      "admin",
      "admin-1",
      "office-1",
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

describe("PATCH /api/deals/:id reassignment authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMocks.assertDealCollaboratorAccess.mockResolvedValue({ id: "deal-1", assignedRepId: "rep-1", officeId: "office-1" });
    accessMocks.assertDealOwnerAccess.mockResolvedValue({ id: "deal-1", assignedRepId: "rep-1", officeId: "office-1" });
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

  it("lets directors reassign any deal through the full updateDeal path", async () => {
    const { req, error } = await invokePatch({ assignedRepId: "rep-2" }, createUser("director"));

    expect(error).toBeNull();
    expect(accessMocks.assertDealOwnerAccess).not.toHaveBeenCalled();
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({ assignedRepId: "rep-2" }),
      "director",
      "director-1",
      "office-1"
    );
  });

  it("lets the current assigned rep reassign their own deal through updateDeal", async () => {
    const { req, error } = await invokePatch({ assignedRepId: "rep-2" }, createUser("rep"));

    expect(error).toBeNull();
    expect(accessMocks.assertDealOwnerAccess).not.toHaveBeenCalled();
    expect(dealsServiceMocks.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({ assignedRepId: "rep-2" }),
      "rep",
      "rep-1",
      "office-1"
    );
  });

  it("rejects a non-owner rep reassignment with a typed authorization error", async () => {
    accessMocks.assertDealCollaboratorAccess.mockResolvedValueOnce({
      id: "deal-1",
      assignedRepId: "rep-owner",
      officeId: "office-1",
    });

    const { error } = await invokePatch({ assignedRepId: "rep-2" }, createUser("rep"));

    expect(error).toMatchObject({
      statusCode: 403,
      code: "DEAL_REASSIGNMENT_FORBIDDEN",
      message: "Only the assigned rep, a director, or an admin can reassign this deal",
    });
    expect(accessMocks.assertDealOwnerAccess).not.toHaveBeenCalled();
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
  });
});
