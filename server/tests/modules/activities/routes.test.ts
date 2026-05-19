import { beforeEach, describe, expect, it, vi } from "vitest";

const activityServiceMocks = vi.hoisted(() => ({
  getActivities: vi.fn(),
  createActivity: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  assertDealCollaboratorAccess: vi.fn(),
  assertLeadCollaboratorAccess: vi.fn(),
}));

vi.mock("../../../src/modules/activities/service.js", () => ({
  getActivities: activityServiceMocks.getActivities,
  createActivity: activityServiceMocks.createActivity,
}));

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  assertLeadCollaboratorAccess: accessMocks.assertLeadCollaboratorAccess,
}));

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: {
    emitLocal: vi.fn(),
  },
}));

const { activityRoutes } = await import("../../../src/modules/activities/routes.js");

function findRouteHandler(method: "get" | "post", path: string) {
  const layer = (activityRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  return layer.route.stack[0].handle as (req: any, res: any, next: (err?: unknown) => void) => unknown;
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    query: {},
    body: {},
    user: {
      id: "rep-2",
      role: "rep",
      displayName: "Eddie Example",
      officeId: "office-1",
      activeOfficeId: "office-1",
    },
    tenantDb: {
      insert: vi.fn(() => ({
        values: vi.fn(async () => ({})),
      })),
    },
    commitTransaction: vi.fn(async () => {}),
    headers: {},
    ip: "127.0.0.1",
    ...overrides,
  } as any;
}

function makeRes() {
  return {
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
}

describe("activity collaboration routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMocks.assertDealCollaboratorAccess.mockResolvedValue({ id: "deal-1", assignedRepId: "rep-1", officeId: "office-1" });
    accessMocks.assertLeadCollaboratorAccess.mockResolvedValue({ id: "lead-1", assignedRepId: "rep-1", officeId: "office-1" });
  });

  it("shows same-office deal activity to reps in all view without forcing responsibleUserId", async () => {
    activityServiceMocks.getActivities.mockResolvedValue({ activities: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
    const handler = findRouteHandler("get", "/");
    const req = makeReq({ query: { dealId: "deal-1" } });
    const res = makeRes();

    await handler(req, res, (err?: unknown) => {
      if (err) throw err;
    });

    expect(accessMocks.assertDealCollaboratorAccess).toHaveBeenCalledWith(req.tenantDb, "deal-1", req.user);
    expect(activityServiceMocks.getActivities).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        dealId: "deal-1",
        responsibleUserId: undefined,
      })
    );
  });

  it("keeps reps self-scoped for company activity requests without deal or lead context", async () => {
    activityServiceMocks.getActivities.mockResolvedValue({ activities: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
    const handler = findRouteHandler("get", "/");
    const req = makeReq({ query: { companyId: "company-1" } });
    const res = makeRes();

    await handler(req, res, (err?: unknown) => {
      if (err) throw err;
    });

    expect(activityServiceMocks.getActivities).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        companyId: "company-1",
        responsibleUserId: "rep-2",
      })
    );
  });

  it("attributes collaborator-created deal activities to the acting user", async () => {
    activityServiceMocks.createActivity.mockResolvedValue({
      id: "activity-1",
      type: "note",
      responsibleUserId: "rep-2",
      performedByUserId: "rep-2",
      sourceEntityType: "deal",
      sourceEntityId: "deal-1",
      companyId: null,
      propertyId: null,
      leadId: null,
      dealId: "deal-1",
      contactId: null,
      subject: "Teammate note",
    });
    const handler = findRouteHandler("post", "/");
    const req = makeReq({
      body: {
        type: "note",
        subject: "Teammate note",
        dealId: "deal-1",
      },
    });
    const res = makeRes();

    await handler(req, res, (err?: unknown) => {
      if (err) throw err;
    });

    expect(accessMocks.assertDealCollaboratorAccess).toHaveBeenCalledWith(req.tenantDb, "deal-1", req.user);
    expect(activityServiceMocks.createActivity).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        responsibleUserId: "rep-2",
        performedByUserId: "rep-2",
        sourceEntityType: "deal",
        sourceEntityId: "deal-1",
      })
    );
    expect(res.statusCode).toBe(201);
  });

  it("does not let reps impersonate another responsible user when creating activities", async () => {
    activityServiceMocks.createActivity.mockResolvedValue({
      id: "activity-2",
      type: "note",
      responsibleUserId: "rep-2",
      performedByUserId: "rep-2",
      sourceEntityType: "deal",
      sourceEntityId: "deal-1",
    });
    const handler = findRouteHandler("post", "/");
    const req = makeReq({
      body: {
        type: "note",
        subject: "Teammate note",
        dealId: "deal-1",
        responsibleUserId: "rep-1",
      },
    });
    const res = makeRes();

    await handler(req, res, (err?: unknown) => {
      if (err) throw err;
    });

    expect(activityServiceMocks.createActivity).toHaveBeenCalledWith(
      req.tenantDb,
      expect.objectContaining({
        responsibleUserId: "rep-2",
        performedByUserId: "rep-2",
      })
    );
    expect(res.statusCode).toBe(201);
  });
});
