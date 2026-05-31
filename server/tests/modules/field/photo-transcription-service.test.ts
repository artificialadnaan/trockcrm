import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

const fileMocks = vi.hoisted(() => ({
  getFileById: vi.fn(),
  updateFile: vi.fn(),
}));

const projectMocks = vi.hoisted(() => ({
  assertScopedCaptureTargetAccess: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({
  logPhotoEvent: vi.fn(),
}));

vi.mock("../../../src/modules/files/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/files/service.js")>(
    "../../../src/modules/files/service.js"
  );
  return {
    ...actual,
    getFileById: fileMocks.getFileById,
    updateFile: fileMocks.updateFile,
  };
});

vi.mock("../../../src/modules/field/projects-service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/field/projects-service.js")>(
    "../../../src/modules/field/projects-service.js"
  );
  return {
    ...actual,
    assertScopedCaptureTargetAccess: projectMocks.assertScopedCaptureTargetAccess,
  };
});

vi.mock("../../../src/modules/files/audit-log-service.js", () => auditMocks);

const db = {
  select: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
} as any;

const {
  FIELD_PHOTO_TRANSCRIPTION_MIME_TYPES,
  getFieldPhotoTranscriptionConfig,
  getAccessibleFieldPhoto,
  transcribeAndPersistFieldPhotoDescription,
  transcribePhotoDescriptionAudio,
} = await import("../../../src/modules/field/photo-transcription-service.js");

describe("photo transcription service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-openai-key";
    fileMocks.getFileById.mockResolvedValue({
      id: "photo-1",
      category: "photo",
      dealId: "deal-1",
      leadId: null,
      description: "Old caption",
    });
    fileMocks.updateFile.mockResolvedValue({ id: "photo-1", description: "Sagging stringer" });
    projectMocks.assertScopedCaptureTargetAccess.mockResolvedValue(undefined);
    auditMocks.logPhotoEvent.mockResolvedValue(undefined);
  });

  it("accepts the mobile audio mime types used by field dictation", () => {
    expect(Array.from(FIELD_PHOTO_TRANSCRIPTION_MIME_TYPES)).toEqual(expect.arrayContaining([
      "audio/m4a",
      "audio/mp4",
      "audio/mpeg",
      "audio/wav",
      "audio/webm",
    ]));
  });

  it("reports voice transcription as unconfigured instead of throwing when the OpenAI key is blank", () => {
    process.env.OPENAI_API_KEY = "   ";

    expect(getFieldPhotoTranscriptionConfig()).toEqual({ configured: false });
  });

  it("reports voice transcription as configured when the OpenAI key is present", () => {
    process.env.OPENAI_API_KEY = "test-openai-key";

    expect(getFieldPhotoTranscriptionConfig()).toEqual({ configured: true });
  });

  it("rejects unsupported audio mime types before calling OpenAI", async () => {
    await expect(transcribePhotoDescriptionAudio({
      audio: Buffer.from("abc"),
      mimeType: "application/pdf",
    })).rejects.toEqual(new AppError(400, "Unsupported audio type. Use M4A, MP3, WAV, MP4 audio, or WebM audio."));
  });

  it("validates field access before exposing a photo", async () => {
    const photo = await getAccessibleFieldPhoto(db, {
      userId: "field-1",
      userRole: "field_contractor",
    }, "photo-1");

    expect(photo.id).toBe("photo-1");
    expect(projectMocks.assertScopedCaptureTargetAccess).toHaveBeenCalledWith(db, {
      dealId: "deal-1",
      leadId: undefined,
      opportunityId: undefined,
      userId: "field-1",
      userRole: "field_contractor",
    });
  });

  it("does not allow uploader fallback once the photo is linked through another entity column", async () => {
    fileMocks.getFileById.mockResolvedValueOnce({
      id: "photo-1",
      category: "photo",
      dealId: null,
      leadId: null,
      contactId: "contact-1",
      procoreProjectId: null,
      changeOrderId: null,
      uploadedBy: "field-1",
      description: "Old caption",
    });

    await expect(getAccessibleFieldPhoto(db, {
      userId: "field-1",
      userRole: "field_contractor",
    }, "photo-1")).rejects.toEqual(new AppError(404, "Photo not found."));

    expect(projectMocks.assertScopedCaptureTargetAccess).not.toHaveBeenCalled();
  });

  it.each([
    { contactId: null, procoreProjectId: 101, changeOrderId: null },
    { contactId: null, procoreProjectId: null, changeOrderId: "co-1" },
  ])("does not allow uploader fallback when other linkage metadata is present: %j", async (links) => {
    fileMocks.getFileById.mockResolvedValueOnce({
      id: "photo-1",
      category: "photo",
      dealId: null,
      leadId: null,
      uploadedBy: "field-1",
      description: "Old caption",
      ...links,
    });

    await expect(getAccessibleFieldPhoto(db, {
      userId: "field-1",
      userRole: "field_contractor",
    }, "photo-1")).rejects.toEqual(new AppError(404, "Photo not found."));

    expect(projectMocks.assertScopedCaptureTargetAccess).not.toHaveBeenCalled();
  });

  it("transcribes audio, persists the new description, and writes a photo audit event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        text: "Sagging stringer",
        language: "en",
        duration: 8.2,
      }),
    })) as any);

    const result = await transcribeAndPersistFieldPhotoDescription(db, {
      userId: "field-1",
      userRole: "field_contractor",
    }, {
      photoId: "photo-1",
      audio: Buffer.from("audio"),
      mimeType: "audio/webm",
      fileName: "clip.webm",
      auditContext: { ipAddress: "127.0.0.1", userAgent: "vitest" },
    });

    expect(result).toEqual({
      transcript: "Sagging stringer",
      language: "en",
      duration: 8.2,
    });
    expect(fileMocks.updateFile).toHaveBeenCalledWith(db, "photo-1", {
      description: "Sagging stringer",
    });
    expect(auditMocks.logPhotoEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      photoId: "photo-1",
      eventType: "voice_description_transcribed",
      userId: "field-1",
    }));
  });
});
