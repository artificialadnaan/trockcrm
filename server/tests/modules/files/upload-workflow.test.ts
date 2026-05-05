import { beforeEach, describe, expect, it, vi } from "vitest";

const auditMocks = vi.hoisted(() => ({
  logPhotoEvent: vi.fn(),
}));

const eventBusMocks = vi.hoisted(() => ({
  emitLocal: vi.fn(),
}));

vi.mock("../../../src/modules/files/audit-log-service.js", () => auditMocks);
vi.mock("../../../src/events/bus.js", () => ({
  eventBus: eventBusMocks,
}));

const { emitUploadedFileEvent, recordUploadedFileSideEffects } = await import("../../../src/modules/files/upload-workflow.js");

function makeFile(overrides: Record<string, unknown> = {}) {
  return {
    id: "file-1",
    r2Key: "office/deals/deal-1/photo.jpg",
    mimeType: "image/jpeg",
    dealId: "deal-1",
    leadId: null,
    contactId: null,
    category: "photo",
    uploadedBy: "field-1",
    addressSource: "live_gps",
    latitude: "35.123456",
    longitude: "-97.123456",
    photoCategory: "damage",
    fileSizeBytes: 512000,
    ...overrides,
  };
}

describe("upload workflow side effects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes uploaded photo audit metadata and enqueues the domain event job", async () => {
    const db = { execute: vi.fn(async () => []) };

    await recordUploadedFileSideEffects(db as any, {
      file: makeFile(),
      userId: "field-1",
      officeId: "00000000-0000-0000-0000-000000000001",
      auditContext: { ipAddress: "127.0.0.1", userAgent: "vitest" },
    });

    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(db, {
      photoId: "file-1",
      eventType: "uploaded",
      userId: "field-1",
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      metadata: {
        addressSource: "live_gps",
        hasGpsCoordinates: true,
        category: "damage",
        sizeBytes: 512000,
      },
    });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("skips photo audit for non-photo files but still enqueues the job", async () => {
    const db = { execute: vi.fn(async () => []) };

    await recordUploadedFileSideEffects(db as any, {
      file: makeFile({ category: "contract", photoCategory: null }),
      userId: "crm-1",
      officeId: "00000000-0000-0000-0000-000000000001",
    });

    expect(auditMocks.logPhotoEvent).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("emits the in-process uploaded event as best effort", () => {
    emitUploadedFileEvent({
      file: makeFile(),
      userId: "field-1",
      officeId: "00000000-0000-0000-0000-000000000001",
    });

    expect(eventBusMocks.emitLocal).toHaveBeenCalledWith(expect.objectContaining({
      name: "file.uploaded",
      officeId: "00000000-0000-0000-0000-000000000001",
      userId: "field-1",
      payload: expect.objectContaining({
        fileId: "file-1",
        category: "photo",
        uploadedBy: "field-1",
      }),
    }));
  });

  it("does not throw if best-effort event emission fails", () => {
    eventBusMocks.emitLocal.mockImplementationOnce(() => {
      throw new Error("listener failed");
    });

    expect(() => emitUploadedFileEvent({
      file: makeFile(),
      userId: "field-1",
      officeId: "00000000-0000-0000-0000-000000000001",
    })).not.toThrow();
  });
});
