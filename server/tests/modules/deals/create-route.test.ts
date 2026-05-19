import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dealsServiceMocks = vi.hoisted(() => ({
  createDeal: vi.fn(),
}));
const pipelineServiceMocks = vi.hoisted(() => ({
  getStageBySlug: vi.fn(),
  getActiveProjectTypes: vi.fn(),
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
  };
});

vi.mock("../../../src/modules/pipeline/service.js", async () => {
  const actual = await vi.importActual("../../../src/modules/pipeline/service.js");
  return {
    ...(actual as Record<string, unknown>),
    getStageBySlug: pipelineServiceMocks.getStageBySlug,
    getActiveProjectTypes: pipelineServiceMocks.getActiveProjectTypes,
  };
});

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  assertDealOwnerAccess: accessMocks.assertDealOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");
const { AppError } = await import("../../../src/middleware/error-handler.js");

function createTenantDb(selectRows: unknown[][] = [
  [{ id: "company-1", isActive: true }],
  [{ id: "property-1", companyId: "company-1", isActive: true }],
]) {
  const queue = [...selectRows];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(queue.shift() ?? [])),
        })),
      })),
    })),
  };
}

function createApp(officeSlug: string | null = "dallas", tenantDb = createTenantDb()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      id: "admin-1",
      role: "admin",
      displayName: "Admin",
      email: "admin@example.com",
      officeId: "office-dallas",
      activeOfficeId: "office-dallas",
    };
    (req as any).officeSlug = officeSlug ?? undefined;
    (req as any).tenantDb = tenantDb;
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/deals", dealRoutes);
  app.use(errorHandler);
  return app;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "SMOKE TEST DELETE direct-create officecode",
    stageId: "stage-opportunity",
    assignedRepId: "rep-1",
    companyId: "company-1",
    propertyId: "property-1",
    ...overrides,
  };
}

describe("POST /api/deals create context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMocks.assertDealCollaboratorAccess.mockResolvedValue({
      id: "deal-1",
      assignedRepId: "rep-1",
      officeId: "office-dallas",
    });
    accessMocks.assertDealOwnerAccess.mockResolvedValue({
      id: "deal-1",
      assignedRepId: "rep-1",
      officeId: "office-dallas",
    });
    pipelineServiceMocks.getStageBySlug.mockResolvedValue({
      id: "stage-opportunity",
      name: "Opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      isTerminal: false,
    });
    pipelineServiceMocks.getActiveProjectTypes.mockResolvedValue([
      { id: "type-service", name: "Service", slug: "service", code: "4", isActive: true },
      { id: "type-roofing", name: "Roofing", slug: "roofing", code: "9", isActive: true },
    ]);
    dealsServiceMocks.createDeal.mockImplementation(async (_tenantDb, input) => {
      if (input.officeCode !== "dfw" && input.officeCode !== "atl") {
        throw new AppError(400, "officeCode must be 'dfw' or 'atl'");
      }

      return {
        id: "deal-1",
        name: "SMOKE TEST DELETE direct-create officecode",
        officeCode: input.officeCode,
        hubspotDealId: null,
      };
    });
  });

  it("auto-resolves missing officeCode from the active office slug", async () => {
    const res = await request(createApp("dallas"))
      .post("/api/deals")
      .send(validBody());

    expect(res.status).toBe(201);
    expect(dealsServiceMocks.createDeal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        officeCode: "dfw",
        officeId: "office-dallas",
        actorUserId: "admin-1",
        creationContext: "direct",
      })
    );
  });

  it("honors an explicit officeCode when it matches the selected office slug", async () => {
    const res = await request(createApp("atlanta"))
      .post("/api/deals")
      .send(validBody({ officeCode: "atl" }));

    expect(res.status).toBe(201);
    expect(dealsServiceMocks.createDeal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        officeCode: "atl",
        creationContext: "direct",
      })
    );
  });

  it("rejects explicit officeCode when it disagrees with the selected office slug", async () => {
    const res = await request(createApp("dallas"))
      .post("/api/deals")
      .send(validBody({ officeCode: "ATL" }));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Cannot create deal: officeCode must match the selected office.");
    expect(dealsServiceMocks.createDeal).not.toHaveBeenCalled();
  });

  it.each([null, 123, {}])("rejects malformed explicit officeCode %j instead of inferring", async (officeCode) => {
    const res = await request(createApp("dallas"))
      .post("/api/deals")
      .send(validBody({ officeCode }));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("officeCode must be 'dfw' or 'atl'");
    expect(dealsServiceMocks.createDeal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        officeCode: String(officeCode ?? ""),
      })
    );
  });

  it("creates a direct Service opportunity with service workflow routing and canonical Opportunity stage", async () => {
    const res = await request(createApp("dallas"))
      .post("/api/deals/service-opportunity")
      .send({
        name: "SMOKE TEST DELETE Service Opportunity",
        assignedRepId: "rep-1",
        companyId: "company-1",
        propertyId: "property-1",
        projectTypeId: "type-service",
      });

    expect(res.status).toBe(201);
    expect(pipelineServiceMocks.getStageBySlug).toHaveBeenCalledWith("opportunity", "standard_deal");
    expect(dealsServiceMocks.createDeal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "SMOKE TEST DELETE Service Opportunity",
        stageId: "stage-opportunity",
        assignedRepId: "rep-1",
        companyId: "company-1",
        propertyId: "property-1",
        projectType: "service",
        projectTypeId: "type-service",
        workflowRoute: "service",
        creationContext: "direct",
        officeCode: "dfw",
        officeId: "office-dallas",
        actorUserId: "admin-1",
        auditContext: expect.objectContaining({
          actor: expect.objectContaining({
            type: "user",
            userId: "admin-1",
          }),
        }),
      })
    );
  });

  it("rejects a non-Service project type on the Service opportunity endpoint", async () => {
    const res = await request(createApp("dallas"))
      .post("/api/deals/service-opportunity")
      .send({
        name: "Malicious Roofing Opportunity",
        assignedRepId: "rep-1",
        companyId: "company-1",
        propertyId: "property-1",
        projectTypeId: "type-roofing",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Direct-create is only available for Service projects.");
    expect(dealsServiceMocks.createDeal).not.toHaveBeenCalled();
  });

  it("rejects a Service opportunity when the property does not belong to the selected company", async () => {
    const tenantDb = createTenantDb([
      [{ id: "company-1", isActive: true }],
      [{ id: "property-1", companyId: "company-other", isActive: true }],
    ]);

    const res = await request(createApp("dallas", tenantDb))
      .post("/api/deals/service-opportunity")
      .send({
        name: "Mismatched Service Opportunity",
        assignedRepId: "rep-1",
        companyId: "company-1",
        propertyId: "property-1",
        projectTypeId: "type-service",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Property does not belong to the company");
    expect(dealsServiceMocks.createDeal).not.toHaveBeenCalled();
  });

  it("ignores hostile server-owned fields on the Service opportunity endpoint", async () => {
    const res = await request(createApp("dallas"))
      .post("/api/deals/service-opportunity")
      .send({
        name: "SMOKE TEST DELETE Service Opportunity",
        assignedRepId: "rep-1",
        companyId: "company-1",
        propertyId: "property-1",
        projectTypeId: "type-service",
        creationContext: "migration",
        migrationMode: true,
        sourceLeadWriteMode: "lead_conversion",
        sourceLeadId: "lead-1",
        officeId: "office-attacker",
        actorUserId: "user-attacker",
        workflowRoute: "normal",
        stageId: "stage-estimating",
      });

    expect(res.status).toBe(201);
    expect(dealsServiceMocks.createDeal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: "admin-1",
        officeId: "office-dallas",
        creationContext: "direct",
        stageId: "stage-opportunity",
        workflowRoute: "service",
        projectType: "service",
        projectTypeId: "type-service",
      })
    );
    expect(dealsServiceMocks.createDeal.mock.calls[0]?.[1]).not.toMatchObject({
      migrationMode: true,
      sourceLeadWriteMode: "lead_conversion",
      sourceLeadId: "lead-1",
    });
  });
});
