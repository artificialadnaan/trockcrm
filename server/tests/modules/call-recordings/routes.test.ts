import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  createUploadUrl: vi.fn(),
  confirmUpload: vi.fn(),
  listForEntity: vi.fn(),
  getPlaybackUrl: vi.fn(),
  softDelete: vi.fn(),
}));

const entityMocks = vi.hoisted(() => ({
  getDealById: vi.fn(async () => ({ id: "deal-1" })),
  getLeadById: vi.fn(async () => ({ id: "lead-1" })),
  getCompanyById: vi.fn(async () => ({ id: "company-1" })),
  getContactById: vi.fn(async () => ({ id: "contact-1" })),
}));

vi.mock("../../../src/modules/call-recordings/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/call-recordings/service.js")>(
    "../../../src/modules/call-recordings/service.js"
  );
  return {
    ...actual,
    createUploadUrl: serviceMocks.createUploadUrl,
    confirmUpload: serviceMocks.confirmUpload,
    listForEntity: serviceMocks.listForEntity,
    getPlaybackUrl: serviceMocks.getPlaybackUrl,
    softDelete: serviceMocks.softDelete,
  };
});

vi.mock("../../../src/modules/deals/service.js", () => ({
  getDealById: entityMocks.getDealById,
}));

vi.mock("../../../src/modules/leads/service.js", () => ({
  getLeadById: entityMocks.getLeadById,
}));

vi.mock("../../../src/modules/companies/service.js", () => ({
  getCompanyById: entityMocks.getCompanyById,
}));

vi.mock("../../../src/modules/contacts/service.js", () => ({
  getContactById: entityMocks.getContactById,
}));

const { callRecordingRoutes } = await import("../../../src/modules/call-recordings/routes.js");

type TestRole = "admin" | "director" | "rep" | "construction";

function testUser(role: TestRole, id = `${role}-1`) {
  return {
    id,
    role,
    officeId: "office-1",
    activeOfficeId: "office-1",
  };
}

const ownRecording = { id: "own", uploadedBy: "rep-1" };
const otherRecording = { id: "other", uploadedBy: "admin-1" };

function mockListForCurrentUser() {
  serviceMocks.listForEntity.mockImplementation(async (_tenantDb, _entityType, _entityId, viewer) => {
    if (viewer.role === "construction") return [];
    if (viewer.role === "rep") {
      return [ownRecording, otherRecording].filter((recording) => recording.uploadedBy === viewer.userId);
    }
    return [ownRecording, otherRecording];
  });
}

function findRouteHandler(method: "get" | "post" | "delete", routePath: string) {
  const layer = (callRecordingRoutes as any).stack.find(
    (entry: any) => entry.route?.path === routePath && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[0].handle as (req: any, res: any, next: (err?: unknown) => void) => unknown;
}

async function invokeRoute(method: "get" | "post" | "delete", routePath: string, overrides: Record<string, any> = {}) {
  const handler = findRouteHandler(method, routePath);
  const req = {
    body: {},
    query: {},
    params: {},
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

describe("call recording routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-admin upload-url requests", async () => {
    const { nextError } = await invokeRoute("post", "/upload-url", {
      user: testUser("rep"),
      body: { entityType: "deal", entityId: "deal-1", filename: "call.m4a", mimeType: "audio/m4a" },
    });

    expect((nextError as any).statusCode).toBe(403);
    expect(serviceMocks.createUploadUrl).not.toHaveBeenCalled();
  });

  it("lets reps list only their own recordings", async () => {
    mockListForCurrentUser();

    const list = await invokeRoute("get", "/", {
      user: testUser("rep", "rep-1"),
      query: { entityType: "deal", entityId: "deal-1" },
    });

    expect(list.res.statusCode).toBe(200);
    expect(list.res.body.recordings).toEqual([ownRecording]);
    expect(serviceMocks.listForEntity).toHaveBeenCalledWith(
      expect.anything(),
      "deal",
      "deal-1",
      { role: "rep", userId: "rep-1" }
    );
  });

  it("returns an empty list for reps with no uploaded recordings on the entity", async () => {
    mockListForCurrentUser();

    const list = await invokeRoute("get", "/", {
      user: testUser("rep", "rep-2"),
      query: { entityType: "deal", entityId: "deal-1" },
    });

    expect(list.res.statusCode).toBe(200);
    expect(list.res.body.recordings).toEqual([]);
  });

  it("lets directors list all recordings", async () => {
    mockListForCurrentUser();

    const list = await invokeRoute("get", "/", {
      user: testUser("director"),
      query: { entityType: "deal", entityId: "deal-1" },
    });

    expect(list.res.statusCode).toBe(200);
    expect(list.res.body.recordings).toEqual([ownRecording, otherRecording]);
  });

  it("lets admins list all recordings", async () => {
    mockListForCurrentUser();

    const list = await invokeRoute("get", "/", {
      user: testUser("admin"),
      query: { entityType: "deal", entityId: "deal-1" },
    });

    expect(list.res.statusCode).toBe(200);
    expect(list.res.body.recordings).toEqual([ownRecording, otherRecording]);
  });

  it("returns an empty list for construction users", async () => {
    mockListForCurrentUser();

    const list = await invokeRoute("get", "/", {
      user: testUser("construction"),
      query: { entityType: "deal", entityId: "deal-1" },
    });

    expect(list.res.statusCode).toBe(200);
    expect(list.res.body.recordings).toEqual([]);
  });

  it("allows non-admin users to play recordings", async () => {
    serviceMocks.getPlaybackUrl.mockResolvedValue({ playbackUrl: "https://example.test/play" });

    const playback = await invokeRoute("get", "/:id/playback", {
      user: testUser("rep"),
      params: { id: "rec-1" },
    });

    expect(playback.res.body.playbackUrl).toBe("https://example.test/play");
  });

  it("rejects non-admin deletes", async () => {
    const { nextError } = await invokeRoute("delete", "/:id", {
      user: testUser("rep"),
      params: { id: "rec-1" },
    });

    expect((nextError as any).statusCode).toBe(403);
    expect(serviceMocks.softDelete).not.toHaveBeenCalled();
  });

  it("rejects non-admin upload confirmations", async () => {
    const { nextError } = await invokeRoute("post", "/:id/confirm", {
      user: testUser("rep"),
      params: { id: "rec-1" },
      body: { fileSizeBytes: 100, durationSeconds: 10 },
    });

    expect((nextError as any).statusCode).toBe(403);
    expect(serviceMocks.confirmUpload).not.toHaveBeenCalled();
  });
});
