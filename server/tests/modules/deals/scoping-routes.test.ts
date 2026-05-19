import { beforeEach, describe, expect, it, vi } from "vitest";

const auditMocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  assertDealCollaboratorAccess: vi.fn(),
  assertDealOwnerAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn((_role: string, scope: "mine" | "team" | "all" | undefined) => scope ?? "all"),
}));

vi.mock("../../../src/modules/deals/service.js", () => ({
  getDealById: vi.fn(async () => ({
    id: "deal-1",
    name: "deal-1",
    assignedRepId: "user-1",
    companyId: "company-1",
    propertyId: "property-1",
    projectType: "Commercial",
    projectTypeId: "project-type-1",
    workflowRoute: "normal",
    sourceLeadId: null,
    stageEnteredAt: new Date("2026-04-21T12:00:00.000Z"),
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
  })),
  getDeals: vi.fn(),
  getDealDetail: vi.fn(),
  createDeal: vi.fn(),
  updateDeal: vi.fn(),
  deleteDeal: vi.fn(),
  getDealsForPipeline: vi.fn(),
  getDealSources: vi.fn(),
  buildBidBoardOwnershipState: vi.fn((deal) => ({
    isOwned: deal.isBidBoardOwned,
    sourceOfTruth: deal.isBidBoardOwned ? "bid_board" : "crm",
    handoffStageSlug: "estimate_in_progress",
    downstreamStagesReadOnly: deal.isBidBoardOwned,
    canEditInCrm: ["deal details"],
    mirroredInCrm: ["stage progression"],
    reason: "stubbed",
    message: "stubbed",
  })),
  getEstimatingBoundaryStage: vi.fn(async () => ({
    id: "stage-estimate-in-progress",
    slug: "estimate_in_progress",
    displayOrder: 1,
  })),
  getRequiredEstimatingBoundaryStage: vi.fn(async () => ({
    id: "stage-estimate-in-progress",
    slug: "estimate_in_progress",
    displayOrder: 1,
  })),
  isBidBoardOwnedDownstreamStage: vi.fn(
    (stage, boundary) => Boolean(boundary) && stage.displayOrder > boundary.displayOrder
  ),
  BID_BOARD_STAGE_READ_ONLY_MESSAGE:
    "Deal stage progression is read-only in CRM after estimating handoff. Bid Board is now the source of truth for downstream stages.",
}));

vi.mock("../../../src/modules/deals/stage-change.js", () => ({
  changeDealStage: vi.fn(),
  activateServiceHandoff: vi.fn(),
}));

vi.mock("../../../src/modules/deals/stage-gate.js", () => ({
  preflightStageCheck: vi.fn(),
}));

vi.mock("../../../src/modules/contacts/association-service.js", () => ({
  getContactsForDeal: vi.fn(),
}));

vi.mock("../../../src/modules/deals/scoping-service.js", () => ({
  assertDealScopingWriteAllowed: vi.fn(),
  getOrCreateDealScopingIntake: vi.fn(),
  upsertDealScopingIntake: vi.fn(),
  evaluateDealScopingReadiness: vi.fn(),
  linkDealFileToScopingRequirement: vi.fn(),
}));

vi.mock("../../../src/modules/deals/lineage-resolver.js", () => ({
  getResolvedDeal: vi.fn(async () => ({
    resolved: {
      assignedRepId: "user-1",
      companyId: "company-1",
      projectTypeId: "project-type-1",
      propertyId: "property-1",
      propertyName: "Property One",
      workflowRoute: "normal",
      siteVisitDecision: "scheduled",
      preBidMeetingCompleted: "completed",
      siteVisitCompleted: "completed",
      estimatorConsultationNotes: "Existing notes",
    },
  })),
  writeResolvedDealFields: vi.fn(),
}));
vi.mock("../../../src/lib/audit-log.js", () => ({
  writeAuditLog: auditMocks.writeAuditLog,
}));

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  assertDealOwnerAccess: accessMocks.assertDealOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
}));

vi.mock("../../../src/modules/deals/workflow-backfill.js", () => ({
  inferDealBidBoardOwnership: vi.fn(() => ({
    isBidBoardOwned: false,
  })),
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const scopingService = await import("../../../src/modules/deals/scoping-service.js");
const lineageResolver = await import("../../../src/modules/deals/lineage-resolver.js");
const stageChange = await import("../../../src/modules/deals/stage-change.js");
const dealService = await import("../../../src/modules/deals/service.js");
const workflowBackfill = await import("../../../src/modules/deals/workflow-backfill.js");

function findRouteHandler(method: "get" | "patch" | "post", path: string) {
  const layer = (dealRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }

  const routeLayer = layer.route.stack.find((entry: any) => entry.method === method);
  if (!routeLayer) {
    throw new Error(`Route handler ${method.toUpperCase()} ${path} not found`);
  }

  return routeLayer.handle;
}

function createTenantDbMock(options?: { scopingSectionData?: Record<string, unknown> | null }) {
  return {
    execute: vi.fn(async () => ({ rows: [] })),
    select: vi.fn((selection?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            if (selection && Object.prototype.hasOwnProperty.call(selection, "sectionData")) {
              return options?.scopingSectionData === undefined
                ? []
                : [{ sectionData: options.scopingSectionData }];
            }
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async () => ({})),
    })),
  };
}

function createTenantDbMockWithProperty(propertyCompanyId = "company-1") {
  const tenantDb = createTenantDbMock();
  tenantDb.select = vi.fn((selection?: Record<string, unknown>) => {
    if (selection && Object.prototype.hasOwnProperty.call(selection, "companyId")) {
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{
              companyId: propertyCompanyId,
              address: "5000 Triangle Pkwy",
              city: "Peachtree Corners",
              state: "GA",
              zip: "30092",
            }]),
          })),
        })),
      };
    }
    return createTenantDbMock().select(selection);
  });
  return tenantDb;
}

async function invokeRoute(
  method: "get" | "patch" | "post",
  path: string,
  options?: { params?: Record<string, string>; query?: Record<string, string>; body?: any; user?: any; tenantDb?: any }
) {
  const handler = findRouteHandler(method, path);
  const req = {
    params: options?.params ?? {},
    query: options?.query ?? {},
    body: options?.body ?? {},
    tenantDb: options?.tenantDb ?? createTenantDbMock(),
    officeSlug: "office-a",
    user: options?.user ?? {
      id: "user-1",
      role: "director",
      officeId: "office-1",
      activeOfficeId: "office-1",
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
  const next = vi.fn((err?: unknown) => {
    if (err) {
      throw err;
    }
  });

  await handler(req, res, next);
  return { req, res, next };
}

describe("Deal Scoping Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMocks.assertDealCollaboratorAccess.mockResolvedValue({
      id: "deal-1",
      assignedRepId: "user-1",
      officeId: "office-1",
    });
    accessMocks.assertDealOwnerAccess.mockResolvedValue({
      id: "deal-1",
      assignedRepId: "user-1",
      officeId: "office-1",
    });
    vi.mocked(dealService.getDealById).mockImplementation(async () => ({
      id: "deal-1",
      name: "deal-1",
      assignedRepId: "user-1",
      companyId: "company-1",
      propertyId: "property-1",
      projectType: "Commercial",
      projectTypeId: "project-type-1",
      workflowRoute: "normal",
      sourceLeadId: null,
      stageEnteredAt: new Date("2026-04-21T12:00:00.000Z"),
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
    }) as never);
    vi.mocked(lineageResolver.getResolvedDeal).mockImplementation(async () => ({
      resolved: {
        assignedRepId: "user-1",
        companyId: "company-1",
        projectTypeId: "project-type-1",
        propertyId: "property-1",
        propertyName: "Property One",
        workflowRoute: "normal",
        siteVisitDecision: "scheduled",
        preBidMeetingCompleted: "completed",
        siteVisitCompleted: "completed",
        estimatorConsultationNotes: "Existing notes",
      },
    }) as never);
  });

  it("loads or initializes the scoping intake for a deal", async () => {
    vi.mocked(scopingService.getOrCreateDealScopingIntake).mockResolvedValueOnce({
      intake: { id: "intake-1", status: "draft" },
      readiness: { status: "draft", errors: { sections: {}, attachments: {} }, completionState: {}, requiredSections: [], requiredAttachmentKeys: [] },
    } as never);

    const { req, res } = await invokeRoute("get", "/:id/scoping-intake", { params: { id: "deal-1" } });

    expect(scopingService.getOrCreateDealScopingIntake).toHaveBeenCalledWith(req.tenantDb, "deal-1", "user-1");
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.intake.status).toBe("draft");
  });

  it("checks deal access before scoping read/write routes call raw scoping services", async () => {
    accessMocks.assertDealCollaboratorAccess
      .mockRejectedValueOnce({ statusCode: 403 })
      .mockRejectedValueOnce({ statusCode: 403 });
    accessMocks.assertDealOwnerAccess.mockRejectedValueOnce({ statusCode: 403 });

    await expect(
      invokeRoute("get", "/:id/scoping-intake", { params: { id: "deal-locked" } })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      invokeRoute("patch", "/:id/scoping-intake", {
        params: { id: "deal-locked" },
        body: { sectionData: { scopeSummary: { summary: "No access" } } },
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      invokeRoute("patch", "/:id/resolved-fields", {
        params: { id: "deal-locked" },
        body: { description: "No access" },
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(scopingService.getOrCreateDealScopingIntake).not.toHaveBeenCalled();
    expect(scopingService.upsertDealScopingIntake).not.toHaveBeenCalled();
    expect(lineageResolver.writeResolvedDealFields).not.toHaveBeenCalled();
  });

  it("threads scope through the pipeline board route", async () => {
    vi.mocked(dealService.getDealsForPipeline).mockResolvedValueOnce({
      pipelineColumns: [],
      terminalStages: [],
    } as never);

    const { req } = await invokeRoute("get", "/pipeline", {
      query: {
        scope: "team",
        includeDd: "true",
        previewLimit: "1000",
        won_since: "2026-01-01",
        won_period_from: "2026-04-01",
        won_period_to: "2026-04-30",
      },
    });

    expect(dealService.getDealsForPipeline).toHaveBeenCalledWith(
      req.tenantDb,
      "director",
      "user-1",
      expect.objectContaining({
        scope: "team",
        includeDd: true,
        previewLimit: 1000,
        wonSince: "2026-01-01",
        wonPeriodFrom: "2026-04-01",
        wonPeriodTo: "2026-04-30",
      })
    );
  });

  it("patches the scoping intake for a deal", async () => {
    vi.mocked(scopingService.upsertDealScopingIntake).mockResolvedValueOnce({
      intake: { id: "intake-1", status: "ready" },
      readiness: { status: "ready", errors: { sections: {}, attachments: {} }, completionState: {}, requiredSections: [], requiredAttachmentKeys: [] },
    } as never);

    const { req, res } = await invokeRoute("patch", "/:id/scoping-intake", {
      params: { id: "deal-1" },
      body: { workflowRoute: "normal", sectionData: { scopeSummary: { summary: "Refresh" } } },
    });

    expect(scopingService.upsertDealScopingIntake).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      { sectionData: { scopeSummary: { summary: "Refresh" } } },
      "user-1"
    );
    expect(res.body.readiness.status).toBe("ready");
  });

  it("checks the read-only scope policy before writing locked resolved scoping fields", async () => {
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockResolvedValueOnce({
      adminOverride: true,
      lockState: { locked: true, reason: "rfp_submission", submittedAt: new Date("2026-05-12T12:00:00.000Z") },
    } as never);
    vi.mocked(lineageResolver.writeResolvedDealFields).mockResolvedValueOnce({
      resolved: { siteVisitDecision: "scheduled" },
    } as never);

    const { req, res } = await invokeRoute("patch", "/:id/resolved-fields", {
      params: { id: "deal-1" },
      body: { siteVisitDecision: "reviewing", forceEditAfterRfp: true },
      user: {
        id: "user-1",
        role: "admin",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
    });

    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      { role: "admin", forceEditAfterRfp: true }
    );
    expect(lineageResolver.writeResolvedDealFields).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      { siteVisitDecision: "reviewing" },
      expect.objectContaining({ userId: "user-1", role: "admin" })
    );
    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        tableName: "deal_scoping_intake",
        recordId: "deal-1",
        changedBy: "user-1",
        fullRow: expect.objectContaining({
          override: "admin_force_edit_after_rfp",
          route: "resolved-fields",
          fields: ["siteVisitDecision"],
        }),
      })
    );
    expect(res.statusCode).toBe(200);
  });

  it("rejects direct deal patches that mutate locked scope fields after RFP lock", async () => {
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockRejectedValueOnce(
      Object.assign(new Error("Scope is read-only after RFP submission"), {
        statusCode: 403,
        code: "SCOPE_READ_ONLY_AFTER_RFP",
      })
    );

    await expect(
      invokeRoute("patch", "/:id", {
        params: { id: "deal-1" },
        body: { projectTypeId: "project-type-2" },
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });

    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      { role: "director", forceEditAfterRfp: false }
    );
    expect(dealService.updateDeal).not.toHaveBeenCalled();
  });

  it("allows direct deal patches for unlocked operational metadata after RFP lock", async () => {
    vi.mocked(dealService.updateDeal).mockResolvedValueOnce({
      id: "deal-1",
      description: "Updated description",
      expectedCloseDate: "2026-06-01",
    } as never);

    const { req, res } = await invokeRoute("patch", "/:id", {
      params: { id: "deal-1" },
      body: {
        description: "Updated description",
        expectedCloseDate: "2026-06-01",
      },
    });

    expect(scopingService.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(dealService.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({
        description: "Updated description",
        expectedCloseDate: "2026-06-01",
      }),
      "director",
      "user-1",
      "office-1"
    );
    expect(res.statusCode).toBe(200);
  });

  it("allows full-payload deal saves when locked fields are present but unchanged", async () => {
    vi.mocked(dealService.updateDeal).mockResolvedValueOnce({
      id: "deal-1",
      name: "deal-1",
      projectTypeId: "project-type-1",
      workflowRoute: "normal",
      description: "Updated description only",
    } as never);

    const { req, res } = await invokeRoute("patch", "/:id", {
      params: { id: "deal-1" },
      body: {
        name: "deal-1",
        projectTypeId: "project-type-1",
        workflowRoute: "normal",
        description: "Updated description only",
      },
    });

    expect(scopingService.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(dealService.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({
        name: "deal-1",
        projectTypeId: "project-type-1",
        workflowRoute: "normal",
        description: "Updated description only",
      }),
      "director",
      "user-1",
      "office-1"
    );
    expect(res.statusCode).toBe(200);
  });

  it("still blocks full-payload deal saves when a locked field value actually changes", async () => {
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockRejectedValueOnce(
      Object.assign(new Error("Scope is read-only after RFP submission"), {
        statusCode: 403,
        code: "SCOPE_READ_ONLY_AFTER_RFP",
      })
    );

    await expect(
      invokeRoute("patch", "/:id", {
        params: { id: "deal-1" },
        body: {
          name: "Renamed submitted deal",
          projectTypeId: "project-type-1",
          workflowRoute: "normal",
          description: "Updated description only",
        },
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });

    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      { role: "director", forceEditAfterRfp: false }
    );
    expect(dealService.updateDeal).not.toHaveBeenCalled();
  });


  it("re-checks locked deal fields against the current row before a readonly full-payload save writes stale data", async () => {
    vi.mocked(dealService.getDealById).mockResolvedValueOnce({
      id: "deal-1",
      name: "new",
      assignedRepId: "user-1",
      companyId: "company-1",
      propertyId: "property-1",
      projectType: "Commercial",
      projectTypeId: "project-type-1",
      workflowRoute: "normal",
      sourceLeadId: null,
    } as never);
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockRejectedValueOnce(
      Object.assign(new Error("Scope is read-only after RFP submission"), {
        statusCode: 403,
        code: "SCOPE_READ_ONLY_AFTER_RFP",
      })
    );

    const tenantDb = createTenantDbMock();

    await expect(
      invokeRoute("patch", "/:id", {
        params: { id: "deal-1" },
        tenantDb,
        body: {
          name: "old",
          description: "Readonly save payload",
        },
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });

    expect(tenantDb.execute).toHaveBeenCalled();
    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      tenantDb,
      "deal-1",
      { role: "director", forceEditAfterRfp: false }
    );
    expect(dealService.updateDeal).not.toHaveBeenCalled();
  });

  it("treats direct deal name updates as scope-locked after RFP lock", async () => {
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockRejectedValueOnce(
      Object.assign(new Error("Scope is read-only after RFP submission"), {
        statusCode: 403,
        code: "SCOPE_READ_ONLY_AFTER_RFP",
      })
    );

    await expect(
      invokeRoute("patch", "/:id", {
        params: { id: "deal-1" },
        body: { name: "Submitted scope rename" },
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });

    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      { role: "director", forceEditAfterRfp: false }
    );
    expect(dealService.updateDeal).not.toHaveBeenCalled();
  });

  it("checks deal access before generic deal patch lock policy for locked fields", async () => {
    vi.mocked(dealService.getDealById).mockResolvedValueOnce(null as never);

    await expect(
      invokeRoute("patch", "/:id", {
        params: { id: "other-rep-deal" },
        body: { projectTypeId: "project-type-2" },
        user: {
          id: "rep-2",
          role: "rep",
          officeId: "office-1",
          activeOfficeId: "office-1",
        },
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(scopingService.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(dealService.updateDeal).not.toHaveBeenCalled();
  });

  it("allows resolved-field patches for unlocked operational metadata after RFP lock", async () => {
    vi.mocked(lineageResolver.writeResolvedDealFields).mockResolvedValueOnce({
      resolved: { assignedRepId: "rep-2" },
    } as never);

    const { req, res } = await invokeRoute("patch", "/:id/resolved-fields", {
      params: { id: "deal-1" },
      body: { assignedRepId: "rep-2" },
    });

    expect(scopingService.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(lineageResolver.writeResolvedDealFields).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      { assignedRepId: "rep-2" },
      expect.objectContaining({ userId: "user-1", role: "director" })
    );
    expect(res.statusCode).toBe(200);
  });

  it("allows full-payload resolved-field saves when locked fields are present but unchanged", async () => {
    vi.mocked(lineageResolver.writeResolvedDealFields).mockResolvedValueOnce({
      resolved: { assignedRepId: "rep-2" },
    } as never);

    const tenantDb = createTenantDbMock({
      scopingSectionData: {
        opportunity: {
          siteVisitDecision: "scheduled",
          preBidMeetingCompleted: "completed",
          siteVisitCompleted: "completed",
          estimatorConsultationNotes: "Existing notes",
        },
      },
    });

    const { req, res } = await invokeRoute("patch", "/:id/resolved-fields", {
      params: { id: "deal-1" },
      tenantDb,
      body: {
        assignedRepId: "rep-2",
        companyId: "company-1",
        projectTypeId: "project-type-1",
        propertyId: "property-1",
        propertyName: "Property One",
        workflowRoute: "normal",
        siteVisitDecision: "scheduled",
        preBidMeetingCompleted: "completed",
        siteVisitCompleted: "completed",
        estimatorConsultationNotes: "Existing notes",
      },
    });

    expect(scopingService.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(lineageResolver.writeResolvedDealFields).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({
        assignedRepId: "rep-2",
        companyId: "company-1",
        projectTypeId: "project-type-1",
      }),
      expect.objectContaining({ userId: "user-1", role: "director" })
    );
    expect(res.statusCode).toBe(200);
  });

  it("allows resolved-field relationship fill-in when company and property are currently missing", async () => {
    vi.mocked(lineageResolver.getResolvedDeal).mockResolvedValueOnce({
      resolved: {
        assignedRepId: "user-1",
        companyId: null,
        projectTypeId: "project-type-1",
        propertyId: null,
        propertyName: "Property One",
        workflowRoute: "normal",
      },
    } as never);
    vi.mocked(lineageResolver.writeResolvedDealFields).mockResolvedValueOnce({
      resolved: { companyId: "company-1", propertyId: "property-1" },
    } as never);

    const tenantDb = createTenantDbMockWithProperty();

    const { req, res } = await invokeRoute("patch", "/:id/resolved-fields", {
      params: { id: "deal-1" },
      tenantDb,
      body: {
        companyId: "company-1",
        propertyId: "property-1",
      },
    });

    expect(scopingService.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(lineageResolver.writeResolvedDealFields).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({
        companyId: "company-1",
        propertyId: "property-1",
      }),
      expect.objectContaining({ userId: "user-1", role: "director" })
    );
    expect(res.statusCode).toBe(200);
  });

  it("allows locked resolved-field edits during cleanup relationship repair and tags the scope audit", async () => {
    vi.mocked(dealService.getDealById).mockResolvedValue({
      id: "deal-1",
      name: "Legacy Cleanup Deal",
      assignedRepId: "user-1",
      companyId: null,
      propertyId: null,
      projectType: "Commercial",
      projectTypeId: "project-type-1",
      workflowRoute: "normal",
      sourceLeadId: null,
      stageEnteredAt: new Date("2026-04-21T12:00:00.000Z"),
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
    } as never);
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockResolvedValueOnce({
      adminOverride: false,
      lockState: { locked: false, reason: null, submittedAt: null },
    } as never);
    vi.mocked(lineageResolver.getResolvedDeal).mockResolvedValueOnce({
      resolved: {
        assignedRepId: "user-1",
        companyId: null,
        projectTypeId: "project-type-1",
        propertyId: null,
        propertyName: "Property One",
        workflowRoute: "normal",
      },
    } as never);
    vi.mocked(lineageResolver.writeResolvedDealFields).mockResolvedValueOnce({
      resolved: {
        companyId: "company-1",
        propertyId: "property-1",
        projectTypeId: "project-type-2",
      },
    } as never);

    const tenantDb = createTenantDbMockWithProperty();

    const { req, res } = await invokeRoute("patch", "/:id/resolved-fields", {
      params: { id: "deal-1" },
      tenantDb,
      body: {
        companyId: "company-1",
        propertyId: "property-1",
        projectTypeId: "project-type-2",
      },
    });

    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      tenantDb,
      "deal-1",
      { role: "director", forceEditAfterRfp: false, cleanupMode: true }
    );
    expect(lineageResolver.writeResolvedDealFields).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({
        companyId: "company-1",
        propertyId: "property-1",
        projectTypeId: "project-type-2",
      }),
      expect.objectContaining({ userId: "user-1", role: "director" })
    );
    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        tableName: "deals",
        recordId: "deal-1",
        action: "legacy_cleanup_scope_change",
        changedBy: "user-1",
        entityType: "deal",
        changes: expect.objectContaining({
          projectTypeId: {
            from: "project-type-1",
            to: "project-type-2",
          },
        }),
        fullRow: expect.objectContaining({
          route: "resolved-fields",
          cleanupMode: true,
        }),
      })
    );
    expect(res.statusCode).toBe(200);
  });

  it("blocks resolved-field company replacement after the relationship is established", async () => {
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockRejectedValueOnce(
      Object.assign(new Error("Scope is read-only after RFP submission"), {
        statusCode: 403,
        code: "SCOPE_READ_ONLY_AFTER_RFP",
      })
    );

    await expect(
      invokeRoute("patch", "/:id/resolved-fields", {
        params: { id: "deal-1" },
        body: { companyId: "company-2" },
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });

    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      { role: "director", forceEditAfterRfp: false }
    );
    expect(lineageResolver.writeResolvedDealFields).not.toHaveBeenCalled();
  });

  it("still blocks locked resolved-field edits on non-legacy deals when relationship keys are merely present", async () => {
    vi.mocked(dealService.getDealById).mockResolvedValue({
      id: "deal-1",
      name: "Non Legacy Deal",
      assignedRepId: "user-1",
      companyId: "company-1",
      propertyId: "property-1",
      projectType: "Commercial",
      projectTypeId: "project-type-1",
      workflowRoute: "normal",
      sourceLeadId: "lead-1",
      stageEnteredAt: new Date("2026-04-21T12:00:00.000Z"),
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
    } as never);
    vi.mocked(lineageResolver.getResolvedDeal).mockResolvedValueOnce({
      resolved: {
        assignedRepId: "user-1",
        companyId: "company-1",
        projectTypeId: "project-type-1",
        propertyId: "property-1",
        propertyName: "Property One",
        workflowRoute: "normal",
      },
    } as never);
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockRejectedValueOnce(
      Object.assign(new Error("Scope is read-only after RFP submission"), {
        statusCode: 403,
        code: "SCOPE_READ_ONLY_AFTER_RFP",
      })
    );

    await expect(
      invokeRoute("patch", "/:id/resolved-fields", {
        params: { id: "deal-1" },
        body: {
          companyId: "company-1",
          projectTypeId: "project-type-2",
        },
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });

    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      { role: "director", forceEditAfterRfp: false }
    );
    expect(lineageResolver.writeResolvedDealFields).not.toHaveBeenCalled();
  });

  it("blocks resolved-field company replacement even when an admin forces post-RFP edits", async () => {
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockResolvedValueOnce({
      adminOverride: true,
      lockState: { locked: true, reason: "rfp_submission", submittedAt: new Date("2026-05-12T12:00:00.000Z") },
    } as never);

    await expect(
      invokeRoute("patch", "/:id/resolved-fields", {
        params: { id: "deal-1" },
        body: { companyId: "company-2", forceEditAfterRfp: true },
        user: {
          id: "admin-1",
          role: "admin",
          officeId: "office-1",
          activeOfficeId: "office-1",
        },
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "companyId is immutable once established",
    });

    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      { role: "admin", forceEditAfterRfp: true }
    );
    expect(lineageResolver.writeResolvedDealFields).not.toHaveBeenCalled();
  });

  it("blocks resolved-field property replacement after the relationship is established", async () => {
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockRejectedValueOnce(
      Object.assign(new Error("Scope is read-only after RFP submission"), {
        statusCode: 403,
        code: "SCOPE_READ_ONLY_AFTER_RFP",
      })
    );

    await expect(
      invokeRoute("patch", "/:id/resolved-fields", {
        params: { id: "deal-1" },
        body: { propertyId: "property-2" },
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });

    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      { role: "director", forceEditAfterRfp: false }
    );
    expect(lineageResolver.writeResolvedDealFields).not.toHaveBeenCalled();
  });

  it("allows filling only the missing resolved-field relationship and keeps the established one locked", async () => {
    vi.mocked(lineageResolver.getResolvedDeal).mockResolvedValueOnce({
      resolved: {
        assignedRepId: "user-1",
        companyId: "company-1",
        projectTypeId: "project-type-1",
        propertyId: null,
        propertyName: "Property One",
        workflowRoute: "normal",
      },
    } as never);
    vi.mocked(lineageResolver.writeResolvedDealFields).mockResolvedValueOnce({
      resolved: { companyId: "company-1", propertyId: "property-1" },
    } as never);

    const tenantDb = createTenantDbMockWithProperty();

    const { res } = await invokeRoute("patch", "/:id/resolved-fields", {
      params: { id: "deal-1" },
      tenantDb,
      body: {
        companyId: "company-1",
        propertyId: "property-1",
      },
    });

    expect(scopingService.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("rejects resolved-field relationship fill-in when the selected property belongs to a different company", async () => {
    vi.mocked(lineageResolver.getResolvedDeal).mockResolvedValueOnce({
      resolved: {
        assignedRepId: "user-1",
        companyId: null,
        projectTypeId: "project-type-1",
        propertyId: null,
        propertyName: "Property One",
        workflowRoute: "normal",
      },
    } as never);

    const tenantDb = createTenantDbMockWithProperty("company-2");

    await expect(
      invokeRoute("patch", "/:id/resolved-fields", {
        params: { id: "deal-1" },
        tenantDb,
        body: {
          companyId: "company-1",
          propertyId: "property-1",
        },
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Property does not belong to the company",
    });

    expect(lineageResolver.writeResolvedDealFields).not.toHaveBeenCalled();
  });

  it("still rejects cleanup resolved-field repairs when the selected property belongs to a different company", async () => {
    vi.mocked(dealService.getDealById).mockResolvedValue({
      id: "deal-1",
      name: "Legacy Cleanup Deal",
      assignedRepId: "user-1",
      companyId: null,
      propertyId: null,
      projectType: "Commercial",
      projectTypeId: "project-type-1",
      workflowRoute: "normal",
      sourceLeadId: null,
      stageEnteredAt: new Date("2026-04-21T12:00:00.000Z"),
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
    } as never);
    vi.mocked(lineageResolver.getResolvedDeal).mockResolvedValueOnce({
      resolved: {
        assignedRepId: "user-1",
        companyId: null,
        projectTypeId: "project-type-1",
        propertyId: null,
        propertyName: "Property One",
        workflowRoute: "normal",
      },
    } as never);

    const tenantDb = createTenantDbMockWithProperty("company-2");

    await expect(
      invokeRoute("patch", "/:id/resolved-fields", {
        params: { id: "deal-1" },
        tenantDb,
        body: {
          companyId: "company-1",
          propertyId: "property-1",
          projectTypeId: "project-type-2",
        },
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Property does not belong to the company",
    });

    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      tenantDb,
      "deal-1",
      { role: "director", forceEditAfterRfp: false, cleanupMode: true }
    );
    expect(lineageResolver.writeResolvedDealFields).not.toHaveBeenCalled();
  });

  it("does not activate cleanup mode on resolved-fields when relationship ids are unchanged", async () => {
    vi.mocked(dealService.getDealById).mockResolvedValue({
      id: "deal-1",
      name: "Legacy With Established Relationships",
      assignedRepId: "user-1",
      companyId: "company-1",
      propertyId: "property-1",
      projectType: "Commercial",
      projectTypeId: "project-type-1",
      workflowRoute: "normal",
      sourceLeadId: null,
      stageEnteredAt: new Date("2026-04-21T12:00:00.000Z"),
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
    } as never);
    vi.mocked(lineageResolver.getResolvedDeal).mockResolvedValueOnce({
      resolved: {
        assignedRepId: "user-1",
        companyId: "company-1",
        projectTypeId: "project-type-1",
        propertyId: "property-1",
        propertyName: "Property One",
        workflowRoute: "normal",
      },
    } as never);
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockRejectedValueOnce(
      Object.assign(new Error("Scope is read-only after RFP submission"), {
        statusCode: 403,
        code: "SCOPE_READ_ONLY_AFTER_RFP",
      })
    );

    await expect(
      invokeRoute("patch", "/:id/resolved-fields", {
        params: { id: "deal-1" },
        body: {
          companyId: "company-1",
          propertyId: "property-1",
          projectTypeId: "project-type-2",
        },
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });

    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      { role: "director", forceEditAfterRfp: false }
    );
    expect(lineageResolver.writeResolvedDealFields).not.toHaveBeenCalled();
  });

  it("rejects resolved-fields cleanup when only one missing relationship is repaired", async () => {
    vi.mocked(dealService.getDealById).mockResolvedValue({
      id: "deal-1",
      name: "Legacy Missing Relationships",
      assignedRepId: "user-1",
      companyId: null,
      propertyId: null,
      projectType: "Commercial",
      projectTypeId: "project-type-1",
      workflowRoute: "normal",
      sourceLeadId: null,
      stageEnteredAt: new Date("2026-04-21T12:00:00.000Z"),
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
    } as never);
    vi.mocked(lineageResolver.getResolvedDeal).mockResolvedValueOnce({
      resolved: {
        assignedRepId: "user-1",
        companyId: null,
        projectTypeId: "project-type-1",
        propertyId: null,
        propertyName: "Property One",
        workflowRoute: "normal",
      },
    } as never);
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockRejectedValueOnce(
      Object.assign(new Error("Scope is read-only after RFP submission"), {
        statusCode: 403,
        code: "SCOPE_READ_ONLY_AFTER_RFP",
      })
    );

    await expect(
      invokeRoute("patch", "/:id/resolved-fields", {
        params: { id: "deal-1" },
        body: {
          companyId: "company-1",
          projectTypeId: "project-type-2",
        },
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });

    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      { role: "director", forceEditAfterRfp: false }
    );
    expect(lineageResolver.writeResolvedDealFields).not.toHaveBeenCalled();
  });


  it.each([
    ["preBidMeetingCompleted", "completed"],
    ["siteVisitDecision", "scheduled"],
    ["siteVisitCompleted", "completed"],
    ["estimatorConsultationNotes", "Existing notes"],
  ] as const)(
    "allows unchanged locked resolved field %s when the current scoping baseline matches",
    async (field, value) => {
      vi.mocked(lineageResolver.getResolvedDeal).mockResolvedValueOnce({
        resolved: {
          assignedRepId: "rep-2",
          companyId: "company-1",
          projectTypeId: "project-type-1",
          propertyId: "property-1",
          propertyName: "Property One",
          workflowRoute: "normal",
        },
      } as never);
      vi.mocked(lineageResolver.writeResolvedDealFields).mockResolvedValueOnce({
        resolved: { assignedRepId: "rep-2" },
      } as never);

      const tenantDb = createTenantDbMock({
        scopingSectionData: {
          opportunity: {
            [field]: value,
          },
        },
      });

      const { res } = await invokeRoute("patch", "/:id/resolved-fields", {
        params: { id: "deal-1" },
        tenantDb,
        body: {
          assignedRepId: "rep-2",
          [field]: value,
        },
      });

      expect(scopingService.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
      expect(lineageResolver.writeResolvedDealFields).toHaveBeenCalledWith(
        tenantDb,
        "deal-1",
        expect.objectContaining({
          assignedRepId: "rep-2",
          [field]: value,
        }),
        expect.objectContaining({ userId: "user-1", role: "director" })
      );
      expect(res.statusCode).toBe(200);
    }
  );

  it.each([
    ["preBidMeetingCompleted", "completed", "required"],
    ["siteVisitDecision", "scheduled", "reviewing"],
    ["siteVisitCompleted", "completed", "pending"],
    ["estimatorConsultationNotes", "Existing notes", "Updated notes"],
  ] as const)(
    "blocks changed locked resolved field %s when the current scoping baseline differs",
    async (field, existingValue, incomingValue) => {
      vi.mocked(lineageResolver.getResolvedDeal).mockResolvedValueOnce({
        resolved: {
          assignedRepId: "rep-2",
          companyId: "company-1",
          projectTypeId: "project-type-1",
          propertyId: "property-1",
          propertyName: "Property One",
          workflowRoute: "normal",
        },
      } as never);
      vi.mocked(scopingService.assertDealScopingWriteAllowed).mockRejectedValueOnce(
        Object.assign(new Error("Scope is read-only after RFP submission"), {
          statusCode: 403,
          code: "SCOPE_READ_ONLY_AFTER_RFP",
        })
      );

      const tenantDb = createTenantDbMock({
        scopingSectionData: {
          opportunity: {
            [field]: existingValue,
          },
        },
      });

      await expect(
        invokeRoute("patch", "/:id/resolved-fields", {
          params: { id: "deal-1" },
          tenantDb,
          body: {
            [field]: incomingValue,
          },
        })
      ).rejects.toMatchObject({
        statusCode: 403,
        code: "SCOPE_READ_ONLY_AFTER_RFP",
      });

      expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
        tenantDb,
        "deal-1",
        { role: "director", forceEditAfterRfp: false }
      );
      expect(lineageResolver.writeResolvedDealFields).not.toHaveBeenCalled();
    }
  );

  it("still blocks resolved-field patches for scope-owned fields after RFP lock", async () => {
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockRejectedValueOnce(
      Object.assign(new Error("Scope is read-only after RFP submission"), {
        statusCode: 403,
        code: "SCOPE_READ_ONLY_AFTER_RFP",
      })
    );

    await expect(
      invokeRoute("patch", "/:id/resolved-fields", {
        params: { id: "deal-1" },
        body: { siteVisitDecision: "reviewing" },
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });

    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      { role: "director", forceEditAfterRfp: false }
    );
    expect(lineageResolver.writeResolvedDealFields).not.toHaveBeenCalled();
  });


  it("re-checks locked resolved fields against the current scoping row before a readonly save writes stale data", async () => {
    vi.mocked(lineageResolver.getResolvedDeal).mockResolvedValueOnce({
      resolved: {
        assignedRepId: "rep-2",
        companyId: "company-1",
        projectTypeId: "project-type-1",
        propertyId: "property-1",
        propertyName: "Property One",
        workflowRoute: "normal",
      },
    } as never);
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockRejectedValueOnce(
      Object.assign(new Error("Scope is read-only after RFP submission"), {
        statusCode: 403,
        code: "SCOPE_READ_ONLY_AFTER_RFP",
      })
    );

    const tenantDb = createTenantDbMock({
      scopingSectionData: {
        opportunity: {
          siteVisitDecision: "reviewing",
        },
      },
    });

    await expect(
      invokeRoute("patch", "/:id/resolved-fields", {
        params: { id: "deal-1" },
        tenantDb,
        body: { siteVisitDecision: "scheduled" },
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });

    expect(tenantDb.execute).toHaveBeenCalled();
    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      tenantDb,
      "deal-1",
      { role: "director", forceEditAfterRfp: false }
    );
    expect(lineageResolver.writeResolvedDealFields).not.toHaveBeenCalled();
  });

  it("audits admin-forced direct deal patches that mutate locked scope fields after RFP lock", async () => {
    vi.mocked(scopingService.assertDealScopingWriteAllowed).mockResolvedValueOnce({
      adminOverride: true,
      lockState: { locked: true, reason: "rfp_submission", submittedAt: new Date("2026-05-12T12:00:00.000Z") },
    } as never);
    vi.mocked(dealService.updateDeal).mockResolvedValueOnce({ id: "deal-1", projectTypeId: "project-type-2" } as never);

    const { req, res } = await invokeRoute("patch", "/:id", {
      params: { id: "deal-1" },
      body: { projectTypeId: "project-type-2", forceEditAfterRfp: true },
      user: {
        id: "admin-1",
        role: "admin",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
    });

    expect(scopingService.assertDealScopingWriteAllowed).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      { role: "admin", forceEditAfterRfp: true }
    );
    expect(dealService.updateDeal).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      expect.objectContaining({
        projectTypeId: "project-type-2",
        auditContext: expect.any(Object),
      }),
      "admin",
      "admin-1",
      "office-1"
    );
    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        tableName: "deal_scoping_intake",
        recordId: "deal-1",
        changedBy: "admin-1",
        fullRow: expect.objectContaining({
          override: "admin_force_edit_after_rfp",
          route: "deals",
          fields: ["projectTypeId"],
        }),
      })
    );
    expect(res.statusCode).toBe(200);
  });

  it("returns readiness for the current scoping intake", async () => {
    vi.mocked(scopingService.evaluateDealScopingReadiness).mockResolvedValueOnce({
      status: "draft",
      errors: { sections: { projectOverview: ["bidDueDate"] }, attachments: {} },
      completionState: {},
      requiredSections: ["projectOverview"],
      requiredAttachmentKeys: [],
    } as never);

    const { res } = await invokeRoute("get", "/:id/scoping-intake/readiness", { params: { id: "deal-1" } });

    expect(res.statusCode).toBe(200);
    expect(res.body.readiness.errors.sections.projectOverview).toEqual(["bidDueDate"]);
  });

  it("links an existing deal file into an intake requirement without duplicating the file row", async () => {
    vi.mocked(scopingService.linkDealFileToScopingRequirement).mockResolvedValueOnce({
      id: "file-1",
      intakeSection: "attachments",
      intakeRequirementKey: "site_photos",
    } as never);

    const { req, res } = await invokeRoute("post", "/:id/scoping-intake/attachments/link-existing", {
      params: { id: "deal-1" },
      body: { fileId: "file-1", intakeSection: "attachments", intakeRequirementKey: "site_photos" },
    });

    expect(scopingService.linkDealFileToScopingRequirement).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      {
        fileId: "file-1",
        intakeSection: "attachments",
        intakeRequirementKey: "site_photos",
        forceEditAfterRfp: false,
      },
      "user-1"
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.file.id).toBe("file-1");
  });

  it("activates service handoff through the deal route", async () => {
    vi.mocked(stageChange.activateServiceHandoff).mockResolvedValueOnce({ activated: true } as never);

    const { req, res } = await invokeRoute("post", "/:id/service-handoff/activate", {
      params: { id: "deal-1" },
    });

    expect(stageChange.activateServiceHandoff).toHaveBeenCalledWith(req.tenantDb, {
      dealId: "deal-1",
      userId: "user-1",
      userRole: "director",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.activated).toBe(true);
  });

  it("keeps preflight aligned with the Bid Board boundary lock even before the ownership flag backfills", async () => {
    const preflight = await import("../../../src/modules/deals/stage-gate.js");
    vi.mocked(preflight.preflightStageCheck).mockResolvedValueOnce({
      allowed: true,
      blockReason: null,
      currentStage: {
        id: "stage-estimate-in-progress",
        name: "Estimate in Progress",
        slug: "estimate_in_progress",
        isTerminal: false,
        displayOrder: 1,
      },
      targetStage: {
        id: "stage-estimate-in-progress-clone",
        name: "Estimate in Progress",
        slug: "estimate_in_progress",
        isTerminal: false,
        displayOrder: 1,
      },
    } as never);
    vi.mocked(workflowBackfill.inferDealBidBoardOwnership).mockReturnValueOnce({
      isBidBoardOwned: false,
    } as never);

    const { res } = await invokeRoute("post", "/:id/stage/preflight", {
      params: { id: "deal-1" },
      body: { targetStageId: "stage-estimate-in-progress-clone" },
    });

    expect(dealService.getEstimatingBoundaryStage).toHaveBeenCalledWith("normal");
    expect(res.statusCode).toBe(200);
    expect(res.body.allowed).toBe(false);
    expect(res.body.bidBoardLocked).toBe(true);
    expect(res.body.blockReason).toBe(
      "Deal stage progression is read-only in CRM after estimating handoff. Bid Board is now the source of truth for downstream stages."
    );
  });

  it("allows the CRM-owned handoff move into estimate in progress", async () => {
    const preflight = await import("../../../src/modules/deals/stage-gate.js");
    vi.mocked(preflight.preflightStageCheck).mockResolvedValueOnce({
      allowed: true,
      blockReason: null,
      currentStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
        displayOrder: 0,
      },
      targetStage: {
        id: "stage-estimate-in-progress",
        name: "Estimate in Progress",
        slug: "estimate_in_progress",
        isTerminal: false,
        displayOrder: 2,
      },
    } as never);
    vi.mocked(workflowBackfill.inferDealBidBoardOwnership).mockReturnValueOnce({
      isBidBoardOwned: false,
    } as never);

    const { res } = await invokeRoute("post", "/:id/stage/preflight", {
      params: { id: "deal-1" },
      body: { targetStageId: "stage-estimate-in-progress" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.allowed).toBe(true);
    expect(res.body.bidBoardLocked).toBe(false);
    expect(res.body.blockReason).toBeNull();
  });

  it("treats legacy estimating as the Bid Board boundary when canonical boundary config exists", async () => {
    const preflight = await import("../../../src/modules/deals/stage-gate.js");
    vi.mocked(preflight.preflightStageCheck).mockResolvedValueOnce({
      allowed: true,
      blockReason: null,
      currentStage: {
        id: "stage-estimating",
        name: "Estimating",
        slug: "estimating",
        isTerminal: false,
        displayOrder: 1,
      },
      targetStage: {
        id: "stage-bid-sent",
        name: "Estimate Sent to Client",
        slug: "estimate_sent_to_client",
        isTerminal: false,
        displayOrder: 2,
      },
    } as never);
    vi.mocked(workflowBackfill.inferDealBidBoardOwnership).mockReturnValueOnce({
      isBidBoardOwned: false,
    } as never);

    const { res } = await invokeRoute("post", "/:id/stage/preflight", {
      params: { id: "deal-1" },
      body: { targetStageId: "stage-bid-sent" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.allowed).toBe(false);
    expect(res.body.bidBoardLocked).toBe(true);
    expect(res.body.blockReason).toBe(
      "Deal stage progression is read-only in CRM after estimating handoff. Bid Board is now the source of truth for downstream stages."
    );
  });
});
