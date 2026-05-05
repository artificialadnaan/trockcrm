import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  requestUploadUrl: vi.fn(),
  confirmUpload: vi.fn(),
  uploadNewVersion: vi.fn(),
  getFiles: vi.fn(),
  getFileById: vi.fn(),
  getFileByIdIncludingDeleted: vi.fn(),
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
  getPhotoFeed: vi.fn(),
  getNewPhotoCount: vi.fn(),
  getProjectPhotoStats: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({
  logPhotoEvent: vi.fn(),
  getPhotoAuditEvents: vi.fn(),
}));

vi.mock("../../../src/modules/files/service.js", () => serviceMocks);
vi.mock("../../../src/modules/deals/service.js", () => ({ getDealById: accessMocks.getDealById }));
vi.mock("../../../src/modules/leads/service.js", () => ({ getLeadById: accessMocks.getLeadById }));
vi.mock("../../../src/modules/files/feed-service.js", () => ({
  getPhotoFeed: accessMocks.getPhotoFeed,
  getNewPhotoCount: accessMocks.getNewPhotoCount,
  getProjectPhotoStats: accessMocks.getProjectPhotoStats,
}));
vi.mock("../../../src/modules/files/audit-log-service.js", () => auditMocks);
vi.mock("../../../src/events/bus.js", () => ({ eventBus: { emitLocal: vi.fn() } }));

const { fileRoutes } = await import("../../../src/modules/files/routes.js");

function findRouteHandler(method: "get" | "post" | "patch" | "delete", routePath: string) {
  const layer = (fileRoutes as any).stack.find(
    (entry: any) => entry.route?.path === routePath && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[0].handle as (req: any, res: any, next: (err?: unknown) => void) => unknown;
}

async function invoke(method: "get" | "post" | "patch" | "delete", routePath: string, overrides: Record<string, any> = {}) {
  const handler = findRouteHandler(method, routePath);
  const req = {
    body: {},
    params: { id: "photo-1" },
    query: {},
    headers: { "user-agent": "vitest" },
    ip: "127.0.0.1",
    user: {
      id: "user-1",
      role: "admin",
      officeId: "office-1",
      activeOfficeId: "office-1",
    },
    tenantDb: { execute: vi.fn() },
    officeSlug: "dallas",
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

const existingPhoto = {
  id: "photo-1",
  category: "photo",
  dealId: "deal-1",
  leadId: null,
  uploadedBy: "user-1",
  fileSizeBytes: 2048,
  photoCategory: "damage",
  description: "Old caption",
  address: "100 Main St",
  addressSource: "exif",
  latitude: "35.0000000",
  longitude: "-97.0000000",
  deletedAt: null,
};

describe("photo audit route wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.getFileById.mockResolvedValue(existingPhoto);
    serviceMocks.getFileByIdIncludingDeleted.mockResolvedValue(existingPhoto);
    serviceMocks.confirmUpload.mockResolvedValue(existingPhoto);
    serviceMocks.getFileDownloadUrl.mockResolvedValue({ url: "https://example.test/photo.jpg", filename: "photo.jpg" });
    serviceMocks.updateFile.mockResolvedValue({ ...existingPhoto, photoCategory: "safety", description: "New caption", deletedAt: null });
    serviceMocks.updateFileAddress.mockResolvedValue({
      ...existingPhoto,
      address: "200 Corrected St",
      addressSource: "manual_override",
      latitude: "36.0000000",
      longitude: "-98.0000000",
    });
    serviceMocks.deleteFile.mockResolvedValue({ ...existingPhoto, deletedAt: new Date("2026-05-05T00:00:00.000Z") });
    auditMocks.getPhotoAuditEvents.mockResolvedValue([{ id: "audit-1", eventType: "uploaded" }]);
  });

  it("logs an uploaded event when confirming a photo upload", async () => {
    const { req, nextError } = await invoke("post", "/confirm-upload", {
      body: { uploadToken: "token-1", addressSource: "exif" },
    });

    expect(nextError).toBeUndefined();
    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(req.tenantDb, expect.objectContaining({
      photoId: "photo-1",
      eventType: "uploaded",
      userId: "user-1",
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      metadata: expect.objectContaining({
        addressSource: "exif",
        category: "damage",
        sizeBytes: 2048,
      }),
    }));
  });

  it("logs category and caption changes from the metadata patch route", async () => {
    await invoke("patch", "/:id", {
      body: { photoCategory: "safety", description: "New caption" },
    });

    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: "category_changed",
      metadata: { oldCategory: "damage", newCategory: "safety" },
    }));
    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: "caption_changed",
      metadata: { oldCaption: "Old caption", newCaption: "New caption" },
    }));
  });

  it("logs address, download, delete, and restore events", async () => {
    await invoke("patch", "/:id/address", { body: { address: "200 Corrected St", latitude: 36, longitude: -98 } });
    await invoke("get", "/:id/download");
    await invoke("delete", "/:id");
    serviceMocks.getFileByIdIncludingDeleted.mockResolvedValueOnce({ ...existingPhoto, deletedAt: new Date("2026-05-04T12:00:00.000Z") });
    await invoke("patch", "/:id", { body: { deletedAt: null } });

    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "address_changed" }));
    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "downloaded" }));
    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "deleted" }));
    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: "restored",
      metadata: expect.objectContaining({ previouslyDeletedAt: expect.any(Date) }),
    }));
  });

  it("returns tenant-scoped audit events for a single photo including deleted photos", async () => {
    const { res, req } = await invoke("get", "/:id/audit-log");

    expect(serviceMocks.getFileByIdIncludingDeleted).toHaveBeenCalledWith(req.tenantDb, "photo-1");
    expect(auditMocks.getPhotoAuditEvents).toHaveBeenCalledWith(req.tenantDb, "photo-1");
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body.events).toEqual([{ id: "audit-1", eventType: "uploaded" }]);
  });
});
