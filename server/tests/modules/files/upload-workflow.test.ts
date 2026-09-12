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

  // Why this number is recorded at all: a device's upload queue is local to the phone, so the server sees
  // photos arrive with no idea whether one came alone or with 300 behind it. That blind spot is why a
  // three-day backlog stayed invisible until a superintendent reported missing photos and it had to be
  // reconstructed from capture-vs-arrival dates. Recorded here, a deep queue is one query.
  it("records the device's reported queue depth in the photo audit metadata", async () => {
    const db = { execute: vi.fn(async () => []) };

    await recordUploadedFileSideEffects(db as any, {
      file: makeFile(),
      userId: "field-1",
      officeId: "00000000-0000-0000-0000-000000000001",
      queueDepth: 266,
    });

    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ metadata: expect.objectContaining({ deviceQueueDepth: 266 }) }),
    );
  });

  it("omits the key entirely when no depth was reported, so a query can tell 'not sent' from 'queue empty'", async () => {
    const db = { execute: vi.fn(async () => []) };

    for (const queueDepth of [undefined, null]) {
      auditMocks.logPhotoEvent.mockClear();
      await recordUploadedFileSideEffects(db as any, {
        file: makeFile(),
        userId: "field-1",
        officeId: "00000000-0000-0000-0000-000000000001",
        queueDepth,
      });
      const { metadata } = auditMocks.logPhotoEvent.mock.calls[0][1];
      // Absent, NOT null: a null would read as "this device said its queue was empty", which is a
      // different fact from "this build does not report depth at all" (every build already in the field).
      expect("deviceQueueDepth" in metadata).toBe(false);
    }
  });

  it("records a reported depth of zero, which is a real answer and not a missing one", async () => {
    const db = { execute: vi.fn(async () => []) };

    await recordUploadedFileSideEffects(db as any, {
      file: makeFile(),
      userId: "field-1",
      officeId: "00000000-0000-0000-0000-000000000001",
      queueDepth: 0,
    });

    const { metadata } = auditMocks.logPhotoEvent.mock.calls[0][1];
    expect(metadata.deviceQueueDepth).toBe(0);
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
