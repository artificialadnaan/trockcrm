import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

const projectMocks = vi.hoisted(() => ({
  assertActiveFieldProject: vi.fn(),
  assertAccessibleFieldCaptureTarget: vi.fn(),
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
    assertAccessibleFieldCaptureTarget: projectMocks.assertAccessibleFieldCaptureTarget,
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
  assignPendingFieldPhotoTarget,
  confirmFieldPhotoUpload,
  listPendingFieldPhotos,
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
    projectMocks.assertAccessibleFieldCaptureTarget.mockResolvedValue({ id: "deal-1", type: "deal" });
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
      userRole: "field_contractor",
      dealId: "deal-1",
      contentType: "image/jpeg",
      sizeBytes: 850_000,
      photoCategory: "damage",
      caption: "North slope",
      tags: ["urgent"],
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenCalledWith(db, {
      dealId: "deal-1",
      leadId: undefined,
      opportunityId: undefined,
      userId: "field-1",
      userRole: "field_contractor",
    });
    expect(fileMocks.requestUploadUrl).toHaveBeenCalledWith(db, "trock", "field-1", expect.objectContaining({
      category: "photo",
      dealId: "deal-1",
      mimeType: "image/jpeg",
      fileSizeBytes: 850_000,
      photoCategory: "damage",
      description: "North slope",
      tags: ["urgent"],
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
      userRole: "field_contractor",
      dealId: "deal-1",
      contentType: "application/pdf",
      sizeBytes: 1000,
    })).rejects.toMatchObject({ statusCode: 400 });

    expect(fileMocks.requestUploadUrl).not.toHaveBeenCalled();
  });

  it("allows requesting an upload URL without a selected target so field captures can save to pending", async () => {
    await requestFieldPhotoUploadUrl(db, {
      officeSlug: "trock",
      userId: "field-1",
      userRole: "field_contractor",
      contentType: "image/jpeg",
      sizeBytes: 850_000,
      caption: "Unassigned photo",
      tags: ["pending"],
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).not.toHaveBeenCalled();
    expect(fileMocks.requestUploadUrl).toHaveBeenCalledWith(db, "trock", "field-1", expect.objectContaining({
      dealId: undefined,
      leadId: undefined,
      opportunityId: undefined,
      description: "Unassigned photo",
      tags: ["pending"],
      allowUnassigned: true,
    }));
  });

  it("rejects confirm-upload when the object key does not match the issued upload token", async () => {
    await expect(confirmFieldPhotoUpload(db, {
      userId: "field-1",
      userRole: "field_contractor",
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
      userRole: "field_contractor",
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

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenCalledWith(db, {
      dealId: "deal-1",
      leadId: undefined,
      opportunityId: undefined,
      userId: "field-1",
      userRole: "field_contractor",
    });
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

  it("allows confirming a pending upload without a selected target", async () => {
    fileMocks.getPendingUploadMetadata.mockReturnValueOnce({
      r2Key: "office/unassociated/photos/photo.jpg",
      category: "photo",
    });

    await confirmFieldPhotoUpload(db, {
      userId: "field-1",
      userRole: "field_contractor",
      officeId: "office-1",
      uploadToken: "upload-token-1",
      objectKey: "office/unassociated/photos/photo.jpg",
      auditContext: {},
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).not.toHaveBeenCalled();
    expect(fileMocks.confirmUpload).toHaveBeenCalledWith(db, "field-1", expect.objectContaining({
      uploadToken: "upload-token-1",
    }));
  });

  it("lists pending field photos uploaded by the current user", async () => {
    db.execute.mockResolvedValueOnce({
      rows: [{
        id: "photo-1",
        category: "photo",
        photo_category: "damage",
        subcategory: null,
        display_name: "Pending photo",
        mime_type: "image/jpeg",
        file_size_bytes: 850000,
        file_extension: ".jpg",
        deal_id: null,
        lead_id: null,
        description: null,
        tags: [],
        taken_at: new Date("2026-05-05T12:00:00.000Z"),
        created_at: new Date("2026-05-05T12:01:00.000Z"),
        uploaded_by: "field-1",
        uploader_name: "Field User",
        uploader_avatar_url: null,
        latitude: null,
        longitude: null,
        address: null,
        address_source: null,
        geocoded_at: null,
        procore_sync_status: null,
        deleted_at: null,
      }],
    });

    const result = await listPendingFieldPhotos(db, {
      userId: "field-1",
      userRole: "field_contractor",
    });

    expect(result.photos).toHaveLength(1);
    expect(result.photos[0]).toEqual(expect.objectContaining({
      id: "photo-1",
      displayName: "Pending photo",
      dealId: null,
      leadId: null,
    }));
  });

  it("assigns a pending field photo to a selected target", async () => {
    db.execute.mockResolvedValueOnce({
      rows: [{
        id: "photo-1",
        category: "photo",
        deal_id: null,
        lead_id: null,
        uploaded_by: "field-1",
      }],
    }).mockResolvedValueOnce({
      rows: [{
        id: "photo-1",
        category: "photo",
        photo_category: "damage",
        subcategory: null,
        display_name: "Pending photo",
        mime_type: "image/jpeg",
        file_size_bytes: 850000,
        file_extension: ".jpg",
        deal_id: "deal-1",
        lead_id: null,
        description: null,
        tags: [],
        taken_at: new Date("2026-05-05T12:00:00.000Z"),
        created_at: new Date("2026-05-05T12:01:00.000Z"),
        uploaded_by: "field-1",
        latitude: null,
        longitude: null,
        address: null,
        address_source: null,
        geocoded_at: null,
        procore_sync_status: null,
        deleted_at: null,
      }],
    });
    projectMocks.assertAccessibleFieldCaptureTarget.mockResolvedValueOnce({ id: "deal-1", type: "deal" });
    fileMocks.getFileDownloadUrl.mockResolvedValueOnce({ url: "https://signed.example/photo.jpg" });

    const result = await assignPendingFieldPhotoTarget(db, {
      userId: "field-1",
      userRole: "field_contractor",
    }, {
      photoId: "photo-1",
      dealId: "deal-1",
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenCalledWith(db, {
      dealId: "deal-1",
      leadId: undefined,
      opportunityId: undefined,
      userId: "field-1",
      userRole: "field_contractor",
    });
    expect(result.photo).toEqual(expect.objectContaining({
      id: "photo-1",
      imageUrl: "https://signed.example/photo.jpg",
    }));
  });

  it("assigns a pending field photo to an opportunity target using the same persisted deal linkage as direct uploads", async () => {
    db.execute.mockResolvedValueOnce({
      rows: [{
        id: "photo-1",
        category: "photo",
        deal_id: null,
        lead_id: null,
        uploaded_by: "field-1",
      }],
    }).mockResolvedValueOnce({
      rows: [{
        id: "photo-1",
        category: "photo",
        photo_category: "damage",
        subcategory: null,
        display_name: "Pending photo",
        mime_type: "image/jpeg",
        file_size_bytes: 850000,
        file_extension: ".jpg",
        deal_id: "deal-2",
        lead_id: null,
        description: null,
        tags: [],
        taken_at: new Date("2026-05-05T12:00:00.000Z"),
        created_at: new Date("2026-05-05T12:01:00.000Z"),
        uploaded_by: "field-1",
        latitude: null,
        longitude: null,
        address: null,
        address_source: null,
        geocoded_at: null,
        procore_sync_status: null,
        deleted_at: null,
      }],
    });
    projectMocks.assertAccessibleFieldCaptureTarget.mockResolvedValueOnce({ id: "deal-2", type: "opportunity" });
    fileMocks.getFileDownloadUrl.mockResolvedValueOnce({ url: "https://signed.example/photo.jpg" });

    const result = await assignPendingFieldPhotoTarget(db, {
      userId: "field-1",
      userRole: "field_contractor",
    }, {
      photoId: "photo-1",
      opportunityId: "deal-2",
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenCalledWith(db, {
      dealId: undefined,
      leadId: undefined,
      opportunityId: "deal-2",
      userId: "field-1",
      userRole: "field_contractor",
    });
    expect(result.photo).toEqual(expect.objectContaining({
      id: "photo-1",
      dealId: "deal-2",
      leadId: null,
      imageUrl: "https://signed.example/photo.jpg",
    }));
  });

  it("supports lead photo uploads without forcing a deal-backed project", async () => {
    fileMocks.getPendingUploadMetadata.mockReturnValueOnce({
      r2Key: "office/leads/LD-1/photos/photo.jpg",
      leadId: "lead-1",
      category: "photo",
    });

    await requestFieldPhotoUploadUrl(db, {
      officeSlug: "trock",
      userId: "admin-1",
      userRole: "admin",
      leadId: "lead-1",
      opportunityId: undefined,
      contentType: "image/jpeg",
      sizeBytes: 850_000,
      caption: "Lead photo",
    });

    expect(fileMocks.requestUploadUrl).toHaveBeenLastCalledWith(db, "trock", "admin-1", expect.objectContaining({
      dealId: undefined,
      leadId: "lead-1",
      description: "Lead photo",
    }));

    await confirmFieldPhotoUpload(db, {
      userId: "admin-1",
      userRole: "admin",
      officeId: "office-1",
      leadId: "lead-1",
      opportunityId: undefined,
      uploadToken: "upload-token-1",
      objectKey: "office/leads/LD-1/photos/photo.jpg",
      auditContext: {},
    });

    expect(fileMocks.confirmUpload).toHaveBeenLastCalledWith(db, "admin-1", {
      uploadToken: "upload-token-1",
      latitude: undefined,
      longitude: undefined,
      addressSource: undefined,
      takenAt: undefined,
    });
  });

  it("supports opportunity uploads through opportunityId while storing against the underlying deal", async () => {
    projectMocks.assertAccessibleFieldCaptureTarget.mockResolvedValueOnce({ id: "deal-2", type: "opportunity" });
    fileMocks.getPendingUploadMetadata.mockReturnValueOnce({
      r2Key: "office/deals/TR-2/photos/photo.jpg",
      dealId: "deal-2",
      opportunityId: "deal-2",
      category: "photo",
    });

    await requestFieldPhotoUploadUrl(db, {
      officeSlug: "trock",
      userId: "admin-1",
      userRole: "admin",
      opportunityId: "deal-2",
      contentType: "image/jpeg",
      sizeBytes: 850_000,
      caption: "Opportunity photo",
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenLastCalledWith(db, {
      dealId: undefined,
      leadId: undefined,
      opportunityId: "deal-2",
      userId: "admin-1",
      userRole: "admin",
    });
    expect(fileMocks.requestUploadUrl).toHaveBeenLastCalledWith(db, "trock", "admin-1", expect.objectContaining({
      dealId: "deal-2",
      leadId: undefined,
      opportunityId: "deal-2",
      description: "Opportunity photo",
    }));

    await confirmFieldPhotoUpload(db, {
      userId: "admin-1",
      userRole: "admin",
      officeId: "office-1",
      opportunityId: "deal-2",
      uploadToken: "upload-token-1",
      objectKey: "office/deals/TR-2/photos/photo.jpg",
      auditContext: {},
    });

    expect(fileMocks.confirmUpload).toHaveBeenLastCalledWith(db, "admin-1", {
      uploadToken: "upload-token-1",
      latitude: undefined,
      longitude: undefined,
      addressSource: undefined,
      takenAt: undefined,
    });
  });
});
