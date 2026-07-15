import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

const r2Mocks = vi.hoisted(() => ({
  isR2Configured: vi.fn(),
  generateDownloadUrl: vi.fn(),
  generateMockDownloadUrl: vi.fn(),
}));

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

vi.mock("../../../src/lib/r2-client.js", () => ({
  isR2Configured: r2Mocks.isR2Configured,
  generateDownloadUrl: r2Mocks.generateDownloadUrl,
  generateMockDownloadUrl: r2Mocks.generateMockDownloadUrl,
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

let db: { execute: ReturnType<typeof vi.fn> };
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
const LEGACY_FALLBACK_SAVEPOINT = "field_photo_legacy_linkage_fallback";
const SCHEMA_PROBE_SAVEPOINT = "field_photo_pending_linkage_probe";

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
  isActive: true,
  latitude: "35.123456",
  longitude: "-97.123456",
  address: "123 Main St",
  addressSource: "live_gps",
  geocodedAt: null,
  procoreSyncStatus: null,
  deletedAt: null,
};

function flattenQueryChunks(input: unknown, seen = new WeakSet<object>()): unknown[] {
  if (!input || typeof input !== "object") return [input];
  if (seen.has(input as object)) return [];
  seen.add(input as object);

  const queryChunks = (input as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) {
    return queryChunks.flatMap((chunk) => flattenQueryChunks(chunk, seen));
  }

  if ("value" in (input as Record<string, unknown>)) {
    return [(input as Record<string, unknown>).value];
  }

  return Object.values(input as Record<string, unknown>).flatMap((value) => flattenQueryChunks(value, seen));
}

function normalizeSqlText(value: unknown): string {
  return flattenQueryChunks(value).join("").replace(/\s+/g, " ").trim().toUpperCase();
}

describe("field photo upload service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db = { execute: vi.fn() } as any;
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
    fileMocks.confirmUpload.mockResolvedValue({ file: confirmedFile, created: true });
    fileMocks.updateFile.mockResolvedValue(confirmedFile);
    fileMocks.getFileDownloadUrl.mockResolvedValue({ url: "https://signed.example/photo.jpg" });
    workflowMocks.recordUploadedFileSideEffects.mockResolvedValue(undefined);
    r2Mocks.isR2Configured.mockReturnValue(false);
    r2Mocks.generateDownloadUrl.mockReset();
    r2Mocks.generateMockDownloadUrl.mockImplementation((r2Key: string) => `https://mock-signed.example/${encodeURIComponent(r2Key)}`);
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

  it("lists pending field photos with parallel URL signing that does not touch tenantDb", async () => {
    const SECOND_PHOTO_ID = "77777777-7777-4777-8777-777777777777";
    const localDb = { execute: vi.fn() } as any;
    let activeUrlSignings = 0;
    let maxConcurrentUrlSignings = 0;

    r2Mocks.isR2Configured.mockReturnValue(true);
    r2Mocks.generateDownloadUrl.mockImplementation(async (r2Key: string) => {
      activeUrlSignings += 1;
      maxConcurrentUrlSignings = Math.max(maxConcurrentUrlSignings, activeUrlSignings);
      await Promise.resolve();
      await Promise.resolve();
      activeUrlSignings -= 1;
      return `https://signed.example/${encodeURIComponent(r2Key)}`;
    });

    localDb.execute.mockImplementation(async (query: unknown) => {
      const sqlText = normalizeSqlText(query);

      if (
        sqlText === `SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}` ||
        sqlText === `RELEASE SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`
      ) {
        return { rows: [] };
      }
      if (sqlText.includes("INFORMATION_SCHEMA.COLUMNS")) {
        return { rows: [{ column_count: "3" }] };
      }
      if (sqlText.includes("FROM FILES F")) {
        return {
          rows: [{
            id: PHOTO_ID,
            category: "photo",
            photo_category: "damage",
            subcategory: null,
            display_name: "Pending photo",
            mime_type: "image/jpeg",
            file_size_bytes: 850000,
            file_extension: ".jpg",
            r2_key: "office/photos/pending-photo.jpg",
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
          }, {
            id: SECOND_PHOTO_ID,
            category: "photo",
            photo_category: "before",
            subcategory: null,
            display_name: "Pending photo two",
            mime_type: "image/jpeg",
            file_size_bytes: 860000,
            file_extension: ".jpg",
            r2_key: "office/photos/pending-photo-two.jpg",
            deal_id: null,
            lead_id: null,
            description: null,
            tags: [],
            taken_at: new Date("2026-05-05T12:02:00.000Z"),
            created_at: new Date("2026-05-05T12:03:00.000Z"),
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
        };
      }

      throw new Error(`Unexpected query in pending photo URL signing test: ${sqlText}`);
    });

    const result = await listPendingFieldPhotos(localDb, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    });

    expect(r2Mocks.generateDownloadUrl).toHaveBeenCalledTimes(2);
    expect(maxConcurrentUrlSignings).toBe(2);
    expect(fileMocks.getFileDownloadUrl).not.toHaveBeenCalled();

    expect(result.photos).toHaveLength(2);
    expect(result.photos[0]).toEqual(expect.objectContaining({
      id: PHOTO_ID,
      displayName: "Pending photo",
      imageUrl: "https://signed.example/office%2Fphotos%2Fpending-photo.jpg",
    }));
    expect(result.photos[1]).toEqual(expect.objectContaining({
      id: SECOND_PHOTO_ID,
      displayName: "Pending photo two",
      imageUrl: "https://signed.example/office%2Fphotos%2Fpending-photo-two.jpg",
    }));
  });

  it("excludes bulk CompanyCam imports from the pending-captures query", async () => {
    // Rescued CompanyCam photos are deal-less but must NOT clutter the field pending inbox (they're
    // triaged from the CRM "Unassigned" tab). The list query must carry the subcategory exclusion.
    const localDb = { execute: vi.fn() } as any;
    let pendingQuerySql = "";
    localDb.execute.mockImplementation(async (query: unknown) => {
      const sqlText = normalizeSqlText(query);
      if (sqlText.startsWith("SAVEPOINT") || sqlText.startsWith("RELEASE SAVEPOINT")) return { rows: [] };
      if (sqlText.includes("INFORMATION_SCHEMA.COLUMNS")) return { rows: [{ column_count: "3" }] };
      if (sqlText.includes("FROM FILES F")) {
        pendingQuerySql = sqlText;
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sqlText}`);
    });

    await listPendingFieldPhotos(localDb, { userId: FIELD_USER_ID, userRole: "field_contractor" });

    expect(pendingQuerySql).toContain("SUBCATEGORY IS DISTINCT FROM 'COMPANYCAM'");
  });

  it("falls back to the legacy pending-photo query without savepoints once schema inspection detects missing linkage columns", async () => {
    const localDb = { execute: vi.fn() } as any;
    const executedQueries: string[] = [];

    localDb.execute.mockImplementation(async (query: unknown) => {
      const sqlText = normalizeSqlText(query);
      executedQueries.push(sqlText);

      if (
        sqlText === `SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}` ||
        sqlText === `RELEASE SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`
      ) {
        return { rows: [] };
      }
      if (sqlText.includes("INFORMATION_SCHEMA.COLUMNS")) {
        return { rows: [{ column_count: "0" }] };
      }
      if (sqlText.includes("FROM FILES F") && !sqlText.includes("CONTACT_ID IS NULL")) {
        return {
          rows: [{
            id: PHOTO_ID,
            category: "photo",
            photo_category: "damage",
            subcategory: null,
            display_name: "Pending photo",
            mime_type: "image/jpeg",
            file_size_bytes: 850000,
            file_extension: ".jpg",
            r2_key: "office/photos/pending-photo.jpg",
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
        };
      }

      throw new Error(`Unexpected query in legacy pending-photo inspection test: ${sqlText}`);
    });

    const result = await listPendingFieldPhotos(localDb, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    });

    expect(result.photos).toHaveLength(1);
    expect(result.photos[0].id).toBe(PHOTO_ID);
    expect(executedQueries.filter((query) => query.startsWith("SAVEPOINT"))).toEqual([
      `SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`,
    ]);
    expect(executedQueries.some((query) => query.includes("CONTACT_ID IS NULL"))).toBe(false);
  });

  it("recovers the transaction with a savepoint before retrying the pending-photo legacy fallback when schema inspection is unavailable", async () => {
    const localDb = { execute: vi.fn() } as any;
    let transactionAborted = false;
    let rolledBackToSavepoint = false;
    let rolledBackProbeSavepoint = false;
    const executedQueries: string[] = [];

    localDb.execute.mockImplementation(async (query: unknown) => {
      const sqlText = normalizeSqlText(query);
      executedQueries.push(sqlText);

      if (sqlText === `SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`) {
        if (transactionAborted) {
          throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        }
        return { rows: [] };
      }
      if (sqlText === `ROLLBACK TO SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`) {
        transactionAborted = false;
        rolledBackProbeSavepoint = true;
        return { rows: [] };
      }
      if (sqlText === `RELEASE SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`) {
        return { rows: [] };
      }
      if (sqlText === `SAVEPOINT ${LEGACY_FALLBACK_SAVEPOINT.toUpperCase()}`) {
        if (transactionAborted) {
          throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        }
        return { rows: [] };
      }
      if (sqlText === `ROLLBACK TO SAVEPOINT ${LEGACY_FALLBACK_SAVEPOINT.toUpperCase()}`) {
        transactionAborted = false;
        rolledBackToSavepoint = true;
        return { rows: [] };
      }
      if (sqlText === `RELEASE SAVEPOINT ${LEGACY_FALLBACK_SAVEPOINT.toUpperCase()}`) {
        return { rows: [] };
      }
      if (sqlText === "SELECT 1") {
        if (transactionAborted) {
          throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        }
        return { rows: [{ "?column?": 1 }] };
      }
      if (sqlText.includes("INFORMATION_SCHEMA.COLUMNS")) {
        transactionAborted = true;
        throw new Error("metadata lookup unavailable");
      }
      if (sqlText.includes("FROM FILES F") && sqlText.includes("CONTACT_ID IS NULL")) {
        transactionAborted = true;
        throw Object.assign(new Error('column "contact_id" does not exist'), { code: "42703" });
      }
      if (sqlText.includes("FROM FILES F") && sqlText.includes("UPLOADED_BY") && !sqlText.includes("CONTACT_ID IS NULL")) {
        if (transactionAborted) {
          throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        }
        return {
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
        };
      }

      throw new Error(`Unexpected query in legacy pending-photo fallback test: ${sqlText}`);
    });

    const result = await listPendingFieldPhotos(localDb, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    });

    expect(rolledBackProbeSavepoint).toBe(true);
    expect(rolledBackToSavepoint).toBe(true);
    expect(result.photos).toHaveLength(1);
    expect(executedQueries.slice(0, 9)).toEqual([
      `SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`,
      expect.stringContaining("INFORMATION_SCHEMA.COLUMNS"),
      `ROLLBACK TO SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`,
      `RELEASE SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`,
      `SAVEPOINT ${LEGACY_FALLBACK_SAVEPOINT.toUpperCase()}`,
      expect.stringContaining("CONTACT_ID IS NULL"),
      `ROLLBACK TO SAVEPOINT ${LEGACY_FALLBACK_SAVEPOINT.toUpperCase()}`,
      `RELEASE SAVEPOINT ${LEGACY_FALLBACK_SAVEPOINT.toUpperCase()}`,
      expect.not.stringContaining("CONTACT_ID IS NULL"),
    ]);
    await expect(localDb.execute(sql.raw("SELECT 1"))).resolves.toEqual({ rows: [{ "?column?": 1 }] });
  });

  it("assigns a pending field photo to a selected target", async () => {
    const localDb = { execute: vi.fn() } as any;
    const executedQueries: string[] = [];

    localDb.execute.mockImplementation(async (query: unknown) => {
      const sqlText = normalizeSqlText(query);
      executedQueries.push(sqlText);

      if (
        sqlText === `SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}` ||
        sqlText === `RELEASE SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`
      ) {
        return { rows: [] };
      }
      if (sqlText.includes("INFORMATION_SCHEMA.COLUMNS")) {
        return { rows: [{ column_count: "3" }] };
      }
      if (sqlText.startsWith("SELECT") && sqlText.includes("FROM FILES F")) {
        return {
          rows: [{
            id: PENDING_PHOTO_ID,
            category: "photo",
            deal_id: null,
            lead_id: null,
            uploaded_by: FIELD_USER_ID,
          }],
        };
      }
      if (sqlText.startsWith("UPDATE FILES")) {
        return {
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
        };
      }

      throw new Error(`Unexpected query in assign modern-schema test: ${sqlText}`);
    });
    projectMocks.assertAccessibleFieldCaptureTarget.mockResolvedValueOnce({ id: DEAL_ID, type: "deal" });
    fileMocks.getFileDownloadUrl.mockResolvedValueOnce({ url: "https://signed.example/photo.jpg" });

    const result = await assignPendingFieldPhotoTarget(localDb, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    }, {
      photoId: PENDING_PHOTO_ID,
      dealId: DEAL_ID,
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenCalledWith(localDb, {
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
    expect(executedQueries.filter((query) => query.includes("INFORMATION_SCHEMA.COLUMNS"))).toHaveLength(1);
    expect(executedQueries.filter((query) => query.startsWith("SAVEPOINT"))).toEqual([
      `SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`,
    ]);
    expect(executedQueries.filter((query) => query.startsWith("RELEASE SAVEPOINT"))).toEqual([
      `RELEASE SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`,
    ]);
  });

  it("falls back to the legacy assign-target queries without modern-column probes once schema inspection detects a legacy schema", async () => {
    const localDb = { execute: vi.fn() } as any;
    const executedQueries: string[] = [];

    localDb.execute.mockImplementation(async (query: unknown) => {
      const sqlText = normalizeSqlText(query);
      executedQueries.push(sqlText);

      if (
        sqlText === `SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}` ||
        sqlText === `RELEASE SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`
      ) {
        return { rows: [] };
      }
      if (sqlText.includes("INFORMATION_SCHEMA.COLUMNS")) {
        return { rows: [{ column_count: "0" }] };
      }
      if (sqlText.startsWith("SELECT") && sqlText.includes("FROM FILES F") && !sqlText.includes("CONTACT_ID IS NULL")) {
        return {
          rows: [{
            id: PENDING_PHOTO_ID,
            category: "photo",
            deal_id: null,
            lead_id: null,
            uploaded_by: FIELD_USER_ID,
          }],
        };
      }
      if (sqlText.startsWith("UPDATE FILES") && !sqlText.includes("CONTACT_ID IS NULL")) {
        return {
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
        };
      }

      throw new Error(`Unexpected query in legacy assign-target fallback test: ${sqlText}`);
    });

    const result = await assignPendingFieldPhotoTarget(localDb, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    }, {
      photoId: PENDING_PHOTO_ID,
      dealId: DEAL_ID,
    });

    expect(result.photo).toEqual(expect.objectContaining({
      id: PENDING_PHOTO_ID,
      dealId: DEAL_ID,
      leadId: null,
    }));
    expect(executedQueries.some((query) => query.includes("CONTACT_ID IS NULL"))).toBe(false);
    expect(executedQueries.filter((query) => query.startsWith("SAVEPOINT"))).toEqual([
      `SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`,
    ]);
  });

  it("treats photos linked through newer linkage columns as not pending on modern schemas", async () => {
    const localDb = { execute: vi.fn() } as any;
    localDb.execute.mockImplementation(async (query: unknown) => {
      const sqlText = normalizeSqlText(query);
      if (
        sqlText === `SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}` ||
        sqlText === `RELEASE SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`
      ) {
        return { rows: [] };
      }
      if (sqlText.includes("INFORMATION_SCHEMA.COLUMNS")) {
        return { rows: [{ column_count: "3" }] };
      }
      if (sqlText.startsWith("SELECT") && sqlText.includes("FROM FILES F")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query in modern missing-pending test: ${sqlText}`);
    });

    await expect(assignPendingFieldPhotoTarget(localDb, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    }, {
      photoId: PENDING_PHOTO_ID,
      dealId: DEAL_ID,
    })).rejects.toEqual(new AppError(404, "Pending photo not found."));

    expect(localDb.execute).toHaveBeenCalledTimes(4);
  });

  it("recovers the transaction with a savepoint before retrying the assign-target legacy fallback when schema inspection is unavailable", async () => {
    const localDb = { execute: vi.fn() } as any;
    let transactionAborted = false;
    let rolledBackToSavepoint = false;
    let rolledBackProbeSavepoint = false;
    const executedQueries: string[] = [];

    localDb.execute.mockImplementation(async (query: unknown) => {
      const sqlText = normalizeSqlText(query);
      executedQueries.push(sqlText);

      if (sqlText === `SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`) {
        if (transactionAborted) {
          throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        }
        return { rows: [] };
      }
      if (sqlText === `ROLLBACK TO SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`) {
        transactionAborted = false;
        rolledBackProbeSavepoint = true;
        return { rows: [] };
      }
      if (sqlText === `RELEASE SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`) {
        return { rows: [] };
      }
      if (sqlText === `SAVEPOINT ${LEGACY_FALLBACK_SAVEPOINT.toUpperCase()}`) {
        if (transactionAborted) {
          throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        }
        return { rows: [] };
      }
      if (sqlText === `ROLLBACK TO SAVEPOINT ${LEGACY_FALLBACK_SAVEPOINT.toUpperCase()}`) {
        transactionAborted = false;
        rolledBackToSavepoint = true;
        return { rows: [] };
      }
      if (sqlText === `RELEASE SAVEPOINT ${LEGACY_FALLBACK_SAVEPOINT.toUpperCase()}`) {
        return { rows: [] };
      }
      if (sqlText === "SELECT 1") {
        if (transactionAborted) {
          throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        }
        return { rows: [{ "?column?": 1 }] };
      }
      if (sqlText.includes("INFORMATION_SCHEMA.COLUMNS")) {
        transactionAborted = true;
        throw new Error("metadata lookup unavailable");
      }
      if (sqlText.startsWith("SELECT") && sqlText.includes("FROM FILES F") && sqlText.includes("CONTACT_ID IS NULL")) {
        transactionAborted = true;
        throw Object.assign(new Error('column "contact_id" does not exist'), { code: "42703" });
      }
      if (sqlText.startsWith("SELECT") && sqlText.includes("FROM FILES F") && sqlText.includes("WHERE F.ID =")) {
        return {
          rows: [{
            id: PENDING_PHOTO_ID,
            category: "photo",
            deal_id: null,
            lead_id: null,
            uploaded_by: FIELD_USER_ID,
          }],
        };
      }
      if (sqlText.startsWith("UPDATE FILES") && sqlText.includes("CONTACT_ID IS NULL")) {
        transactionAborted = true;
        throw Object.assign(new Error('column "contact_id" does not exist'), { code: "42703" });
      }
      if (sqlText.startsWith("UPDATE FILES") && !sqlText.includes("CONTACT_ID IS NULL")) {
        if (transactionAborted) {
          throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        }
        return {
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
        };
      }

      throw new Error(`Unexpected query in legacy assign-target fallback test: ${sqlText}`);
    });

    const result = await assignPendingFieldPhotoTarget(localDb, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    }, {
      photoId: PENDING_PHOTO_ID,
      dealId: DEAL_ID,
    });

    expect(rolledBackProbeSavepoint).toBe(true);
    expect(rolledBackToSavepoint).toBe(true);
    expect(result.photo.id).toBe(PENDING_PHOTO_ID);
    expect(executedQueries.slice(0, 10)).toEqual([
      `SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`,
      expect.stringContaining("INFORMATION_SCHEMA.COLUMNS"),
      `ROLLBACK TO SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`,
      `RELEASE SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`,
      `SAVEPOINT ${LEGACY_FALLBACK_SAVEPOINT.toUpperCase()}`,
      expect.stringContaining("CONTACT_ID IS NULL"),
      `ROLLBACK TO SAVEPOINT ${LEGACY_FALLBACK_SAVEPOINT.toUpperCase()}`,
      `RELEASE SAVEPOINT ${LEGACY_FALLBACK_SAVEPOINT.toUpperCase()}`,
      expect.not.stringContaining("CONTACT_ID IS NULL"),
      expect.stringContaining("UPDATE FILES"),
    ]);
    await expect(localDb.execute(sql.raw("SELECT 1"))).resolves.toEqual({ rows: [{ "?column?": 1 }] });
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
    localDb.execute.mockImplementation(async (query: unknown) => {
      const sqlText = normalizeSqlText(query);
      if (
        sqlText === `SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}` ||
        sqlText === `RELEASE SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`
      ) {
        return { rows: [] };
      }
      if (sqlText.includes("INFORMATION_SCHEMA.COLUMNS")) {
        return { rows: [{ column_count: "3" }] };
      }
      if (sqlText.startsWith("SELECT") && sqlText.includes("FROM FILES F")) {
        return {
          rows: [{
            id: UUID_V7,
            category: "photo",
            deal_id: null,
            lead_id: null,
            uploaded_by: FIELD_USER_ID,
          }],
        };
      }
      if (sqlText.startsWith("UPDATE FILES")) {
        return {
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
        };
      }
      throw new Error(`Unexpected query in UUID v7 test: ${sqlText}`);
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
    const localDb = { execute: vi.fn() } as any;
    localDb.execute.mockImplementation(async (query: unknown) => {
      const sqlText = normalizeSqlText(query);
      if (
        sqlText === `SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}` ||
        sqlText === `RELEASE SAVEPOINT ${SCHEMA_PROBE_SAVEPOINT.toUpperCase()}`
      ) {
        return { rows: [] };
      }
      if (sqlText.includes("INFORMATION_SCHEMA.COLUMNS")) {
        return { rows: [{ column_count: "3" }] };
      }
      if (sqlText.startsWith("SELECT") && sqlText.includes("FROM FILES F")) {
        return {
          rows: [{
            id: PENDING_OPPORTUNITY_PHOTO_ID,
            category: "photo",
            deal_id: null,
            lead_id: null,
            uploaded_by: FIELD_USER_ID,
          }],
        };
      }
      if (sqlText.startsWith("UPDATE FILES")) {
        return {
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
        };
      }
      throw new Error(`Unexpected query in opportunity target assignment test: ${sqlText}`);
    });
    projectMocks.assertAccessibleFieldCaptureTarget.mockResolvedValueOnce({ id: DEAL_TWO_ID, type: "opportunity" });
    fileMocks.getFileDownloadUrl.mockResolvedValueOnce({ url: "https://signed.example/photo.jpg" });

    const result = await assignPendingFieldPhotoTarget(localDb, {
      userId: FIELD_USER_ID,
      userRole: "field_contractor",
    }, {
      photoId: PENDING_OPPORTUNITY_PHOTO_ID,
      opportunityId: DEAL_TWO_ID,
    });

    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenCalledWith(localDb, {
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
