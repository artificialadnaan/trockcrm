import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("@trock-crm/shared/types", async () => import("../../../../shared/src/types/index.js"));

const serviceMocks = vi.hoisted(() => ({
  createLead: vi.fn(),
  deleteLead: vi.fn(),
  getLeadById: vi.fn(),
  listLeads: vi.fn(),
  transitionLeadStage: vi.fn(),
  updateLead: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  poolConnect: vi.fn(),
}));

const dueDiligenceMocks = vi.hoisted(() => ({
  assertSafeOfficeSlug: vi.fn(),
  dispatchPendingDueDiligenceEmail: vi.fn(),
  getLeadDueDiligenceApprovalForLead: vi.fn(),
}));
const auditMocks = vi.hoisted(() => ({
  logActivity: vi.fn(),
  buildAuditActorFromUser: vi.fn((user: { userId: string; role: string }) => user),
}));
const TARGET_REP_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_REP_ID = "00000000-0000-4000-8000-000000000003";

class TestLeadCreateRequirementsError extends Error {
  statusCode = 400;
  code = "LEAD_CREATE_REQUIREMENTS_UNMET";
  missingRequirements: { fields: Array<{ key: string; label: string }> };

  constructor(fields: Array<{ key: string; label: string }> = [{ key: "budgetStatus", label: "Budget status" }]) {
    super("Complete required lead creation fields before creating a lead.");
    this.missingRequirements = { fields };
  }
}

const questionnaireMocks = vi.hoisted(() => ({
  getLeadQuestionnaireSnapshot: vi.fn(),
  getQuestionnaireTemplateSnapshot: vi.fn(),
  isLeadEditV2Enabled: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  assertLeadCollaboratorAccess: vi.fn(),
  assertLeadOwnerAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn((_role: string, scope: "mine" | "team" | "all" | undefined) => scope ?? "all"),
}));

vi.mock("../../../src/modules/leads/service.js", () => ({
  createLead: serviceMocks.createLead,
  deleteLead: serviceMocks.deleteLead,
  getLeadById: serviceMocks.getLeadById,
  listLeads: serviceMocks.listLeads,
  transitionLeadStage: serviceMocks.transitionLeadStage,
  updateLead: serviceMocks.updateLead,
  LeadCreateRequirementsError: TestLeadCreateRequirementsError,
}));

vi.mock("../../../src/modules/leads/conversion-service.js", () => ({
  convertLead: vi.fn(),
}));

vi.mock("../../../src/modules/leads/questionnaire-service.js", () => ({
  getLeadQuestionnaireSnapshot: questionnaireMocks.getLeadQuestionnaireSnapshot,
  getQuestionnaireTemplateSnapshot: questionnaireMocks.getQuestionnaireTemplateSnapshot,
  isLeadEditV2Enabled: questionnaireMocks.isLeadEditV2Enabled,
}));

vi.mock("../../../src/db.js", () => ({
  releasePooledClient: (client: any) => client?.release?.(),
  pool: {
    connect: dbMocks.poolConnect,
  },
}));

vi.mock("../../../src/modules/leads/due-diligence-service.js", () => ({
  assertSafeOfficeSlug: dueDiligenceMocks.assertSafeOfficeSlug,
  dispatchPendingDueDiligenceEmail: dueDiligenceMocks.dispatchPendingDueDiligenceEmail,
  getLeadDueDiligenceApprovalForLead: dueDiligenceMocks.getLeadDueDiligenceApprovalForLead,
}));

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertLeadCollaboratorAccess: accessMocks.assertLeadCollaboratorAccess,
  assertLeadOwnerAccess: accessMocks.assertLeadOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
}));
vi.mock("../../../src/modules/audit/audit-logger.js", () => ({
  logActivity: auditMocks.logActivity,
  buildAuditActorFromUser: auditMocks.buildAuditActorFromUser,
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
    LeadCreateRequirementsError: TestLeadCreateRequirementsError,
  }));

  vi.doMock("../../../src/modules/leads/conversion-service.js", () => ({
    convertLead: vi.fn(),
  }));

  vi.doMock("../../../src/modules/leads/questionnaire-service.js", () => ({
    getLeadQuestionnaireSnapshot: questionnaireMocks.getLeadQuestionnaireSnapshot,
    getQuestionnaireTemplateSnapshot: questionnaireMocks.getQuestionnaireTemplateSnapshot,
    isLeadEditV2Enabled: questionnaireMocks.isLeadEditV2Enabled,
  }));

  vi.doMock("../../../src/db.js", () => ({
    releasePooledClient: (client: any) => client?.release?.(),
    pool: {
      connect: dbMocks.poolConnect,
    },
  }));

  vi.doMock("../../../src/modules/leads/due-diligence-service.js", () => ({
    assertSafeOfficeSlug: dueDiligenceMocks.assertSafeOfficeSlug,
    dispatchPendingDueDiligenceEmail: dueDiligenceMocks.dispatchPendingDueDiligenceEmail,
    getLeadDueDiligenceApprovalForLead: dueDiligenceMocks.getLeadDueDiligenceApprovalForLead,
  }));

  vi.doMock("../../../src/lib/collaboration-access.js", () => ({
    assertLeadCollaboratorAccess: accessMocks.assertLeadCollaboratorAccess,
    assertLeadOwnerAccess: accessMocks.assertLeadOwnerAccess,
    getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
    normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
  }));
  vi.doMock("../../../src/modules/audit/audit-logger.js", () => ({
    logActivity: auditMocks.logActivity,
    buildAuditActorFromUser: auditMocks.buildAuditActorFromUser,
  }));

  const { leadRoutes } = await import("../../../src/modules/leads/routes.js");
  return leadRoutes;
}

function findRouteHandler(routes: unknown, method: "get" | "post" | "patch" | "delete", path: string) {
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
    officeSlug: "atlanta",
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
    tenantDb: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
          })),
        })),
      })),
    },
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

async function invokeLeadCreateRoute(
  body: Record<string, unknown>,
  leadRoutes?: unknown,
  userOverride: Record<string, unknown> = {},
) {
  const routes = leadRoutes ?? (await loadLeadRoutes());
  const handler = findRouteHandler(routes, "post", "/");
  const req = {
    body,
    tenantDb: {},
    user: {
      id: "rep-1",
      role: "rep",
      activeOfficeId: "office-1",
      ...userOverride,
    },
    officeSlug: "atlanta",
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

async function invokeLeadPatchRoute(
  body: Record<string, unknown>,
  leadRoutes?: unknown,
  userOverride: Record<string, unknown> = {},
) {
  const routes = leadRoutes ?? (await loadLeadRoutes());
  const handler = findRouteHandler(routes, "patch", "/:id");
  const req = {
    params: { id: "lead-1" },
    body,
    tenantDb: {},
    user: {
      id: "rep-1",
      role: "rep",
      activeOfficeId: "office-1",
      ...userOverride,
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

async function invokeLeadDeleteRoute(
  body: Record<string, unknown>,
  leadRoutes?: unknown,
  userOverride: Record<string, unknown> = {},
) {
  const routes = leadRoutes ?? (await loadLeadRoutes());
  const handler = findRouteHandler(routes, "delete", "/:id");
  const req = {
    params: { id: "lead-1" },
    body,
    headers: {},
    tenantDb: {},
    user: {
      id: "rep-1",
      role: "rep",
      activeOfficeId: "office-1",
      ...userOverride,
    },
    commitTransaction: vi.fn(async () => {}),
  } as any;
  const res = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send: vi.fn(),
  } as any;
  const next = vi.fn((err?: unknown) => {
    if (err) throw err;
  });

  await handler(req, res, next);
  return { req, res, next };
}

async function invokeQuestionnaireTemplateRoute(projectTypeId = "project-type-1", leadRoutes?: unknown) {
  const routes = leadRoutes ?? (await loadLeadRoutes());
  const handler = findRouteHandler(routes, "get", "/questionnaire-template");
  const req = {
    query: { projectTypeId },
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

function installDueDiligenceDispatchClient() {
  const client = {
    query: vi.fn(async () => ({ rows: [] })),
    release: vi.fn(),
  };
  dbMocks.poolConnect.mockResolvedValue(client);
  dueDiligenceMocks.dispatchPendingDueDiligenceEmail.mockResolvedValue({ success: true, messageId: "resend-1" });
  return client;
}

describe("lead stage transition route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    questionnaireMocks.isLeadEditV2Enabled.mockReturnValue(false);
    accessMocks.assertLeadCollaboratorAccess.mockResolvedValue({ id: "lead-1", assignedRepId: "rep-1", officeId: "office-1" });
    accessMocks.assertLeadOwnerAccess.mockResolvedValue({ id: "lead-1", assignedRepId: "rep-1", officeId: "office-1" });
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

  it("serializes lead create prerequisite failures as structured 400 responses", async () => {
    const leadRoutes = await loadLeadRoutes();
    serviceMocks.createLead.mockRejectedValueOnce(new TestLeadCreateRequirementsError());

    const { req, res } = await invokeLeadCreateRoute(
      {
        companyId: "company-1",
        propertyId: "property-1",
        name: "Lead One",
      },
      leadRoutes
    );

    expect(serviceMocks.createLead).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        companyId: "company-1",
        propertyId: "property-1",
        stageId: undefined,
      })
    );
    expect(req.commitTransaction).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: {
        message: "Complete required lead creation fields before creating a lead.",
        code: "LEAD_CREATE_REQUIREMENTS_UNMET",
        missingRequirements: {
          fields: [{ key: "budgetStatus", label: "Budget status" }],
        },
      },
    });
  });

  it("auto-resolves missing lead officeCode from the selected office slug", async () => {
    const leadRoutes = await loadLeadRoutes();
    serviceMocks.createLead.mockResolvedValueOnce({
      id: "lead-created",
      verificationStatus: "not_required",
    });

    const { req, res } = await invokeLeadCreateRoute(
      {
        companyId: "company-1",
        propertyId: "property-1",
        name: "Lead One",
      },
      leadRoutes
    );

    expect(res.statusCode).toBe(201);
    expect(serviceMocks.createLead).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        officeCode: "atl",
      })
    );
  });

  it("threads the authenticated request user (the actor), not the assignee, as the lead-creation actor", async () => {
    const leadRoutes = await loadLeadRoutes();
    serviceMocks.createLead.mockResolvedValueOnce({
      id: "lead-created",
      verificationStatus: "not_required",
    });

    // A non-rep actor (director) creating a lead ASSIGNED to a DIFFERENT rep. Using distinct ids for
    // the actor (req.user.id) and the assignee (body.assignedRepId) is what makes this assertion
    // meaningful: it proves the route sources actorUserId from the acting user, so a regression that
    // passed the assignee (repId) as actorUserId would fail here — attributing the assignment task +
    // audit to the wrong user when a manager creates a lead for another rep.
    const { req, res } = await invokeLeadCreateRoute(
      {
        companyId: "company-1",
        propertyId: "property-1",
        name: "Actor Threaded Lead",
        assignedRepId: "rep-assignee-2",
      },
      leadRoutes,
      { id: "manager-9", role: "director" }
    );

    // Behavioral replacement for the deleted brittle source-text grep
    // (src/modules/leads/assignment-task-source.test.ts); the service-side wiring of this actor into
    // createAssignmentTaskIfNeeded is covered by tests/modules/leads/service.test.ts.
    expect(res.statusCode).toBe(201);
    expect(serviceMocks.createLead).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({ actorUserId: "manager-9", assignedRepId: "rep-assignee-2" })
    );
  });

  it("rejects whitespace-only lead names on create", async () => {
    const leadRoutes = await loadLeadRoutes();

    await expect(
      invokeLeadCreateRoute(
        {
          companyId: "company-1",
          propertyId: "property-1",
          name: "   ",
        },
        leadRoutes
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "companyId, propertyId, and name are required",
    });

    expect(serviceMocks.createLead).not.toHaveBeenCalled();
  });

  it("trims lead names before create", async () => {
    const leadRoutes = await loadLeadRoutes();
    serviceMocks.createLead.mockResolvedValueOnce({
      id: "lead-created",
      verificationStatus: "not_required",
    });

    await invokeLeadCreateRoute(
      {
        companyId: "company-1",
        propertyId: "property-1",
        name: "  Lead One  ",
      },
      leadRoutes
    );

    expect(serviceMocks.createLead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "Lead One",
      })
    );
  });

  it("accepts a lead officeCode that differs from the active office (prefix is cosmetic, decoupled from the schema)", async () => {
    const leadRoutes = await loadLeadRoutes();
    serviceMocks.createLead.mockResolvedValueOnce({
      id: "lead-created",
      verificationStatus: "not_required",
    });

    // Active office is atlanta, but the requested DFW prefix is honored (no must-match) and normalized to
    // lowercase — the lead is still created on the active (atlanta) schema; only its prefix is DFW.
    const { res } = await invokeLeadCreateRoute(
      {
        companyId: "company-1",
        propertyId: "property-1",
        name: "Lead One",
        officeCode: "DFW",
      },
      leadRoutes
    );

    expect(res.statusCode).toBe(201);
    expect(serviceMocks.createLead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ officeCode: "dfw" })
    );
  });

  it("preserves every lead create prerequisite key in the structured 400 response", async () => {
    const leadRoutes = await loadLeadRoutes();
    const fields = [
      { key: "property.address", label: "Project address" },
      { key: "property.city", label: "Project city" },
      { key: "property.state", label: "Project state" },
      { key: "property.zip", label: "Project ZIP" },
      { key: "property.buildYear", label: "Year built" },
      { key: "property.unitCount", label: "Number of units" },
      { key: "primaryContactId", label: "Point of contact" },
      { key: "primaryContactRole", label: "POC role" },
      { key: "budgetStatus", label: "Budget status" },
      { key: "projectTypeId", label: "Project type" },
      { key: "bidDueDate", label: "Bid Due Date" },
    ];
    serviceMocks.createLead.mockRejectedValueOnce(new TestLeadCreateRequirementsError(fields));

    const { res } = await invokeLeadCreateRoute(
      {
        companyId: "company-1",
        propertyId: "property-1",
        name: "Lead One",
      },
      leadRoutes
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error.missingRequirements.fields).toEqual(fields);
  });

  it("dispatches the DD email after a pending new-company lead is committed", async () => {
    const leadRoutes = await loadLeadRoutes();
    const client = installDueDiligenceDispatchClient();
    serviceMocks.createLead.mockResolvedValueOnce({
      id: "lead-new-company",
      verificationStatus: "pending",
    });
    dueDiligenceMocks.getLeadDueDiligenceApprovalForLead.mockResolvedValueOnce({
      id: "approval-1",
    });

    const { req, res } = await invokeLeadCreateRoute(
      {
        companyId: "company-1",
        propertyId: "property-1",
        name: "Lead One",
      },
      leadRoutes
    );

    expect(req.commitTransaction).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ lead: { id: "lead-new-company", verificationStatus: "pending" } });
    expect(dueDiligenceMocks.getLeadDueDiligenceApprovalForLead).toHaveBeenCalledWith(req.tenantDb, "lead-new-company");

    await vi.waitFor(() => {
      expect(dueDiligenceMocks.dispatchPendingDueDiligenceEmail).toHaveBeenCalledWith(
        expect.anything(),
        "approval-1",
        expect.objectContaining({ now: expect.any(Date) })
      );
    });
    expect(dueDiligenceMocks.assertSafeOfficeSlug).toHaveBeenCalledWith("atlanta");
    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("does not dispatch DD email for an existing-company lead", async () => {
    const leadRoutes = await loadLeadRoutes();
    serviceMocks.createLead.mockResolvedValueOnce({
      id: "lead-existing-company",
      verificationStatus: "not_required",
    });

    const { req, res } = await invokeLeadCreateRoute(
      {
        companyId: "company-1",
        propertyId: "property-1",
        name: "Lead One",
      },
      leadRoutes
    );

    expect(req.commitTransaction).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(201);
    expect(dueDiligenceMocks.getLeadDueDiligenceApprovalForLead).not.toHaveBeenCalled();
    expect(dbMocks.poolConnect).not.toHaveBeenCalled();
    expect(dueDiligenceMocks.dispatchPendingDueDiligenceEmail).not.toHaveBeenCalled();
  });

  it("logs post-commit DD email connection failures without changing the lead response", async () => {
    const leadRoutes = await loadLeadRoutes();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    dbMocks.poolConnect.mockRejectedValueOnce(new Error("pool unavailable"));
    serviceMocks.createLead.mockResolvedValueOnce({
      id: "lead-new-company",
      verificationStatus: "pending",
    });
    dueDiligenceMocks.getLeadDueDiligenceApprovalForLead.mockResolvedValueOnce({
      id: "approval-1",
    });

    const { req, res } = await invokeLeadCreateRoute(
      {
        companyId: "company-1",
        propertyId: "property-1",
        name: "Lead One",
      },
      leadRoutes
    );

    expect(req.commitTransaction).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ lead: { id: "lead-new-company", verificationStatus: "pending" } });

    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        "[lead-dd] post-commit email dispatch failed",
        expect.objectContaining({ approvalId: "approval-1", err: expect.any(Error) })
      );
    });
    expect(dueDiligenceMocks.dispatchPendingDueDiligenceEmail).not.toHaveBeenCalled();
    error.mockRestore();
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
        isWatching: false,
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

  it("returns the questionnaire template for create mode when lead edit v2 is enabled", async () => {
    const leadRoutes = await loadLeadRoutes();
    questionnaireMocks.isLeadEditV2Enabled.mockReturnValue(true);
    questionnaireMocks.getQuestionnaireTemplateSnapshot.mockResolvedValueOnce({
      projectTypeId: "project-type-1",
      nodes: [
        {
          id: "node-1",
          projectTypeId: null,
          parentNodeId: null,
          parentOptionValue: null,
          nodeType: "question",
          key: "bid_due_date",
          label: "Bid Due Date",
          prompt: null,
          inputType: "date",
          options: [],
          isRequired: true,
          displayOrder: 10,
          isActive: true,
        },
      ],
      allNodes: [],
      answers: {},
    });

    const { req, res } = await invokeQuestionnaireTemplateRoute("project-type-1", leadRoutes);

    expect(questionnaireMocks.getQuestionnaireTemplateSnapshot).toHaveBeenCalledWith(
      req.tenantDb,
      "project-type-1"
    );
    expect(req.commitTransaction).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({
      enabled: true,
      questionnaire: {
        projectTypeId: "project-type-1",
        nodes: [
          expect.objectContaining({
            key: "bid_due_date",
            label: "Bid Due Date",
          }),
        ],
        allNodes: [],
        answers: {},
      },
    });
  });

  it("rejects PATCH stage changes with a structured 400", async () => {
    const leadRoutes = await loadLeadRoutes();
    serviceMocks.getLeadById.mockResolvedValueOnce({
      id: "lead-1",
      stageId: "stage-current",
    });

    const { req, res } = await invokeLeadPatchRoute({ stageId: "stage-next" }, leadRoutes);

    expect(serviceMocks.getLeadById).toHaveBeenCalledWith(req.tenantDb, "lead-1", "rep", "rep-1");
    expect(serviceMocks.updateLead).not.toHaveBeenCalled();
    expect(req.commitTransaction).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "Stage changes must use POST /api/leads/:id/stage-transition. Direct stage updates via PATCH are not supported.",
      code: "STAGE_CHANGE_NOT_ALLOWED_VIA_PATCH",
    });
  });

  it("allows PATCH with unchanged stageId and updates other fields", async () => {
    const leadRoutes = await loadLeadRoutes();
    serviceMocks.getLeadById.mockResolvedValueOnce({
      id: "lead-1",
      stageId: "stage-current",
    });
    serviceMocks.updateLead.mockResolvedValueOnce({
      id: "lead-1",
      stageId: "stage-current",
      name: "Updated Lead",
    });

    const { req, res } = await invokeLeadPatchRoute(
      { stageId: "stage-current", name: "Updated Lead" },
      leadRoutes
    );

    expect(serviceMocks.updateLead).toHaveBeenCalledWith(
      req.tenantDb,
      "lead-1",
      expect.not.objectContaining({ stageId: expect.anything() }),
      "rep",
      "rep-1"
    );
    expect(serviceMocks.updateLead).toHaveBeenCalledWith(
      req.tenantDb,
      "lead-1",
      expect.objectContaining({ name: "Updated Lead", officeId: "office-1" }),
      "rep",
      "rep-1"
    );
    expect(req.commitTransaction).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({
      lead: {
        id: "lead-1",
        stageId: "stage-current",
        name: "Updated Lead",
      },
    });
  });

  it("allows PATCH without stageId normally", async () => {
    const leadRoutes = await loadLeadRoutes();
    serviceMocks.updateLead.mockResolvedValueOnce({
      id: "lead-1",
      name: "Updated Lead",
    });

    const { req, res } = await invokeLeadPatchRoute({ name: "Updated Lead" }, leadRoutes);

    expect(serviceMocks.getLeadById).not.toHaveBeenCalled();
    expect(serviceMocks.updateLead).toHaveBeenCalledWith(
      req.tenantDb,
      "lead-1",
      expect.objectContaining({ name: "Updated Lead", officeId: "office-1" }),
      "rep",
      "rep-1"
    );
    expect(req.commitTransaction).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({
      lead: {
        id: "lead-1",
        name: "Updated Lead",
      },
    });
  });

  it("makes the canonical owner win when the current rep transfers their lead", async () => {
    const leadRoutes = await loadLeadRoutes();
    serviceMocks.updateLead.mockResolvedValueOnce({ id: "lead-1", assignedRepId: TARGET_REP_ID, salesRepId: TARGET_REP_ID });

    const { req } = await invokeLeadPatchRoute(
      { assignedRepId: TARGET_REP_ID, salesRepId: OTHER_REP_ID },
      leadRoutes,
    );

    expect(accessMocks.assertLeadCollaboratorAccess).toHaveBeenCalled();
    expect(serviceMocks.updateLead).toHaveBeenCalledWith(
      req.tenantDb,
      "lead-1",
      expect.objectContaining({ assignedRepId: TARGET_REP_ID, salesRepId: TARGET_REP_ID }),
      "rep",
      "rep-1",
    );
  });

  it("allows a director to reassign a teammate lead", async () => {
    const leadRoutes = await loadLeadRoutes();
    accessMocks.assertLeadCollaboratorAccess.mockResolvedValueOnce({ id: "lead-1", assignedRepId: "rep-1" });
    serviceMocks.updateLead.mockResolvedValueOnce({ id: "lead-1", assignedRepId: TARGET_REP_ID });

    const { req } = await invokeLeadPatchRoute(
      { assignedRepId: TARGET_REP_ID, salesRepId: TARGET_REP_ID },
      leadRoutes,
      { id: "director-1", role: "director" },
    );

    expect(serviceMocks.updateLead).toHaveBeenCalledWith(
      req.tenantDb,
      "lead-1",
      expect.objectContaining({ assignedRepId: TARGET_REP_ID, salesRepId: TARGET_REP_ID }),
      "director",
      "director-1",
    );
  });

  it("blocks a non-owner rep from reassigning a teammate lead", async () => {
    const leadRoutes = await loadLeadRoutes();
    accessMocks.assertLeadCollaboratorAccess.mockResolvedValueOnce({ id: "lead-1", assignedRepId: "rep-9" });

    await expect(
      invokeLeadPatchRoute(
        { assignedRepId: TARGET_REP_ID, salesRepId: TARGET_REP_ID },
        leadRoutes,
      )
    ).rejects.toMatchObject({ statusCode: 403, code: "LEAD_REASSIGNMENT_FORBIDDEN" });
    expect(serviceMocks.updateLead).not.toHaveBeenCalled();
  });

  it("rejects a malformed reassignment id before it reaches the database service", async () => {
    const leadRoutes = await loadLeadRoutes();

    await expect(
      invokeLeadPatchRoute({ assignedRepId: "not-a-uuid" }, leadRoutes),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(serviceMocks.updateLead).not.toHaveBeenCalled();
  });

  it("requires an archive reason and forwards the real actor to the service", async () => {
    const leadRoutes = await loadLeadRoutes();

    await expect(invokeLeadDeleteRoute({}, leadRoutes)).rejects.toMatchObject({
      statusCode: 400,
      code: "LEAD_ARCHIVE_REASON_REQUIRED",
    });
    expect(serviceMocks.deleteLead).not.toHaveBeenCalled();

    serviceMocks.deleteLead.mockResolvedValueOnce(null);
    const { req, res } = await invokeLeadDeleteRoute({ reason: "  Duplicate  " }, leadRoutes);
    expect(serviceMocks.deleteLead).toHaveBeenCalledWith(req.tenantDb, "lead-1", {
      actorRole: "rep",
      actorId: "rep-1",
      reason: "Duplicate",
    });
    expect(req.commitTransaction).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(204);

    serviceMocks.deleteLead.mockResolvedValueOnce({ id: "lead-1", name: "Lead One" });
    const success = await invokeLeadDeleteRoute({ reason: "No longer pursuing" }, leadRoutes);
    expect(auditMocks.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantDb: success.req.tenantDb,
        action: "soft_delete",
        entity: expect.objectContaining({ recordId: "lead-1", nameSnapshot: "Lead One" }),
      }),
    );
    expect(success.req.commitTransaction).toHaveBeenCalledOnce();
  });
});

describe("lead list route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function invokeListRoute(query: Record<string, unknown>) {
    const routes = await loadLeadRoutes();
    const handler = findRouteHandler(routes, "get", "/");
    const req = {
      query,
      tenantDb: {},
      user: {
        id: "rep-1",
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
    return { req, res, next };
  }

  it("defaults list scope to mine when the query param is missing", async () => {
    serviceMocks.listLeads.mockResolvedValueOnce([]);
    const { req } = await invokeListRoute({});

    expect(serviceMocks.listLeads).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({ scope: "mine" }),
      "rep",
      "rep-1"
    );
  });

  it("rejects malformed createdFrom with a 400 before querying leads", async () => {
    serviceMocks.listLeads.mockResolvedValueOnce([]);
    const routes = await loadLeadRoutes();
    const handler = findRouteHandler(routes, "get", "/");
    const req = {
      query: { createdFrom: "not-a-date" },
      tenantDb: {},
      user: {
        id: "rep-1",
        role: "rep",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
      commitTransaction: vi.fn(async () => {}),
    } as any;
    const res = {} as any;
    const next = vi.fn();

    await handler(req, res, next);

    expect(serviceMocks.listLeads).not.toHaveBeenCalled();
    expect(req.commitTransaction).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: "createdFrom must be an ISO date in YYYY-MM-DD format",
      })
    );
  });

  it("passes validated createdFrom and createdTo through to listLeads", async () => {
    serviceMocks.listLeads.mockResolvedValueOnce([]);
    const { req } = await invokeListRoute({
      createdFrom: "2026-05-01",
      createdTo: "2026-05-31",
    });

    expect(serviceMocks.listLeads).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        createdFrom: "2026-05-01",
        createdTo: "2026-05-31",
      }),
      "rep",
      "rep-1"
    );
  });
});
