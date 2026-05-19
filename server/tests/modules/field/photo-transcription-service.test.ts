import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

const fileMocks = vi.hoisted(() => ({
  getFileById: vi.fn(),
  updateFile: vi.fn(),
}));

const projectMocks = vi.hoisted(() => ({
  assertAccessibleFieldCaptureTarget: vi.fn(),
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
    assertAccessibleFieldCaptureTarget: projectMocks.assertAccessibleFieldCaptureTarget,
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
    projectMocks.assertAccessibleFieldCaptureTarget.mockResolvedValue({ id: "deal-1", type: "deal" });
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
    expect(projectMocks.assertAccessibleFieldCaptureTarget).toHaveBeenCalledWith(db, {
      dealId: "deal-1",
      leadId: undefined,
      opportunityId: undefined,
      userId: "field-1",
      userRole: "field_contractor",
    });
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
