import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/modules/deals/service.js", () => ({
  getDealById: vi.fn(async () => ({ id: "deal-1", assignedRepId: "user-1" })),
  getDeals: vi.fn(),
  getDealDetail: vi.fn(),
  createDeal: vi.fn(),
  updateDeal: vi.fn(),
  deleteDeal: vi.fn(),
  getDealsForPipeline: vi.fn(),
  getDealSources: vi.fn(),
}));

vi.mock("../../../src/modules/deals/stage-change.js", () => ({
  changeDealStage: vi.fn(),
}));

vi.mock("../../../src/modules/deals/stage-gate.js", () => ({
  preflightStageCheck: vi.fn(),
}));

vi.mock("../../../src/modules/contacts/association-service.js", () => ({
  getContactsForDeal: vi.fn(),
}));

vi.mock("../../../src/modules/deals/scoping-service.js", () => ({
  getOrCreateDealScopingIntake: vi.fn(),
  upsertDealScopingIntake: vi.fn(),
  evaluateDealScopingReadiness: vi.fn(),
  linkDealFileToScopingRequirement: vi.fn(),
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const scopingService = await import("../../../src/modules/deals/scoping-service.js");

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

async function invokeRoute(
  method: "get" | "patch" | "post",
  path: string,
  options?: { params?: Record<string, string>; body?: any }
) {
  const handler = findRouteHandler(method, path);
  const req = {
    params: options?.params ?? {},
    body: options?.body ?? {},
    tenantDb: {},
    officeSlug: "office-a",
    user: {
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

  it("patches the scoping intake for a deal", async () => {
    vi.mocked(scopingService.upsertDealScopingIntake).mockResolvedValueOnce({
      intake: { id: "intake-1", status: "ready" },
      readiness: { status: "ready", errors: { sections: {}, attachments: {} }, completionState: {}, requiredSections: [], requiredAttachmentKeys: [] },
    } as never);

    const { req, res } = await invokeRoute("patch", "/:id/scoping-intake", {
      params: { id: "deal-1" },
      body: { workflowRoute: "estimating", sectionData: { scopeSummary: { summary: "Refresh" } } },
    });

    expect(scopingService.upsertDealScopingIntake).toHaveBeenCalledWith(
      req.tenantDb,
      "deal-1",
      { workflowRoute: "estimating", sectionData: { scopeSummary: { summary: "Refresh" } } },
      "user-1"
    );
    expect(res.body.readiness.status).toBe("ready");
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
      { fileId: "file-1", intakeSection: "attachments", intakeRequirementKey: "site_photos" },
      "user-1"
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.file.id).toBe("file-1");
  });
});
