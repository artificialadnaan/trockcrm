import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("@trock-crm/shared/types", async () => import("../../../../shared/src/types/index.js"));

const serviceMocks = vi.hoisted(() => ({
  getLeadById: vi.fn(),
}));

const questionnaireMocks = vi.hoisted(() => ({
  getLeadQuestionnaireSnapshot: vi.fn(),
  isLeadEditV2Enabled: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  assertLeadCollaboratorAccess: vi.fn(),
  assertLeadOwnerAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn((_role: string, scope: "mine" | "team" | "all" | undefined) => scope ?? "all"),
}));

vi.mock("../../../src/modules/leads/service.js", () => ({
  getLeadById: serviceMocks.getLeadById,
  listLeads: vi.fn(),
  createLead: vi.fn(),
  updateLead: vi.fn(),
  deleteLead: vi.fn(),
  transitionLeadStage: vi.fn(),
}));

vi.mock("../../../src/modules/leads/questionnaire-service.js", () => ({
  getLeadQuestionnaireSnapshot: questionnaireMocks.getLeadQuestionnaireSnapshot,
  getQuestionnaireTemplateSnapshot: vi.fn(),
  isLeadEditV2Enabled: questionnaireMocks.isLeadEditV2Enabled,
}));

vi.mock("../../../src/modules/leads/due-diligence-service.js", () => ({
  assertSafeOfficeSlug: vi.fn(),
  dispatchPendingDueDiligenceEmail: vi.fn(),
  getLeadDueDiligenceApprovalForLead: vi.fn(),
}));

vi.mock("../../../src/modules/leads/conversion-service.js", () => ({
  convertLead: vi.fn(),
}));

vi.mock("../../../src/db.js", () => ({
  pool: {
    connect: vi.fn(),
  },
}));

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertLeadCollaboratorAccess: accessMocks.assertLeadCollaboratorAccess,
  assertLeadOwnerAccess: accessMocks.assertLeadOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
}));

const { leadRoutes } = await import("../../../src/modules/leads/routes.js");

function findRouteHandler(method: "get" | "post" | "delete", path: string) {
  const layer = (leadRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  const routeLayer = layer.route.stack.find((entry: any) => entry.method === method);
  if (!routeLayer) {
    throw new Error(`Route handler ${method.toUpperCase()} ${path} not found`);
  }
  return routeLayer.handle as (req: any, res: any, next: (err?: unknown) => void) => unknown;
}

function createTenantDb(selectRows: unknown[][] = []) {
  const queue = [...selectRows];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => queue.shift() ?? []),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(async () => ({})),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => ({})),
      })),
    })),
  };
}

async function invokeRoute(
  method: "get" | "post" | "delete",
  path: string,
  options: { selectRows?: unknown[][] } = {}
) {
  const handler = findRouteHandler(method, path);
  const req = {
    params: { id: "lead-1" },
    query: {},
    body: {},
    tenantDb: createTenantDb(options.selectRows),
    user: {
      id: "rep-2",
      role: "rep",
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
    if (err) throw err;
  });

  await handler(req, res, next);
  return { req, res };
}

describe("lead watch routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMocks.assertLeadCollaboratorAccess.mockResolvedValue({
      id: "lead-1",
      assignedRepId: "rep-1",
      officeId: "office-1",
    });
    questionnaireMocks.isLeadEditV2Enabled.mockReturnValue(false);
    serviceMocks.getLeadById.mockResolvedValue({
      id: "lead-1",
      assignedRepId: "rep-1",
      name: "Watched lead",
      projectTypeId: null,
    });
  });

  it("returns watch state on lead detail reads", async () => {
    const { req, res } = await invokeRoute("get", "/:id", { selectRows: [[{ id: "sub-1" }]] });

    expect(accessMocks.assertLeadCollaboratorAccess).toHaveBeenCalledWith(req.tenantDb, "lead-1", req.user);
    expect(res.body.lead).toMatchObject({
      id: "lead-1",
      isWatching: true,
    });
  });

  it("upserts a watch subscription", async () => {
    const { req, res } = await invokeRoute("post", "/:id/watch");

    expect(accessMocks.assertLeadCollaboratorAccess).toHaveBeenCalledWith(req.tenantDb, "lead-1", req.user);
    expect(req.tenantDb.insert).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ watching: true });
  });

  it("soft deletes an existing watch subscription", async () => {
    const { req, res } = await invokeRoute("delete", "/:id/watch");

    expect(accessMocks.assertLeadCollaboratorAccess).toHaveBeenCalledWith(req.tenantDb, "lead-1", req.user);
    expect(req.tenantDb.update).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ watching: false });
  });
});
