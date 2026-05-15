import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.fieldUser = {
      id: "admin-1",
      email: "admin@example.com",
      firstName: "Admin",
      lastName: "User",
      role: "admin",
      tenantId: "office-1",
      active: true,
    };
    req.user = { id: "admin-1", role: "admin", activeOfficeId: "office-1" };
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
  searchFieldCaptureTargets: vi.fn(),
  assertAccessibleFieldCaptureTarget: vi.fn(),
  starFieldProject: vi.fn(),
  unstarFieldProject: vi.fn(),
}));

const photoMocks = vi.hoisted(() => ({
  requestFieldPhotoUploadUrl: vi.fn(),
  confirmFieldPhotoUpload: vi.fn(),
}));

vi.mock("../../../src/modules/field/projects-service.js", () => projectMocks);
vi.mock("../../../src/modules/field/photos-service.js", () => photoMocks);

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
    projectMocks.searchFieldCaptureTargets.mockResolvedValue({ targets: [] });
    projectMocks.assertAccessibleFieldCaptureTarget.mockResolvedValue({ id: "lead-1", type: "lead" });
    projectMocks.starFieldProject.mockResolvedValue({ starred: true });
    projectMocks.unstarFieldProject.mockResolvedValue({ starred: false });
    projectMocks.listFieldProjectPhotos.mockResolvedValue({ photos: [], pagination: { page: 1, limit: 200, total: 0, totalPages: 0 } });
    photoMocks.requestFieldPhotoUploadUrl.mockResolvedValue({ uploadUrl: "https://r2.example/upload", objectKey: "key", uploadToken: "token" });
    photoMocks.confirmFieldPhotoUpload.mockResolvedValue({ photo: { id: "photo-1", category: "photo" } });
  });

  it("returns the authenticated field contractor profile", async () => {
    const res = await invokeRoute("get", "/me", {});

    expect(res.body).toEqual({
      user: {
        id: "admin-1",
        email: "admin@example.com",
        firstName: "Admin",
        lastName: "User",
        role: "admin",
        tenantId: "office-1",
        active: true,
      },
    });
  });

  it("routes field project list, starred list, star toggles, and photos through field-safe services", async () => {
    await invokeRoute("get", "/projects", { query: { search: "roof", page: "2", perPage: "25" } });
    expect(projectMocks.listFieldProjects).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
    }), {
      search: "roof",
      status: undefined,
      page: 2,
      perPage: 25,
    });

    await invokeRoute("get", "/projects/starred", {});
    expect(projectMocks.listStarredFieldProjects).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
    }));

    await invokeRoute("post", "/projects/:dealId/star", { params: { dealId: "deal-1" } });
    expect(projectMocks.starFieldProject).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
    }), "deal-1");

    await invokeRoute("delete", "/projects/:dealId/star", { params: { dealId: "deal-1" } });
    expect(projectMocks.unstarFieldProject).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
    }), "deal-1");

    await invokeRoute("get", "/projects/:dealId/photos", {
      params: { dealId: "deal-1" },
      query: { category: "damage,safety", uploader: "u1,u2", from: "2026-05-01", to: "2026-05-05" },
    });
    expect(projectMocks.listFieldProjectPhotos).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
    }), "deal-1", {
      categories: ["damage", "safety"],
      uploaderIds: ["u1", "u2"],
      from: "2026-05-01",
      to: "2026-05-05",
      includeDeleted: false,
    });
  });

  it("routes field photo upload URL and confirm requests through field-safe services", async () => {
    await invokeRoute("post", "/photos/upload-url", {
      body: { opportunityId: "deal-2", contentType: "image/jpeg", sizeBytes: 1000, category: "damage", caption: "North slope" },
    });
    expect(photoMocks.requestFieldPhotoUploadUrl).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      officeSlug: "trock",
      userId: "admin-1",
      userRole: "admin",
      opportunityId: "deal-2",
      contentType: "image/jpeg",
      sizeBytes: 1000,
      photoCategory: "damage",
      caption: "North slope",
    }));

    await invokeRoute("post", "/photos/confirm-upload", {
      body: {
        opportunityId: "deal-2",
        objectKey: "key",
        uploadToken: "token",
        latitude: 35,
        longitude: -97,
        addressSource: "live_gps",
        takenAt: "2026-05-05T12:00:00.000Z",
      },
      ip: "127.0.0.1",
      headers: { "user-agent": "vitest" },
    });
    expect(photoMocks.confirmFieldPhotoUpload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
      officeId: "office-1",
      opportunityId: "deal-2",
      objectKey: "key",
      uploadToken: "token",
      addressSource: "live_gps",
      auditContext: { ipAddress: "127.0.0.1", userAgent: "vitest" },
    }));
  });

  it("routes field target search through the field-safe search service", async () => {
    projectMocks.searchFieldCaptureTargets.mockResolvedValueOnce({ targets: [] });

    await invokeRoute("get", "/photo-targets/search", { query: { search: "waters", limit: "15" } });

    expect(projectMocks.searchFieldCaptureTargets).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "admin-1",
      userRole: "admin",
    }), {
      search: "waters",
      limit: 15,
    });
  });

  it.each(["abc", "15abc", "-1", "999"])("rejects invalid field target search limit %s with 400", async (limit) => {
    await expect(invokeRoute("get", "/photo-targets/search", { query: { search: "waters", limit } })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(projectMocks.searchFieldCaptureTargets).not.toHaveBeenCalled();
  });

  it("validates URL-selected capture targets before the field app activates capture", async () => {
    await invokeRoute("get", "/photo-targets/validate", { query: { leadId: "lead-1" } });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenCalledWith(expect.anything(), {
      userId: "admin-1",
      userRole: "admin",
      dealId: undefined,
      leadId: "lead-1",
      opportunityId: undefined,
    });
  });
});

async function invokeRoute(method: string, path: string, reqPatch: Record<string, unknown>) {
  const handlers = findRoute(fieldRoutes, method, path);
  const req: Record<string, unknown> = { query: {}, params: {}, body: {}, officeSlug: "trock", ip: undefined, headers: {}, ...reqPatch };
  const res: Record<string, unknown> = {
    body: undefined,
    statusCode: 200,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
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
