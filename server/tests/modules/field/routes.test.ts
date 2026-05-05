import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.fieldUser = {
      id: "field-1",
      email: "field@example.com",
      firstName: "Field",
      lastName: "User",
      role: "field_contractor",
      tenantId: "office-1",
      active: true,
    };
    req.user = { id: "field-1", activeOfficeId: "office-1" };
    next();
  },
}));
vi.mock("../../../src/middleware/tenant.js", () => ({
  tenantMiddleware: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.tenantDb = { execute: vi.fn() };
    req.commitTransaction = vi.fn(async () => undefined);
    next();
  },
}));

const projectMocks = vi.hoisted(() => ({
  listFieldProjects: vi.fn(),
  listFieldProjectPhotos: vi.fn(),
  listStarredFieldProjects: vi.fn(),
  starFieldProject: vi.fn(),
  unstarFieldProject: vi.fn(),
}));

vi.mock("../../../src/modules/field/projects-service.js", () => projectMocks);

const { fieldRoutes } = await import("../../../src/modules/field/routes.js");

function findRoute(router: any, method: string, path: string) {
  const layer = router.stack.find((entry: any) => entry.route?.path === path && entry.route?.methods?.[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((entry: any) => entry.handle);
}

describe("field routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectMocks.listFieldProjects.mockResolvedValue({ projects: [], total: 0, page: 1, perPage: 50 });
    projectMocks.listStarredFieldProjects.mockResolvedValue({ projects: [] });
    projectMocks.starFieldProject.mockResolvedValue({ starred: true });
    projectMocks.unstarFieldProject.mockResolvedValue({ starred: false });
    projectMocks.listFieldProjectPhotos.mockResolvedValue({ photos: [], pagination: { page: 1, limit: 200, total: 0, totalPages: 0 } });
  });

  it("returns the authenticated field contractor profile", async () => {
    const res = await invokeRoute("get", "/me", {});

    expect(res.body).toEqual({
      user: {
        id: "field-1",
        email: "field@example.com",
        firstName: "Field",
        lastName: "User",
        role: "field_contractor",
        tenantId: "office-1",
        active: true,
      },
    });
  });

  it("routes field project list, starred list, star toggles, and photos through field-safe services", async () => {
    await invokeRoute("get", "/projects", { query: { search: "roof", page: "2", perPage: "25" } });
    expect(projectMocks.listFieldProjects).toHaveBeenCalledWith(expect.anything(), "field-1", {
      search: "roof",
      status: undefined,
      page: 2,
      perPage: 25,
    });

    await invokeRoute("get", "/projects/starred", {});
    expect(projectMocks.listStarredFieldProjects).toHaveBeenCalledWith(expect.anything(), "field-1");

    await invokeRoute("post", "/projects/:dealId/star", { params: { dealId: "deal-1" } });
    expect(projectMocks.starFieldProject).toHaveBeenCalledWith(expect.anything(), "field-1", "deal-1");

    await invokeRoute("delete", "/projects/:dealId/star", { params: { dealId: "deal-1" } });
    expect(projectMocks.unstarFieldProject).toHaveBeenCalledWith(expect.anything(), "field-1", "deal-1");

    await invokeRoute("get", "/projects/:dealId/photos", {
      params: { dealId: "deal-1" },
      query: { category: "damage,safety", uploader: "u1,u2", from: "2026-05-01", to: "2026-05-05" },
    });
    expect(projectMocks.listFieldProjectPhotos).toHaveBeenCalledWith(expect.anything(), "deal-1", {
      categories: ["damage", "safety"],
      uploaderIds: ["u1", "u2"],
      from: "2026-05-01",
      to: "2026-05-05",
      includeDeleted: false,
    });
  });
});

async function invokeRoute(method: string, path: string, reqPatch: Record<string, unknown>) {
  const handlers = findRoute(fieldRoutes, method, path);
  const req: Record<string, unknown> = { query: {}, params: {}, ...reqPatch };
  const res: Record<string, unknown> = {
    body: undefined,
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };

  for (const handler of handlers) {
    await handler(req, res, (err?: unknown) => {
      if (err) throw err;
    });
  }
  return res;
}
