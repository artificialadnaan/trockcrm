import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  createLead: vi.fn(),
  deleteLead: vi.fn(),
  getLeadById: vi.fn(),
  listLeads: vi.fn(),
  transitionLeadStage: vi.fn(),
  updateLead: vi.fn(),
}));

const questionnaireMocks = vi.hoisted(() => ({
  getLeadQuestionnaireSnapshot: vi.fn(),
  isLeadEditV2Enabled: vi.fn(),
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

vi.mock("../../../src/modules/leads/questionnaire-service.js", () => ({
  getLeadQuestionnaireSnapshot: questionnaireMocks.getLeadQuestionnaireSnapshot,
  isLeadEditV2Enabled: questionnaireMocks.isLeadEditV2Enabled,
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

  vi.doMock("../../../src/modules/leads/questionnaire-service.js", () => ({
    getLeadQuestionnaireSnapshot: questionnaireMocks.getLeadQuestionnaireSnapshot,
    isLeadEditV2Enabled: questionnaireMocks.isLeadEditV2Enabled,
  }));

  const { leadRoutes } = await import("../../../src/modules/leads/routes.js");
  return leadRoutes;
}

function findRouteHandler(routes: unknown, method: "get" | "post", path: string) {
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

async function invokeLeadRoute(body: Record<string, unknown>, leadRoutes?: unknown) {
  const routes = leadRoutes ?? (await loadLeadRoutes());
  const handler = findRouteHandler(routes, "post", "/:id/stage-transition");
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

async function invokeLeadDetailRoute(leadRoutes?: unknown) {
  const routes = leadRoutes ?? (await loadLeadRoutes());
  const handler = findRouteHandler(routes, "get", "/:id");
  let committed = false;
  const req = {
    params: { id: "lead-1" },
    tenantDb: {},
    user: {
      id: "rep-1",
      role: "rep",
      activeOfficeId: "office-1",
    },
    commitTransaction: vi.fn(async () => {
      committed = true;
    }),
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

  questionnaireMocks.getLeadQuestionnaireSnapshot.mockImplementation(async () => {
    if (committed) {
      throw new Error("questionnaire fetched after commit");
    }

    return {
      projectTypeId: "project-type-1",
      nodes: [],
      allNodes: [],
      answers: {},
    };
  });

  await handler(req, res, next);
  return { req, res, next };
}

describe("lead stage transition route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    questionnaireMocks.isLeadEditV2Enabled.mockReturnValue(false);
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

  it("serializes LeadStageTransitionError from POST /api/leads/:id/stage-transition as a 409", async () => {
    const leadRoutes = await loadLeadRoutes();
    const { LeadStageTransitionError } = await import(
      "../../../src/modules/leads/stage-transition-service.js"
    );

    serviceMocks.transitionLeadStage.mockRejectedValueOnce(
      new LeadStageTransitionError({
        allowed: false,
        code: "LEAD_STAGE_REQUIREMENTS_UNMET",
        message: "Complete the lead intake fields before moving this lead to Qualified Lead.",
        currentStage: {
          id: "stage-new-lead",
          name: "New Lead",
          slug: "new_lead",
          isTerminal: false,
          displayOrder: 10,
        },
        targetStage: {
          id: "stage-qualified-lead",
          name: "Qualified Lead",
          slug: "qualified_lead",
          isTerminal: false,
          displayOrder: 20,
        },
        missingRequirements: {
          prerequisiteFields: ["qualificationPayload.existing_customer_status"],
          qualificationFields: [],
          projectTypeQuestionIds: [],
        },
      })
    );

    const { res } = await invokeLeadRoute({ targetStageId: "stage-qualified-lead" }, leadRoutes);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: {
        message: "Complete the lead intake fields before moving this lead to Qualified Lead.",
        code: "LEAD_STAGE_REQUIREMENTS_UNMET",
        missingRequirements: {
          prerequisiteFields: ["qualificationPayload.existing_customer_status"],
          qualificationFields: [],
          projectTypeQuestionIds: [],
        },
        currentStage: {
          id: "stage-new-lead",
          name: "New Lead",
          slug: "new_lead",
          isTerminal: false,
          displayOrder: 10,
        },
        targetStage: {
          id: "stage-qualified-lead",
          name: "Qualified Lead",
          slug: "qualified_lead",
          isTerminal: false,
          displayOrder: 20,
        },
      },
    });
  });

  it("loads questionnaire data before commit when lead edit v2 is enabled", async () => {
    const leadRoutes = await loadLeadRoutes();
    questionnaireMocks.isLeadEditV2Enabled.mockReturnValue(true);
    serviceMocks.getLeadById.mockResolvedValueOnce({
      id: "lead-1",
      name: "Lead One",
      stageId: "stage-1",
      projectTypeId: "project-type-1",
    });

    const { req, res } = await invokeLeadDetailRoute(leadRoutes);

    expect(serviceMocks.getLeadById).toHaveBeenCalledWith(req.tenantDb, "lead-1", "rep", "rep-1");
    expect(questionnaireMocks.getLeadQuestionnaireSnapshot).toHaveBeenCalledWith(req.tenantDb, {
      leadId: "lead-1",
      projectTypeId: "project-type-1",
    });
    expect(req.commitTransaction).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({
      lead: {
        id: "lead-1",
        name: "Lead One",
        stageId: "stage-1",
        projectTypeId: "project-type-1",
        leadQuestionnaire: {
          projectTypeId: "project-type-1",
          nodes: [],
          allNodes: [],
          answers: {},
        },
      },
    });
  });
});
