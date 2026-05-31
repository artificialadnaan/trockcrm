import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

// Regression guard for the leads side of the office-level access model. Unlike deals, the lead
// routes were already correct (no code change in this PR) -- but nothing locked the invariant, so
// a future edit could silently revert them to owner-only. This test mounts the real leads router
// and asserts the same contract the deals test does:
//   - the 3 per-lead GET routes gate on assertLeadCollaboratorAccess (office-level) AND upgrade a
//     non-owner rep's read role (via the REAL getCollaborativeReadRole), so getLeadById's owner-only
//     throw never fires for a teammate's lead.
//   - the per-lead write routes stay owner-only (a non-owner rep is blocked).

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("@trock-crm/shared/types", async () => import("../../../../shared/src/types/index.js"));

const leadServiceMocks = vi.hoisted(() => ({
  createLead: vi.fn(),
  deleteLead: vi.fn(),
  getLeadById: vi.fn(),
  listLeads: vi.fn(),
  transitionLeadStage: vi.fn(),
  updateLead: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  assertLeadCollaboratorAccess: vi.fn(),
  assertLeadOwnerAccess: vi.fn(),
}));

vi.mock("../../../src/modules/leads/service.js", () => ({
  createLead: leadServiceMocks.createLead,
  deleteLead: leadServiceMocks.deleteLead,
  getLeadById: leadServiceMocks.getLeadById,
  listLeads: leadServiceMocks.listLeads,
  transitionLeadStage: leadServiceMocks.transitionLeadStage,
  updateLead: leadServiceMocks.updateLead,
  LeadCreateRequirementsError: class extends Error {},
}));

vi.mock("../../../src/modules/leads/conversion-service.js", () => ({ convertLead: vi.fn() }));
vi.mock("../../../src/modules/leads/questionnaire-service.js", () => ({
  getLeadQuestionnaireSnapshot: vi.fn(),
  getQuestionnaireTemplateSnapshot: vi.fn(),
  isLeadEditV2Enabled: vi.fn(() => false),
}));
vi.mock("../../../src/db.js", () => ({ pool: { connect: vi.fn() } }));
vi.mock("../../../src/modules/leads/due-diligence-service.js", () => ({
  assertSafeOfficeSlug: vi.fn(),
  dispatchPendingDueDiligenceEmail: vi.fn(),
  getLeadDueDiligenceApprovalForLead: vi.fn(),
}));

// Keep the REAL getCollaborativeReadRole/normalizeCollaborativeScope so the route's non-owner role
// upgrade is genuinely exercised; override only the two assert gates.
vi.mock("../../../src/lib/collaboration-access.js", async () => {
  const actual = await vi.importActual<any>("../../../src/lib/collaboration-access.js");
  return {
    ...actual,
    assertLeadCollaboratorAccess: accessMocks.assertLeadCollaboratorAccess,
    assertLeadOwnerAccess: accessMocks.assertLeadOwnerAccess,
  };
});

const { leadRoutes } = await import("../../../src/modules/leads/routes.js");

function findRouteHandler(method: string, path: string) {
  const layer = (leadRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack.find((entry: any) => entry.method === method).handle;
}

async function invoke(
  method: string,
  path: string,
  options: { params?: Record<string, string>; body?: any; user?: Partial<{ id: string; role: string }> } = {}
) {
  const handler = findRouteHandler(method, path);
  const tenantDb: any = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })),
    })),
  };
  const req = {
    params: options.params ?? { id: "lead-1" },
    query: {},
    body: options.body ?? {},
    tenantDb,
    user: {
      id: options.user?.id ?? "rep-1",
      role: options.user?.role ?? "rep",
      officeId: "office-1",
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
    send() {
      return this;
    },
  } as any;
  let nextErr: any;
  await handler(req, res, (err?: unknown) => {
    nextErr = err;
  });
  return { req, res, nextErr };
}

const READ_ROUTES = [
  { method: "get", path: "/:id" },
  { method: "get", path: "/:id/qualification" },
  { method: "get", path: "/:id/scoping" },
];

const WRITE_ROUTES = [
  { method: "patch", path: "/:id/scoping" },
  { method: "post", path: "/:id/stage-transition" },
  { method: "delete", path: "/:id" },
];

describe("lead READ routes are office-level (a rep can view a teammate's lead)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Office access granted; the lead belongs to a teammate (rep is not the owner).
    accessMocks.assertLeadCollaboratorAccess.mockResolvedValue({ id: "lead-1", assignedRepId: "teammate-1" });
    leadServiceMocks.getLeadById.mockResolvedValue({ id: "lead-1", assignedRepId: "teammate-1", projectTypeId: null });
  });

  for (const { method, path } of READ_ROUTES) {
    it(`${method.toUpperCase()} ${path} gates office-level and upgrades a non-owner rep's read role`, async () => {
      await invoke(method, path, { user: { id: "rep-1", role: "rep" } });

      // Office-level gate with the lead id + the requesting viewer.
      expect(accessMocks.assertLeadCollaboratorAccess).toHaveBeenCalledWith(
        expect.anything(),
        "lead-1",
        expect.objectContaining({ id: "rep-1", role: "rep" })
      );
      // The loader is invoked with an UPGRADED (non-"rep") role, so its owner-only throw cannot fire
      // for a teammate's lead. If the route ever reverts to passing the raw "rep" role, this fails.
      expect(leadServiceMocks.getLeadById).toHaveBeenCalled();
      const roleArg = leadServiceMocks.getLeadById.mock.calls[0][2];
      expect(roleArg).not.toBe("rep");
    });
  }
});

describe("lead WRITE routes stay owner-only (a rep cannot mutate a teammate's lead)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMocks.assertLeadCollaboratorAccess.mockResolvedValue({ id: "lead-1", assignedRepId: "teammate-1" });
    // The owner-only write gate rejects a non-owner rep.
    accessMocks.assertLeadOwnerAccess.mockRejectedValue(
      new AppError(403, "Only the assigned rep can modify this lead")
    );
    leadServiceMocks.getLeadById.mockResolvedValue({ id: "lead-1", assignedRepId: "teammate-1" });
  });

  for (const { method, path } of WRITE_ROUTES) {
    it(`${method.toUpperCase()} ${path} blocks a non-owner rep with 403`, async () => {
      const { nextErr } = await invoke(method, path, {
        user: { id: "rep-1", role: "rep" },
        body: { targetStageId: "stage-1" },
      });
      expect(accessMocks.assertLeadOwnerAccess).toHaveBeenCalled();
      expect(nextErr?.statusCode).toBe(403);
    });
  }
});
