import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("@trock-crm/shared/types", async () => import("../../../../shared/src/types/index.js"));

const dealsServiceMocks = vi.hoisted(() => ({
  getDealById: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  assertDealCollaboratorAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn((_role: string, scope: "mine" | "team" | "all" | undefined) => scope ?? "all"),
  assertDealOwnerAccess: vi.fn(),
}));

const mineVisibilityMocks = vi.hoisted(() => ({
  resolveMineVisibilityFeatures: vi.fn(async () => ({
    dealSubscriptions: true,
    leadSubscriptions: true,
  })),
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
    getDealById: dealsServiceMocks.getDealById,
  };
});

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
  assertDealOwnerAccess: accessMocks.assertDealOwnerAccess,
}));

vi.mock("../../../src/modules/shared/mine-visibility.js", async () => {
  const actual = await vi.importActual("../../../src/modules/shared/mine-visibility.js");
  return {
    ...(actual as Record<string, unknown>),
    resolveMineVisibilityFeatures: mineVisibilityMocks.resolveMineVisibilityFeatures,
  };
});

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");

function findRouteHandler(method: "get" | "post" | "delete", path: string) {
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
    params: { id: "deal-1" },
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

describe("deal watch routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mineVisibilityMocks.resolveMineVisibilityFeatures.mockResolvedValue({
      dealSubscriptions: true,
      leadSubscriptions: true,
    });
    accessMocks.assertDealCollaboratorAccess.mockResolvedValue({
      id: "deal-1",
      assignedRepId: "rep-1",
      officeId: "office-1",
    });
    dealsServiceMocks.getDealById.mockResolvedValue({
      id: "deal-1",
      assignedRepId: "rep-1",
      name: "Watched deal",
    });
  });

  it("returns watch state on deal detail reads", async () => {
    const { req, res } = await invokeRoute("get", "/:id", { selectRows: [[{ id: "sub-1" }]] });

    expect(accessMocks.assertDealCollaboratorAccess).toHaveBeenCalledWith(req.tenantDb, "deal-1", req.user);
    expect(res.body.deal).toMatchObject({
      id: "deal-1",
      isWatching: true,
    });
  });

  it("upserts a watch subscription", async () => {
    const { req, res } = await invokeRoute("post", "/:id/watch");

    expect(accessMocks.assertDealCollaboratorAccess).toHaveBeenCalledWith(req.tenantDb, "deal-1", req.user);
    expect(req.tenantDb.insert).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ watching: true });
  });

  it("soft deletes an existing watch subscription", async () => {
    const { req, res } = await invokeRoute("delete", "/:id/watch");

    expect(accessMocks.assertDealCollaboratorAccess).toHaveBeenCalledWith(req.tenantDb, "deal-1", req.user);
    expect(req.tenantDb.update).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ watching: false });
  });

  it("returns not-watching on detail reads when subscriptions are unavailable", async () => {
    mineVisibilityMocks.resolveMineVisibilityFeatures.mockResolvedValueOnce({
      dealSubscriptions: false,
      leadSubscriptions: true,
    });

    const { res } = await invokeRoute("get", "/:id");

    expect(res.body.deal).toMatchObject({
      id: "deal-1",
      isWatching: false,
    });
  });

  it("fails watch mutations gracefully when subscriptions are unavailable", async () => {
    mineVisibilityMocks.resolveMineVisibilityFeatures.mockResolvedValueOnce({
      dealSubscriptions: false,
      leadSubscriptions: true,
    });

    await expect(invokeRoute("post", "/:id/watch")).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});
