import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  requestUploadUrl: vi.fn(),
  confirmUpload: vi.fn(),
  uploadNewVersion: vi.fn(),
  getFiles: vi.fn(),
  getFileStats: vi.fn(),
  getFileById: vi.fn(),
  getFileByIdIncludingDeleted: vi.fn(),
  getPendingUploadMetadata: vi.fn(),
  getFileDownloadUrl: vi.fn(),
  updateFile: vi.fn(),
  updateFileAddress: vi.fn(),
  deleteFile: vi.fn(),
  getFileVersions: vi.fn(),
  getTagSuggestions: vi.fn(),
  getDealFolderTree: vi.fn(),
  getDealPhotoTimeline: vi.fn(),
  searchPhotoUploadTargets: vi.fn(),
  shouldServeExternalFileUrl: vi.fn(() => false),
  shouldLogFileDownloadEvent: vi.fn(() => true),
  resolveFileDownloadAuditPurpose: vi.fn((query: { preview?: unknown }) =>
    query.preview === "1" || query.preview === "true" ? "preview" : "download"
  ),
}));

const accessMocks = vi.hoisted(() => ({
  getDealById: vi.fn(async () => ({ id: "deal-1" })),
  getLeadById: vi.fn(async () => ({ id: "lead-1" })),
  // Deal/lead file-route access now runs through src/lib/collaboration-access (assertDealFileAccess ->
  // assertDealCollaboratorAccess, PR #632). The routes only await the guards (return value unused), so
  // bare vi.fn()s that resolve undefined grant access; without this mock the real guard runs a drizzle
  // query against the {} tenantDb stub and throws.
  assertDealCollaboratorAccess: vi.fn(),
  assertLeadCollaboratorAccess: vi.fn(),
  getPhotoFeed: vi.fn(),
  getNewPhotoCount: vi.fn(),
  getProjectPhotoStats: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({
  logPhotoEvent: vi.fn(),
  getPhotoAuditEvents: vi.fn(),
  writeSoftDeleteAuditLog: vi.fn(),
  writeAuditLog: vi.fn(),
}));

const scopingMocks = vi.hoisted(() => ({
  assertDealScopingWriteAllowed: vi.fn(),
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
vi.mock("../../../src/modules/files/audit-log-service.js", () => auditMocks);
vi.mock("../../../src/lib/soft-delete-audit.js", () => ({
  writeSoftDeleteAuditLog: auditMocks.writeSoftDeleteAuditLog,
}));
vi.mock("../../../src/lib/audit-log.js", () => ({
  writeAuditLog: auditMocks.writeAuditLog,
}));
vi.mock("../../../src/modules/deals/scoping-service.js", () => ({
  assertDealScopingWriteAllowed: scopingMocks.assertDealScopingWriteAllowed,
}));
vi.mock("../../../src/events/bus.js", () => ({ eventBus: { emitLocal: vi.fn() } }));

const { fileRoutes } = await import("../../../src/modules/files/routes.js");

function findRouteHandler(method: "get" | "post" | "patch" | "delete", routePath: string) {
  const layer = (fileRoutes as any).stack.find(
    (entry: any) => entry.route?.path === routePath && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack.map((entry: any) => entry.handle) as Array<
    (req: any, res: any, next: (err?: unknown) => void) => unknown
  >;
}

async function invoke(method: "get" | "post" | "patch" | "delete", routePath: string, overrides: Record<string, any> = {}) {
  const handlers = findRouteHandler(method, routePath);
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
    send(payload?: any) {
      res.body = payload;
      return res;
    },
  };
  let nextError: unknown;
  let index = 0;
  const pendingHandlers: Promise<void>[] = [];
  const next = async (err?: unknown): Promise<void> => {
    if (err) {
      nextError = err;
      return;
    }
    const handler = handlers[index++];
    if (!handler) return;
    const pending = Promise.resolve(handler(req, res, next)).then(() => undefined);
    pendingHandlers.push(pending);
    await pending;
  };
  await next();
  for (let pendingIndex = 0; pendingIndex < pendingHandlers.length; pendingIndex += 1) {
    await pendingHandlers[pendingIndex];
  }
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
    scopingMocks.assertDealScopingWriteAllowed.mockReset();
    serviceMocks.getFileById.mockResolvedValue(existingPhoto);
    serviceMocks.getFileByIdIncludingDeleted.mockResolvedValue(existingPhoto);
    serviceMocks.getPendingUploadMetadata.mockReturnValue(null);
    serviceMocks.requestUploadUrl.mockResolvedValue({
      uploadUrl: "https://r2.example/upload",
      r2Key: "office/dallas/photo.jpg",
      expiresIn: 900,
      systemFilename: "photo.jpg",
      displayName: "photo.jpg",
      folderPath: "Photos",
      uploadToken: "upload-token-1",
    });
    serviceMocks.confirmUpload.mockResolvedValue({ file: existingPhoto, created: true });
    serviceMocks.uploadNewVersion.mockResolvedValue({ file: { id: "version-2", parentFileId: "photo-1" } });
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
    scopingMocks.assertDealScopingWriteAllowed.mockResolvedValue({
      adminOverride: false,
      lockState: { locked: false, reason: null, submittedAt: null },
    });
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

  it("allows upload URL requests for locked deal files because generic uploads stay available", async () => {
    const { nextError } = await invoke("post", "/upload-url", {
      body: {
        originalFilename: "scope.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 2048,
        category: "other",
        dealId: "deal-1",
      },
    });

    expect(nextError).toBeUndefined();
    expect(scopingMocks.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(serviceMocks.requestUploadUrl).toHaveBeenCalled();
  });

  it("does not write admin override audit rows for locked deal upload URL requests", async () => {
    const { nextError } = await invoke("post", "/upload-url", {
      body: {
        originalFilename: "scope.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 2048,
        category: "other",
        dealId: "deal-1",
        forceEditAfterRfp: true,
      },
    });

    expect(nextError).toBeUndefined();
    expect(serviceMocks.requestUploadUrl).toHaveBeenCalled();
    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("allows direct uploads for locked deal files because generic uploads stay available", async () => {
    const { nextError } = await invoke("post", "/upload-direct", {
      body: Buffer.from("file-bytes"),
      headers: {
        "user-agent": "vitest",
        "x-original-filename": encodeURIComponent("scope.pdf"),
        "content-type": "application/pdf",
        "x-file-category": "other",
        "x-deal-id": "deal-1",
      },
    });

    expect(nextError).toBeUndefined();
    expect(scopingMocks.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(serviceMocks.requestUploadUrl).toHaveBeenCalled();
    expect(serviceMocks.confirmUpload).toHaveBeenCalled();
  });

  it("allows confirming a pending locked deal upload because confirmation is not scope-specific", async () => {
    serviceMocks.getPendingUploadMetadata.mockReturnValueOnce({ dealId: "deal-1" });

    const { nextError } = await invoke("post", "/confirm-upload", {
      body: { uploadToken: "upload-token-1" },
    });

    expect(nextError).toBeUndefined();
    expect(scopingMocks.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(serviceMocks.confirmUpload).toHaveBeenCalled();
  });

  it("does not write admin override audit rows when confirming a locked deal upload", async () => {
    serviceMocks.getPendingUploadMetadata.mockReturnValueOnce({ dealId: "deal-1" });

    const { nextError } = await invoke("post", "/confirm-upload", {
      body: { uploadToken: "upload-token-1", forceEditAfterRfp: true },
    });

    expect(nextError).toBeUndefined();
    expect(serviceMocks.confirmUpload).toHaveBeenCalled();
    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
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

  it("reclassifies a photo to the 'other' file category instead of treating it as a photo phase", async () => {
    // "other" is BOTH a legacy photo-phase value and a real file category. Editing a photo to Other in
    // the generic file-edit modal must change the FILE category (not clobber the photo phase / drop the
    // subfolder). resolvedPhotoCategory stays undefined -> category "other" flows to updateFile.
    await invoke("patch", "/:id", { body: { category: "other", subcategory: null } });

    expect(serviceMocks.updateFile).toHaveBeenCalledWith(
      expect.anything(),
      "photo-1",
      expect.objectContaining({ category: "other", photoCategory: undefined, subcategory: null })
    );
    // A genuine file-category reclassification is not a photo phase change.
    expect(auditMocks.logPhotoEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "category_changed" })
    );
  });

  it("still treats a photo-exclusive category value as a photo-phase edit (legacy client)", async () => {
    // "construction" is a photo-only value; a legacy client sending it in `category` should update the
    // photo phase, leaving the file category untouched.
    await invoke("patch", "/:id", { body: { category: "construction" } });

    expect(serviceMocks.updateFile).toHaveBeenCalledWith(
      expect.anything(),
      "photo-1",
      expect.objectContaining({ category: undefined, photoCategory: "construction" })
    );
  });

  it("logs address, download, delete, and restore events", async () => {
    await invoke("patch", "/:id/address", { body: { address: "200 Corrected St", latitude: 36, longitude: -98 } });
    await invoke("get", "/:id/download");
    await invoke("delete", "/:id");
    serviceMocks.getFileByIdIncludingDeleted.mockResolvedValueOnce({ ...existingPhoto, deletedAt: new Date("2026-05-04T12:00:00.000Z") });
    await invoke("patch", "/:id", { body: { deletedAt: null } });

    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "address_changed" }));
    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: "downloaded",
      metadata: { purpose: "download" },
    }));
    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "deleted" }));
    expect(auditMocks.writeSoftDeleteAuditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorUserId: "user-1",
      entityType: "file",
      entityId: "photo-1",
    }));
    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: "restored",
      metadata: expect.objectContaining({ previouslyDeletedAt: expect.any(Date) }),
    }));
  });

  it("logs preview download URL access instead of letting preview bypass audit", async () => {
    await invoke("get", "/:id/download", { query: { preview: "1" } });

    expect(serviceMocks.shouldLogFileDownloadEvent).toHaveBeenCalledWith({ preview: "1" });
    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: "downloaded",
      metadata: { purpose: "preview" },
    }));
  });

  it("allows metadata changes to linked scoping files when the scope is locked", async () => {
    serviceMocks.getFileById.mockResolvedValueOnce({
      ...existingPhoto,
      intakeSource: "scoping_intake",
      intakeRequirementKey: "site_photos",
    });

    const { nextError } = await invoke("patch", "/:id", {
      body: { category: "other" },
      user: { id: "rep-1", role: "rep", officeId: "office-1", activeOfficeId: "office-1" },
    });

    expect(nextError).toBeUndefined();
    expect(scopingMocks.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(serviceMocks.updateFile).toHaveBeenCalled();
  });

  it("allows metadata changes to linked scoping files even when the deal scope is locked", async () => {
    serviceMocks.getFileById.mockResolvedValueOnce({
      ...existingPhoto,
      intakeSource: "scoping_intake",
      intakeRequirementKey: "site_photos",
    });

    const { nextError } = await invoke("patch", "/:id", {
      body: { displayName: "Corrected site photo name" },
      user: { id: "rep-1", role: "rep", officeId: "office-1", activeOfficeId: "office-1" },
    });

    expect(nextError).toBeUndefined();
    expect(scopingMocks.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(serviceMocks.updateFile).toHaveBeenCalled();
  });

  it("does not write admin override audit rows for linked scoping metadata changes", async () => {
    serviceMocks.getFileById.mockResolvedValueOnce({
      ...existingPhoto,
      intakeSource: "scoping_intake",
      intakeRequirementKey: "site_photos",
    });

    await invoke("patch", "/:id", {
      body: { displayName: "Corrected name", forceEditAfterRfp: true },
    });

    expect(serviceMocks.updateFile).toHaveBeenCalled();
    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("allows metadata changes to regular deal files when the deal scope is locked", async () => {
    serviceMocks.getFileById.mockResolvedValueOnce({
      ...existingPhoto,
      intakeSource: null,
      intakeRequirementKey: null,
    });

    const { nextError } = await invoke("patch", "/:id", {
      body: { displayName: "Locked rename" },
    });

    expect(nextError).toBeUndefined();
    expect(scopingMocks.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(serviceMocks.updateFile).toHaveBeenCalled();
  });

  it("does not require admin override for regular deal metadata changes on locked scopes", async () => {
    serviceMocks.getFileById.mockResolvedValueOnce({
      ...existingPhoto,
      intakeSource: null,
      intakeRequirementKey: null,
    });

    const { nextError } = await invoke("patch", "/:id", {
      body: { displayName: "Forced regular rename", forceEditAfterRfp: true },
    });

    expect(nextError).toBeUndefined();
    expect(scopingMocks.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(serviceMocks.updateFile).toHaveBeenCalled();
    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("ignores forceEditAfterRfp on unlocked metadata changes for non-admin users", async () => {
    const { nextError } = await invoke("patch", "/:id", {
      body: { displayName: "Rep forced rename", forceEditAfterRfp: true },
      user: { id: "rep-1", role: "rep", officeId: "office-1", activeOfficeId: "office-1" },
    });

    expect(nextError).toBeUndefined();
    expect(scopingMocks.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(serviceMocks.updateFile).toHaveBeenCalled();
  });

  it("requires forced admin override before deleting a linked scoping file from a locked scope", async () => {
    serviceMocks.getFileById.mockResolvedValueOnce({
      ...existingPhoto,
      intakeSource: "scoping_intake",
      intakeRequirementKey: "site_photos",
    });
    scopingMocks.assertDealScopingWriteAllowed.mockRejectedValueOnce(
      Object.assign(new Error("Scope is read-only after RFP submission"), {
        statusCode: 403,
        code: "SCOPE_READ_ONLY_AFTER_RFP",
      })
    );

    const { nextError } = await invoke("delete", "/:id");

    expect(nextError).toMatchObject({ statusCode: 403 });
    expect(serviceMocks.deleteFile).not.toHaveBeenCalled();
  });

  it("allows linked scoping photo address metadata changes without override", async () => {
    serviceMocks.getFileById.mockResolvedValueOnce({
      ...existingPhoto,
      intakeSource: "scoping_intake",
      intakeRequirementKey: "site_photos",
    });

    const { nextError } = await invoke("patch", "/:id/address", {
      body: { address: "200 Locked St", latitude: 36, longitude: -98 },
    });

    expect(nextError).toBeUndefined();
    expect(scopingMocks.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(serviceMocks.updateFileAddress).toHaveBeenCalled();
  });

  it("allows photo address corrections on linked scoping photos even when the deal scope is locked", async () => {
    serviceMocks.getFileById.mockResolvedValueOnce({
      ...existingPhoto,
      intakeSource: "scoping_intake",
      intakeRequirementKey: "site_photos",
    });

    const { nextError } = await invoke("patch", "/:id/address", {
      body: { address: "200 Corrected St", latitude: 36, longitude: -98 },
      user: { id: "rep-1", role: "rep", officeId: "office-1", activeOfficeId: "office-1" },
    });

    expect(nextError).toBeUndefined();
    expect(scopingMocks.assertDealScopingWriteAllowed).not.toHaveBeenCalled();
    expect(serviceMocks.updateFileAddress).toHaveBeenCalled();
  });

  it("does not write admin override audit rows for linked scoping photo address edits", async () => {
    serviceMocks.getFileById.mockResolvedValueOnce({
      ...existingPhoto,
      intakeSource: "scoping_intake",
      intakeRequirementKey: "site_photos",
    });

    const { nextError } = await invoke("patch", "/:id/address", {
      body: { address: "200 Corrected St", latitude: 36, longitude: -98, forceEditAfterRfp: true },
    });

    expect(nextError).toBeUndefined();
    expect(serviceMocks.updateFileAddress).toHaveBeenCalled();
    expect(auditMocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("requires forced admin override before adding a new version to a linked scoping file", async () => {
    serviceMocks.getFileById.mockResolvedValueOnce({
      ...existingPhoto,
      intakeSource: "scoping_intake",
      intakeRequirementKey: "site_photos",
    });
    scopingMocks.assertDealScopingWriteAllowed.mockRejectedValueOnce(
      Object.assign(new Error("Scope is read-only after RFP submission"), {
        statusCode: 403,
        code: "SCOPE_READ_ONLY_AFTER_RFP",
      })
    );

    const { nextError } = await invoke("post", "/:id/new-version", {
      body: {
        originalFilename: "updated.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: 4096,
        category: "photo",
      },
    });

    expect(nextError).toMatchObject({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });
    expect(serviceMocks.uploadNewVersion).not.toHaveBeenCalled();
  });

  it("audits forced admin new versions on linked scoping files", async () => {
    serviceMocks.getFileById.mockResolvedValueOnce({
      ...existingPhoto,
      intakeSource: "scoping_intake",
      intakeRequirementKey: "site_photos",
    });
    scopingMocks.assertDealScopingWriteAllowed.mockResolvedValueOnce({
      adminOverride: true,
      lockState: { locked: true, reason: "rfp_submission", submittedAt: new Date("2026-05-12T12:00:00.000Z") },
    });

    const { nextError } = await invoke("post", "/:id/new-version", {
      body: {
        originalFilename: "updated.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: 4096,
        category: "photo",
        forceEditAfterRfp: true,
      },
    });

    expect(nextError).toBeUndefined();
    expect(serviceMocks.uploadNewVersion).toHaveBeenCalled();
    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tableName: "deal_scoping_intake",
      recordId: "deal-1",
      changedBy: "user-1",
      fullRow: expect.objectContaining({
        override: "admin_force_edit_after_rfp",
        route: "files",
        action: "new_version",
        fileId: "photo-1",
      }),
    }));
  });

  it("rejects non-admin file deletes before soft-delete", async () => {
    const { nextError } = await invoke("delete", "/:id", {
      user: {
        id: "director-1",
        role: "director",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
    });

    expect((nextError as any).statusCode).toBe(403);
    expect(serviceMocks.deleteFile).not.toHaveBeenCalled();
    expect(auditMocks.logPhotoEvent).not.toHaveBeenCalled();
  });

  it("returns tenant-scoped audit events for a single photo including deleted photos", async () => {
    const { res, req } = await invoke("get", "/:id/audit-log");

    expect(serviceMocks.getFileByIdIncludingDeleted).toHaveBeenCalledWith(req.tenantDb, "photo-1");
    expect(auditMocks.getPhotoAuditEvents).toHaveBeenCalledWith(req.tenantDb, "photo-1");
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body.events).toEqual([{ id: "audit-1", eventType: "uploaded" }]);
  });

  it("passes server-side file kind and linked type filters to the list service", async () => {
    serviceMocks.getFiles.mockResolvedValue({ files: [], pagination: { page: 1, limit: 200, total: 0, totalPages: 0 } });

    const { req, nextError } = await invoke("get", "/", {
      query: {
        fileKind: "documents",
        linkedType: "change_order",
        limit: "200",
      },
    });

    expect(nextError).toBeUndefined();
    expect(serviceMocks.getFiles).toHaveBeenCalledWith(req.tenantDb, expect.objectContaining({
      fileKind: "documents",
      linkedType: "change_order",
      limit: 200,
    }));
  });

  it("returns office-wide file stats through a separate stats endpoint", async () => {
    serviceMocks.getFileStats.mockResolvedValue({
      totalFiles: 10,
      totalPhotos: 4,
      totalDocuments: 6,
      totalBytes: 12345,
      recentUploads: 2,
      dealsWithFiles: 3,
    });

    const { req, res, nextError } = await invoke("get", "/stats");

    expect(nextError).toBeUndefined();
    expect(serviceMocks.getFileStats).toHaveBeenCalledWith(req.tenantDb, {});
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body.stats.totalFiles).toBe(10);
  });
});
