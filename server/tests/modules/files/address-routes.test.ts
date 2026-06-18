import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  requestUploadUrl: vi.fn(),
  confirmUpload: vi.fn(),
  uploadNewVersion: vi.fn(),
  getFiles: vi.fn(),
  getFileStats: vi.fn(),
  getFileById: vi.fn(),
  getFileDownloadUrl: vi.fn(),
  updateFile: vi.fn(),
  updateFileAddress: vi.fn(),
  deleteFile: vi.fn(),
  getFileVersions: vi.fn(),
  getTagSuggestions: vi.fn(),
  getDealFolderTree: vi.fn(),
  getDealPhotoTimeline: vi.fn(),
  searchPhotoUploadTargets: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  getDealById: vi.fn(async () => ({ id: "deal-1" })),
  getLeadById: vi.fn(async () => ({ id: "lead-1" })),
  // Deal/lead file access now runs through src/lib/collaboration-access (assertDealFileAccess ->
  // assertDealCollaboratorAccess(tenantDb, dealId, viewer), PR #632), not getDealById/getLeadById.
  assertDealCollaboratorAccess: vi.fn(),
  assertLeadCollaboratorAccess: vi.fn(),
  getPhotoFeed: vi.fn(),
  getNewPhotoCount: vi.fn(),
  getProjectPhotoStats: vi.fn(),
}));

vi.mock("../../../src/modules/files/service.js", () => serviceMocks);
vi.mock("../../../src/modules/deals/service.js", () => ({ getDealById: accessMocks.getDealById }));
vi.mock("../../../src/modules/leads/service.js", () => ({ getLeadById: accessMocks.getLeadById }));
vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  assertLeadCollaboratorAccess: accessMocks.assertLeadCollaboratorAccess,
}));
vi.mock("../../../src/modules/files/feed-service.js", () => ({
  getPhotoFeed: accessMocks.getPhotoFeed,
  getNewPhotoCount: accessMocks.getNewPhotoCount,
  getProjectPhotoStats: accessMocks.getProjectPhotoStats,
}));
vi.mock("../../../src/events/bus.js", () => ({ eventBus: { emitLocal: vi.fn() } }));

const { fileRoutes } = await import("../../../src/modules/files/routes.js");

function findRouteHandler(method: "patch", routePath: string) {
  const layer = (fileRoutes as any).stack.find(
    (entry: any) => entry.route?.path === routePath && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[0].handle as (req: any, res: any, next: (err?: unknown) => void) => unknown;
}

async function invokeAddressPatch(overrides: Record<string, any> = {}) {
  const handler = findRouteHandler("patch", "/:id/address");
  const req = {
    body: { address: "123 Corrected St", latitude: 32.1, longitude: -97.1 },
    params: { id: "file-1" },
    user: {
      id: "user-1",
      role: "admin",
      officeId: "office-1",
      activeOfficeId: "office-1",
    },
    tenantDb: {},
    commitTransaction: vi.fn(),
    ...overrides,
  };
  const res: Record<string, any> = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  let nextError: unknown;
  await handler(req, res, (err?: unknown) => {
    nextError = err;
  });
  return { req, res, nextError };
}

describe("file address override route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.getFileById.mockResolvedValue({
      id: "file-1",
      dealId: "deal-1",
      leadId: null,
      uploadedBy: "user-1",
    });
    serviceMocks.updateFileAddress.mockResolvedValue({
      id: "file-1",
      address: "123 Corrected St",
      addressSource: "manual_override",
      latitude: "32.1000000",
      longitude: "-97.1000000",
    });
  });

  it("updates a photo address manually after validating deal access", async () => {
    const { res, req, nextError } = await invokeAddressPatch();

    expect(nextError).toBeUndefined();
    expect(accessMocks.assertDealCollaboratorAccess).toHaveBeenCalledWith({}, "deal-1", req.user);
    expect(serviceMocks.updateFileAddress).toHaveBeenCalledWith({}, "file-1", {
      address: "123 Corrected St",
      latitude: 32.1,
      longitude: -97.1,
    });
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body.file.addressSource).toBe("manual_override");
  });

  it("rejects unauthenticated direct route invocation", async () => {
    const { nextError } = await invokeAddressPatch({ user: undefined });

    expect((nextError as any).statusCode).toBe(401);
    expect(serviceMocks.updateFileAddress).not.toHaveBeenCalled();
  });

  it("enforces tenant-scoped deal access before updating", async () => {
    accessMocks.assertDealCollaboratorAccess.mockRejectedValueOnce(
      Object.assign(new Error("Access denied: deal is outside your office."), { statusCode: 403 })
    );

    const { nextError } = await invokeAddressPatch({
      user: { id: "rep-1", role: "rep", officeId: "office-1", activeOfficeId: "office-1" },
    });

    expect((nextError as any).statusCode).toBe(403);
    expect(serviceMocks.updateFileAddress).not.toHaveBeenCalled();
  });
});
