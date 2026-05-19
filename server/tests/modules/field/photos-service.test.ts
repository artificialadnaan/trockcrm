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

vi.mock("../../../src/modules/field/projects-service.js", () => ({
  assertActiveFieldProject: projectMocks.assertActiveFieldProject,
  assertAccessibleFieldCaptureTarget: projectMocks.assertAccessibleFieldCaptureTarget,
}));

vi.mock("../../../src/modules/files/service.js", () => ({
  requestUploadUrl: fileMocks.requestUploadUrl,
  confirmUpload: fileMocks.confirmUpload,
  getPendingUploadMetadata: fileMocks.getPendingUploadMetadata,
  getFileDownloadUrl: fileMocks.getFileDownloadUrl,
  updateFile: fileMocks.updateFile,
}));

vi.mock("../../../src/modules/files/upload-workflow.js", () => workflowMocks);

const {
  assignPendingFieldPhotoTarget,
  confirmFieldPhotoUpload,
  listPendingFieldPhotos,
  requestFieldPhotoUploadUrl,
} = await import("../../../src/modules/field/photos-service.js");

const db = { execute: vi.fn() } as any;
const FIELD_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OFFICE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEAL_ID = "11111111-1111-4111-8111-111111111111";
const DEAL_TWO_ID = "22222222-2222-4222-8222-222222222222";
const LEAD_ID = "33333333-3333-4333-8333-333333333333";
const PHOTO_ID = "44444444-4444-4444-8444-444444444444";
const PENDING_PHOTO_ID = "55555555-5555-4555-8555-555555555555";
const PENDING_OPPORTUNITY_PHOTO_ID = "66666666-6666-4666-8666-666666666666";
const UUID_V7 = "019e4188-7d1b-7860-a57d-fb59484cd705";

const confirmedFile = {
  id: PHOTO_ID,
  category: "photo",
  photoCategory: "damage",
  subcategory: null,
  displayName: "TR-1_Photo_2026-05-05_001.jpg",
  mimeType: "image/jpeg",
  fileSizeBytes: 850_000,
  fileExtension: ".jpg",
  dealId: DEAL_ID,
  description: "North slope",
  takenAt: new Date("2026-05-05T12:00:00.000Z"),
  createdAt: new Date("2026-05-05T12:01:00.000Z"),
  uploadedBy: FIELD_USER_ID,
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
    db.execute.mockReset();
    projectMocks.assertActiveFieldProject.mockResolvedValue({ id: DEAL_ID });
    projectMocks.assertAccessibleFieldCaptureTarget.mockResolvedValue({ id: DEAL_ID, type: "deal" });
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
      dealId: DEAL_ID,
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
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
      dealId: DEAL_ID,
      contentType: "image/jpeg",
      sizeBytes: 850_000,
      photoCategory: "damage",
      caption: "North slope",
      tags: ["urgent"],
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenCalledWith(db, {
      dealId: DEAL_ID,
      leadId: undefined,
      opportunityId: undefined,
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    });
    expect(fileMocks.requestUploadUrl).toHaveBeenCalledWith(db, "trock", FIELD_USER_ID, expect.objectContaining({
      category: "photo",
      dealId: DEAL_ID,
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
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
      dealId: DEAL_ID,
      contentType: "application/pdf",
      sizeBytes: 1000,
    })).rejects.toMatchObject({ statusCode: 400 });

    expect(fileMocks.requestUploadUrl).not.toHaveBeenCalled();
  });

  it("allows requesting an upload URL without a selected target so field captures can save to pending", async () => {
    await requestFieldPhotoUploadUrl(db, {
      officeSlug: "trock",
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
      contentType: "image/jpeg",
      sizeBytes: 850_000,
      caption: "Unassigned photo",
      tags: ["pending"],
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).not.toHaveBeenCalled();
    expect(fileMocks.requestUploadUrl).toHaveBeenCalledWith(db, "trock", FIELD_USER_ID, expect.objectContaining({
      dealId: undefined,
      leadId: undefined,
      opportunityId: undefined,
      description: "Unassigned photo",
      tags: ["pending"],
      allowUnassigned: true,
    }));
  });

  it("treats empty-string target ids the same as a missing target", async () => {
    await requestFieldPhotoUploadUrl(db, {
      officeSlug: "trock",
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
      dealId: "",
      leadId: "   ",
      opportunityId: "",
      contentType: "image/jpeg",
      sizeBytes: 850_000,
      caption: "Unassigned photo",
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).not.toHaveBeenCalled();
    expect(fileMocks.requestUploadUrl).toHaveBeenCalledWith(db, "trock", FIELD_USER_ID, expect.objectContaining({
      dealId: undefined,
      leadId: undefined,
      opportunityId: undefined,
      allowUnassigned: true,
    }));
  });

  it("rejects confirm-upload when the object key does not match the issued upload token", async () => {
    await expect(confirmFieldPhotoUpload(db, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
      officeId: OFFICE_ID,
      dealId: DEAL_ID,
      uploadToken: "upload-token-1",
      objectKey: "office/deals/TR-1/photos/spoofed.jpg",
      auditContext: {},
    })).rejects.toEqual(new AppError(400, "objectKey does not match the issued upload."));

    expect(fileMocks.confirmUpload).not.toHaveBeenCalled();
  });

  it("confirms uploads through the existing file confirm service, records upload side effects, and returns field-safe photo", async () => {
    const result = await confirmFieldPhotoUpload(db, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
      officeId: OFFICE_ID,
      dealId: DEAL_ID,
      uploadToken: "upload-token-1",
      objectKey: "office/deals/TR-1/photos/photo.jpg",
      latitude: 35.123456,
      longitude: -97.123456,
      addressSource: "live_gps",
      takenAt: "2026-05-05T12:00:00.000Z",
      auditContext: { ipAddress: "127.0.0.1", userAgent: "vitest" },
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenCalledWith(db, {
      dealId: DEAL_ID,
      leadId: undefined,
      opportunityId: undefined,
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    });
    expect(fileMocks.confirmUpload).toHaveBeenCalledWith(db, FIELD_USER_ID, {
      uploadToken: "upload-token-1",
      latitude: 35.123456,
      longitude: -97.123456,
      addressSource: "live_gps",
      takenAt: "2026-05-05T12:00:00.000Z",
    });
    expect(workflowMocks.recordUploadedFileSideEffects).toHaveBeenCalledWith(db, expect.objectContaining({
      file: confirmedFile,
      userId: FIELD_USER_ID,
      officeId: OFFICE_ID,
      addressSource: "live_gps",
    }));
    expect(result.photo).toEqual(expect.objectContaining({
      id: PHOTO_ID,
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
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
      officeId: OFFICE_ID,
      uploadToken: "upload-token-1",
      objectKey: "office/unassociated/photos/photo.jpg",
      auditContext: {},
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).not.toHaveBeenCalled();
    expect(fileMocks.confirmUpload).toHaveBeenCalledWith(db, FIELD_USER_ID, expect.objectContaining({
      uploadToken: "upload-token-1",
    }));
  });

  it("lists pending field photos uploaded by the current user", async () => {
    db.execute.mockResolvedValueOnce({
      rows: [{
        id: PHOTO_ID,
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
        uploaded_by: FIELD_USER_ID,
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
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    });

    expect(result.photos).toHaveLength(1);
    expect(result.photos[0]).toEqual(expect.objectContaining({
      id: PHOTO_ID,
      displayName: "Pending photo",
      dealId: null,
      leadId: null,
    }));
  });

  it("falls back to the legacy pending-photo query when extended linkage columns are missing", async () => {
    db.execute
      .mockRejectedValueOnce(Object.assign(new Error('column "contact_id" does not exist'), { code: "42703" }))
      .mockResolvedValueOnce({
        rows: [{
          id: PHOTO_ID,
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
          uploaded_by: FIELD_USER_ID,
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
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    });

    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(result.photos).toHaveLength(1);
    expect(result.photos[0].id).toBe(PHOTO_ID);
    expect(fileMocks.getFileDownloadUrl).toHaveBeenCalledWith(db, PHOTO_ID);
  });

  it("assigns a pending field photo to a selected target", async () => {
    db.execute.mockResolvedValueOnce({
      rows: [{
        id: PENDING_PHOTO_ID,
        category: "photo",
        deal_id: null,
        lead_id: null,
        uploaded_by: FIELD_USER_ID,
      }],
    }).mockResolvedValueOnce({
      rows: [{
        id: PENDING_PHOTO_ID,
        category: "photo",
        photo_category: "damage",
        subcategory: null,
        display_name: "Pending photo",
        mime_type: "image/jpeg",
        file_size_bytes: 850000,
        file_extension: ".jpg",
        deal_id: DEAL_ID,
        lead_id: null,
        description: null,
        tags: [],
        taken_at: new Date("2026-05-05T12:00:00.000Z"),
        created_at: new Date("2026-05-05T12:01:00.000Z"),
        uploaded_by: FIELD_USER_ID,
        latitude: null,
        longitude: null,
        address: null,
        address_source: null,
        geocoded_at: null,
        procore_sync_status: null,
        deleted_at: null,
      }],
    });
    projectMocks.assertAccessibleFieldCaptureTarget.mockResolvedValueOnce({ id: DEAL_ID, type: "deal" });
    fileMocks.getFileDownloadUrl.mockResolvedValueOnce({ url: "https://signed.example/photo.jpg" });

    const result = await assignPendingFieldPhotoTarget(db, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    }, {
      photoId: PENDING_PHOTO_ID,
      dealId: DEAL_ID,
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenCalledWith(db, {
      dealId: DEAL_ID,
      leadId: undefined,
      opportunityId: undefined,
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    });
    expect(result.photo).toEqual(expect.objectContaining({
      id: PENDING_PHOTO_ID,
      imageUrl: "https://signed.example/photo.jpg",
    }));
  });

  it("rejects malformed pending photo ids with 400 before any uuid cast reaches postgres", async () => {
    await expect(assignPendingFieldPhotoTarget(db, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    }, {
      photoId: "not-a-uuid",
      dealId: DEAL_ID,
    })).rejects.toEqual(new AppError(400, "Invalid photoId: must be a UUID."));

    expect(projectMocks.assertAccessibleFieldCaptureTarget).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("rejects malformed target ids with 400 before any target lookup reaches postgres", async () => {
    await expect(assignPendingFieldPhotoTarget(db, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    }, {
      photoId: PENDING_PHOTO_ID,
      dealId: "not-a-uuid",
    })).rejects.toEqual(new AppError(400, "Invalid dealId: must be a UUID."));

    expect(projectMocks.assertAccessibleFieldCaptureTarget).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("accepts non-v1-v5 UUIDs that Postgres still treats as valid uuids", async () => {
    const localDb = { execute: vi.fn() } as any;
    localDb.execute.mockResolvedValueOnce({
      rows: [{
        id: UUID_V7,
        category: "photo",
        deal_id: null,
        lead_id: null,
        uploaded_by: FIELD_USER_ID,
      }],
    }).mockResolvedValueOnce({
      rows: [{
        id: UUID_V7,
        category: "photo",
        photo_category: "damage",
        subcategory: null,
        display_name: "Pending photo",
        mime_type: "image/jpeg",
        file_size_bytes: 850000,
        file_extension: ".jpg",
        deal_id: UUID_V7,
        lead_id: null,
        description: null,
        tags: [],
        taken_at: new Date("2026-05-05T12:00:00.000Z"),
        created_at: new Date("2026-05-05T12:01:00.000Z"),
        uploaded_by: FIELD_USER_ID,
        latitude: null,
        longitude: null,
        address: null,
        address_source: null,
        geocoded_at: null,
        procore_sync_status: null,
        deleted_at: null,
      }],
    });
    projectMocks.assertAccessibleFieldCaptureTarget.mockResolvedValueOnce({ id: UUID_V7, type: "deal" });
    fileMocks.getFileDownloadUrl.mockResolvedValueOnce({ url: "https://signed.example/photo.jpg" });

    const result = await assignPendingFieldPhotoTarget(localDb, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    }, {
      photoId: UUID_V7,
      dealId: UUID_V7,
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenCalledWith(localDb, {
      dealId: UUID_V7,
      leadId: undefined,
      opportunityId: undefined,
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    });
    expect(result.photo.id).toBe(UUID_V7);
  });

  it("assigns a pending field photo to an opportunity target using the same persisted deal linkage as direct uploads", async () => {
    db.execute.mockResolvedValueOnce({
      rows: [{
        id: PENDING_OPPORTUNITY_PHOTO_ID,
        category: "photo",
        deal_id: null,
        lead_id: null,
        uploaded_by: FIELD_USER_ID,
      }],
    }).mockResolvedValueOnce({
      rows: [{
        id: PENDING_OPPORTUNITY_PHOTO_ID,
        category: "photo",
        photo_category: "damage",
        subcategory: null,
        display_name: "Pending photo",
        mime_type: "image/jpeg",
        file_size_bytes: 850000,
        file_extension: ".jpg",
        deal_id: DEAL_TWO_ID,
        lead_id: null,
        description: null,
        tags: [],
        taken_at: new Date("2026-05-05T12:00:00.000Z"),
        created_at: new Date("2026-05-05T12:01:00.000Z"),
        uploaded_by: FIELD_USER_ID,
        latitude: null,
        longitude: null,
        address: null,
        address_source: null,
        geocoded_at: null,
        procore_sync_status: null,
        deleted_at: null,
      }],
    });
    projectMocks.assertAccessibleFieldCaptureTarget.mockResolvedValueOnce({ id: DEAL_TWO_ID, type: "opportunity" });
    fileMocks.getFileDownloadUrl.mockResolvedValueOnce({ url: "https://signed.example/photo.jpg" });

    const result = await assignPendingFieldPhotoTarget(db, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    }, {
      photoId: PENDING_OPPORTUNITY_PHOTO_ID,
      opportunityId: DEAL_TWO_ID,
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenCalledWith(db, {
      dealId: undefined,
      leadId: undefined,
      opportunityId: DEAL_TWO_ID,
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    });
    expect(result.photo).toEqual(expect.objectContaining({
      id: PENDING_OPPORTUNITY_PHOTO_ID,
      dealId: DEAL_TWO_ID,
      leadId: null,
      imageUrl: "https://signed.example/photo.jpg",
    }));
  });

  it("supports lead photo uploads without forcing a deal-backed project", async () => {
    fileMocks.getPendingUploadMetadata.mockReturnValueOnce({
      r2Key: "office/leads/LD-1/photos/photo.jpg",
      leadId: LEAD_ID,
      category: "photo",
    });

    await requestFieldPhotoUploadUrl(db, {
      officeSlug: "trock",
      userId: ADMIN_USER_ID,
      userRole: "admin",
      leadId: LEAD_ID,
      opportunityId: undefined,
      contentType: "image/jpeg",
      sizeBytes: 850_000,
      caption: "Lead photo",
    });

    expect(fileMocks.requestUploadUrl).toHaveBeenLastCalledWith(db, "trock", ADMIN_USER_ID, expect.objectContaining({
      dealId: undefined,
      leadId: LEAD_ID,
      description: "Lead photo",
    }));

    await confirmFieldPhotoUpload(db, {
      userId: ADMIN_USER_ID,
      userRole: "admin",
      officeId: OFFICE_ID,
      leadId: LEAD_ID,
      opportunityId: undefined,
      uploadToken: "upload-token-1",
      objectKey: "office/leads/LD-1/photos/photo.jpg",
      auditContext: {},
    });

    expect(fileMocks.confirmUpload).toHaveBeenLastCalledWith(db, ADMIN_USER_ID, {
      uploadToken: "upload-token-1",
      latitude: undefined,
      longitude: undefined,
      addressSource: undefined,
      takenAt: undefined,
    });
  });

  it("supports opportunity uploads through opportunityId while storing against the underlying deal", async () => {
    projectMocks.assertAccessibleFieldCaptureTarget.mockResolvedValueOnce({ id: DEAL_TWO_ID, type: "opportunity" });
    fileMocks.getPendingUploadMetadata.mockReturnValueOnce({
      r2Key: "office/deals/TR-2/photos/photo.jpg",
      dealId: DEAL_TWO_ID,
      opportunityId: DEAL_TWO_ID,
      category: "photo",
    });

    await requestFieldPhotoUploadUrl(db, {
      officeSlug: "trock",
      userId: ADMIN_USER_ID,
      userRole: "admin",
      opportunityId: DEAL_TWO_ID,
      contentType: "image/jpeg",
      sizeBytes: 850_000,
      caption: "Opportunity photo",
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenLastCalledWith(db, {
      dealId: undefined,
      leadId: undefined,
      opportunityId: DEAL_TWO_ID,
      userId: ADMIN_USER_ID,
      userRole: "admin",
    });
    expect(fileMocks.requestUploadUrl).toHaveBeenLastCalledWith(db, "trock", ADMIN_USER_ID, expect.objectContaining({
      dealId: DEAL_TWO_ID,
      leadId: undefined,
      opportunityId: DEAL_TWO_ID,
      description: "Opportunity photo",
    }));

    await confirmFieldPhotoUpload(db, {
      userId: ADMIN_USER_ID,
      userRole: "admin",
      officeId: OFFICE_ID,
      opportunityId: DEAL_TWO_ID,
      uploadToken: "upload-token-1",
      objectKey: "office/deals/TR-2/photos/photo.jpg",
      auditContext: {},
    });

    expect(fileMocks.confirmUpload).toHaveBeenLastCalledWith(db, ADMIN_USER_ID, {
      uploadToken: "upload-token-1",
      latitude: undefined,
      longitude: undefined,
      addressSource: undefined,
      takenAt: undefined,
    });
  });
});
