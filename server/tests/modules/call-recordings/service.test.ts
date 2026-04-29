import { beforeEach, describe, expect, it, vi } from "vitest";

const r2Mocks = vi.hoisted(() => ({
  isR2Configured: vi.fn(() => false),
  generateUploadUrl: vi.fn(),
  generateMockUploadUrl: vi.fn((key: string) => ({
    uploadUrl: `http://localhost:3001/api/call-recordings/dev-upload?key=${encodeURIComponent(key)}`,
    r2Key: key,
    expiresIn: 900,
  })),
  generateDownloadUrl: vi.fn(),
  generateMockDownloadUrl: vi.fn((key: string) => `http://localhost:3001/api/call-recordings/dev-playback?key=${encodeURIComponent(key)}`),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock("../../../src/lib/r2-client.js", () => r2Mocks);

const {
  MAX_CALL_RECORDING_SIZE_BYTES,
  isAllowedCallRecordingMimeType,
  buildCallRecordingR2Key,
  createUploadUrl,
  listForEntity,
} = await import("../../../src/modules/call-recordings/service.js");

function createListTenantDb(rows: Array<Record<string, unknown>>) {
  const orderBy = vi.fn(async () => rows);
  const where = vi.fn(() => ({ orderBy }));
  const leftJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ leftJoin }));
  return {
    db: {
      select: vi.fn(() => ({ from })),
    } as any,
    orderBy,
    where,
    leftJoin,
    from,
  };
}

describe("call recordings service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    r2Mocks.isR2Configured.mockReturnValue(false);
  });

  it("allows the MVP audio MIME types", () => {
    expect(MAX_CALL_RECORDING_SIZE_BYTES).toBe(200 * 1024 * 1024);
    for (const mimeType of ["audio/m4a", "audio/x-m4a", "audio/mp4", "audio/mpeg", "audio/wav", "audio/webm"]) {
      expect(isAllowedCallRecordingMimeType(mimeType)).toBe(true);
    }
    expect(isAllowedCallRecordingMimeType("video/mp4")).toBe(false);
  });

  it("builds tenant scoped R2 keys with a safe audio extension", () => {
    const key = buildCallRecordingR2Key({
      tenantId: "tenant-1",
      recordingId: "recording-1",
      filename: "Sales Call.M4A",
      mimeType: "audio/x-m4a",
    });

    expect(key).toBe("call-recordings/tenant-1/recording-1.m4a");
  });

  it("creates a pending recording row before returning a mock upload URL", async () => {
    const values = vi.fn(() => Promise.resolve());
    const tenantDb = {
      insert: vi.fn(() => ({ values })),
    } as any;

    const result = await createUploadUrl(tenantDb, {
      tenantId: "office-1",
      uploadedBy: "admin-1",
      entityType: "deal",
      entityId: "deal-1",
      filename: "call.wav",
      mimeType: "audio/wav",
      title: "Kickoff",
      notes: "Initial call",
      callDate: "2026-04-29T14:00:00.000Z",
    });

    expect(result.uploadUrl).toContain("/api/call-recordings/dev-upload");
    expect(result.r2Key).toMatch(/^call-recordings\/office-1\/.+\.wav$/);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "office-1",
      uploadedBy: "admin-1",
      entityType: "deal",
      entityId: "deal-1",
      originalFilename: "call.wav",
      fileSizeBytes: 0,
      title: "Kickoff",
      transcriptionStatus: "none",
    }));
  });

  it("lists all entity recordings for admins and directors", async () => {
    const rows = [
      { id: "rec-admin", uploadedBy: "admin-1" },
      { id: "rec-rep", uploadedBy: "rep-1" },
    ];
    const tenant = createListTenantDb(rows);

    await expect(listForEntity(tenant.db, "deal", "deal-1", { role: "admin", userId: "admin-1" })).resolves.toEqual(rows);
    await expect(listForEntity(tenant.db, "deal", "deal-1", { role: "director", userId: "director-1" })).resolves.toEqual(rows);
  });

  it("lists only the rep's own entity recordings", async () => {
    const tenant = createListTenantDb([
      { id: "own", uploadedBy: "rep-1" },
      { id: "other", uploadedBy: "admin-1" },
    ]);

    await expect(listForEntity(tenant.db, "deal", "deal-1", { role: "rep", userId: "rep-1" })).resolves.toEqual([
      { id: "own", uploadedBy: "rep-1" },
    ]);
  });

  it("returns no recordings for construction users without querying", async () => {
    const tenant = createListTenantDb([{ id: "other", uploadedBy: "admin-1" }]);

    await expect(listForEntity(tenant.db, "deal", "deal-1", { role: "construction", userId: "construction-1" })).resolves.toEqual([]);
    expect(tenant.db.select).not.toHaveBeenCalled();
  });
});
