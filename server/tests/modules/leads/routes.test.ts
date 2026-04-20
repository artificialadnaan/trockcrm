import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  createLead: vi.fn(),
  deleteLead: vi.fn(),
  getLeadById: vi.fn(),
  listLeads: vi.fn(),
  transitionLeadStage: vi.fn(),
  updateLead: vi.fn(),
}));

vi.mock("../../../src/modules/leads/service.js", () => ({
  createLead: serviceMocks.createLead,
  deleteLead: serviceMocks.deleteLead,
  getLeadById: serviceMocks.getLeadById,
  listLeads: serviceMocks.listLeads,
  transitionLeadStage: serviceMocks.transitionLeadStage,
  updateLead: serviceMocks.updateLead,
}));

vi.mock("../../../src/modules/leads/conversion-service.js", () => ({
  convertLead: vi.fn(),
}));

async function loadLeadRoutes() {
  vi.resetModules();

  vi.doMock("../../../src/modules/leads/service.js", () => ({
    createLead: serviceMocks.createLead,
    deleteLead: serviceMocks.deleteLead,
    getLeadById: serviceMocks.getLeadById,
    listLeads: serviceMocks.listLeads,
    transitionLeadStage: serviceMocks.transitionLeadStage,
    updateLead: serviceMocks.updateLead,
  }));

  vi.doMock("../../../src/modules/leads/conversion-service.js", () => ({
    convertLead: vi.fn(),
  }));

  const { leadRoutes } = await import("../../../src/modules/leads/routes.js");
  return leadRoutes;
}

function findRouteHandler(routes: unknown, method: "post", path: string) {
  const layer = (routes as any).stack.find(
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

async function invokeLeadRoute(body: Record<string, unknown>) {
  const leadRoutes = await loadLeadRoutes();
  const handler = findRouteHandler(leadRoutes, "post", "/:id/stage-transition");
  const req = {
    params: { id: "lead-1" },
    body,
    tenantDb: {},
    user: {
      id: "rep-1",
      role: "rep",
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
  return { req, res, next };
}

describe("lead stage transition route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the structured blocked-move payload from POST /api/leads/:id/stage-transition", async () => {
    serviceMocks.transitionLeadStage.mockResolvedValueOnce({
      ok: false,
      reason: "missing_requirements",
      targetStageId: "stage-qualified-lead",
      resolution: "inline",
      missing: [
        { key: "source", label: "Lead source", resolution: "inline" },
        { key: "qualificationScope", label: "Project scope / category", resolution: "inline" },
      ],
    });

    const { req, res } = await invokeLeadRoute({ targetStageId: "stage-qualified-lead" });

    expect(serviceMocks.transitionLeadStage).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        leadId: "lead-1",
        targetStageId: "stage-qualified-lead",
        userId: "rep-1",
        userRole: "rep",
        officeId: "office-1",
      })
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      reason: "missing_requirements",
      targetStageId: "stage-qualified-lead",
      resolution: "inline",
      missing: [
        { key: "source", label: "Lead source", resolution: "inline" },
        { key: "qualificationScope", label: "Project scope / category", resolution: "inline" },
      ],
    });
  });
});
