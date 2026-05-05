import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

const projectMocks = vi.hoisted(() => ({
  assertActiveFieldProject: vi.fn(),
}));

const fileMocks = vi.hoisted(() => ({
  requestUploadUrl: vi.fn(),
  confirmUpload: vi.fn(),
  getPendingUploadMetadata: vi.fn(),
  getFileDownloadUrl: vi.fn(),
  updateFile: vi.fn(),
}));

const workflowMocks = vi.hoisted(() => ({
  recordUploadedFileSideEffects: vi.fn(),
}));

vi.mock("../../../src/modules/field/projects-service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/field/projects-service.js")>(
    "../../../src/modules/field/projects-service.js"
  );
  return {
    ...actual,
    assertActiveFieldProject: projectMocks.assertActiveFieldProject,
  };
});

vi.mock("../../../src/modules/files/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/files/service.js")>(
    "../../../src/modules/files/service.js"
  );
  return {
    ...actual,
    requestUploadUrl: fileMocks.requestUploadUrl,
    confirmUpload: fileMocks.confirmUpload,
    getPendingUploadMetadata: fileMocks.getPendingUploadMetadata,
    getFileDownloadUrl: fileMocks.getFileDownloadUrl,
    updateFile: fileMocks.updateFile,
  };
});

vi.mock("../../../src/modules/files/upload-workflow.js", () => workflowMocks);

const {
  confirmFieldPhotoUpload,
  requestFieldPhotoUploadUrl,
} = await import("../../../src/modules/field/photos-service.js");

const db = { execute: vi.fn() } as any;

const confirmedFile = {
  id: "photo-1",
  category: "photo",
  photoCategory: "damage",
  subcategory: null,
  displayName: "TR-1_Photo_2026-05-05_001.jpg",
  mimeType: "image/jpeg",
  fileSizeBytes: 850_000,
  fileExtension: ".jpg",
  dealId: "deal-1",
  description: "North slope",
  takenAt: new Date("2026-05-05T12:00:00.000Z"),
  createdAt: new Date("2026-05-05T12:01:00.000Z"),
  uploadedBy: "field-1",
  latitude: "35.123456",
  longitude: "-97.123456",
  address: "123 Main St",
  addressSource: "live_gps",
  geocodedAt: null,
  procoreSyncStatus: null,
  deletedAt: null,
};

describe("field photo upload service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectMocks.assertActiveFieldProject.mockResolvedValue({ id: "deal-1" });
    fileMocks.requestUploadUrl.mockResolvedValue({
      uploadUrl: "https://r2.example/upload",
      r2Key: "office/deals/TR-1/photos/photo.jpg",
      expiresIn: 900,
      systemFilename: "TR-1_Photo_2026-05-05_001.jpg",
      displayName: "TR-1_Photo_2026-05-05_001.jpg",
      folderPath: "Photos/2026-05",
      uploadToken: "upload-token-1",
    });
    fileMocks.getPendingUploadMetadata.mockReturnValue({
      r2Key: "office/deals/TR-1/photos/photo.jpg",
      dealId: "deal-1",
      category: "photo",
    });
    fileMocks.confirmUpload.mockResolvedValue(confirmedFile);
    fileMocks.updateFile.mockResolvedValue(confirmedFile);
    fileMocks.getFileDownloadUrl.mockResolvedValue({ url: "https://signed.example/photo.jpg" });
    workflowMocks.recordUploadedFileSideEffects.mockResolvedValue(undefined);
  });

  it("requests a photo upload URL through the existing file upload service after active-project validation", async () => {
    const result = await requestFieldPhotoUploadUrl(db, {
      officeSlug: "trock",
      userId: "field-1",
      dealId: "deal-1",
      contentType: "image/jpeg",
      sizeBytes: 850_000,
      photoCategory: "damage",
      caption: "North slope",
    });

    expect(projectMocks.assertActiveFieldProject).toHaveBeenCalledWith(db, "deal-1");
    expect(fileMocks.requestUploadUrl).toHaveBeenCalledWith(db, "trock", "field-1", expect.objectContaining({
      category: "photo",
      dealId: "deal-1",
      mimeType: "image/jpeg",
      fileSizeBytes: 850_000,
      photoCategory: "damage",
      description: "North slope",
    }));
    expect(result).toMatchObject({
      uploadUrl: "https://r2.example/upload",
      objectKey: "office/deals/TR-1/photos/photo.jpg",
      uploadToken: "upload-token-1",
    });
  });

  it("rejects non-image upload URL requests before issuing a presigned URL", async () => {
    await expect(requestFieldPhotoUploadUrl(db, {
      officeSlug: "trock",
      userId: "field-1",
      dealId: "deal-1",
      contentType: "application/pdf",
      sizeBytes: 1000,
    })).rejects.toMatchObject({ statusCode: 400 });

    expect(fileMocks.requestUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects confirm-upload when the object key does not match the issued upload token", async () => {
    await expect(confirmFieldPhotoUpload(db, {
      userId: "field-1",
      officeId: "office-1",
      dealId: "deal-1",
      uploadToken: "upload-token-1",
      objectKey: "office/deals/TR-1/photos/spoofed.jpg",
      auditContext: {},
    })).rejects.toEqual(new AppError(400, "objectKey does not match the issued upload."));

    expect(fileMocks.confirmUpload).not.toHaveBeenCalled();
  });

  it("confirms uploads through the existing file confirm service, records upload side effects, and returns field-safe photo", async () => {
    const result = await confirmFieldPhotoUpload(db, {
      userId: "field-1",
      officeId: "office-1",
      dealId: "deal-1",
      uploadToken: "upload-token-1",
      objectKey: "office/deals/TR-1/photos/photo.jpg",
      latitude: 35.123456,
      longitude: -97.123456,
      addressSource: "live_gps",
      takenAt: "2026-05-05T12:00:00.000Z",
      auditContext: { ipAddress: "127.0.0.1", userAgent: "vitest" },
    });

    expect(projectMocks.assertActiveFieldProject).toHaveBeenCalledWith(db, "deal-1");
    expect(fileMocks.confirmUpload).toHaveBeenCalledWith(db, "field-1", {
      uploadToken: "upload-token-1",
      latitude: 35.123456,
      longitude: -97.123456,
      addressSource: "live_gps",
      takenAt: "2026-05-05T12:00:00.000Z",
    });
    expect(workflowMocks.recordUploadedFileSideEffects).toHaveBeenCalledWith(db, expect.objectContaining({
      file: confirmedFile,
      userId: "field-1",
      officeId: "office-1",
      addressSource: "live_gps",
    }));
    expect(result.photo).toEqual(expect.objectContaining({
      id: "photo-1",
      category: "photo",
      photoCategory: "damage",
      imageUrl: "https://signed.example/photo.jpg",
      addressSource: "live_gps",
    }));
    expect(JSON.stringify(result.photo)).not.toContain("r2Key");
  });
});
