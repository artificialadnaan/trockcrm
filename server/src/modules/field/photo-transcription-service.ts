import { AppError } from "../../middleware/error-handler.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import type { UserRole } from "@trock-crm/shared/types";
import { getFileById, updateFile } from "../files/service.js";
import { logPhotoEvent } from "../files/audit-log-service.js";
import { assertAccessibleFieldCaptureTarget } from "./projects-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export const FIELD_PHOTO_TRANSCRIPTION_MIME_TYPES = new Set([
  "audio/m4a",
  "audio/x-m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
]);

const MIME_EXTENSION: Record<string, string> = {
  "audio/m4a": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
};

export type FieldPhotoAccessContext = {
  userId: string;
  userRole: UserRole;
};

export type PhotoTranscriptionAuditContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type PhotoTranscriptionResult = {
  transcript: string;
  language?: string;
  duration?: number;
};

export function getFieldPhotoTranscriptionConfig() {
  return { configured: Boolean(process.env.OPENAI_API_KEY?.trim()) };
}

function normalizeMimeType(value: string | undefined) {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function extensionForMimeType(mimeType: string) {
  return MIME_EXTENSION[mimeType] ?? ".m4a";
}

function assertAllowedAudioMimeType(mimeType: string) {
  if (!FIELD_PHOTO_TRANSCRIPTION_MIME_TYPES.has(mimeType)) {
    throw new AppError(400, "Unsupported audio type. Use M4A, MP3, WAV, MP4 audio, or WebM audio.");
  }
}

function assertAudioBytes(buffer: Buffer) {
  if (!buffer.length) {
    throw new AppError(400, "Audio upload is empty.");
  }
  if (buffer.length > 25 * 1024 * 1024) {
    throw new AppError(400, "Audio upload is too large. Keep recordings under 25 MB.");
  }
}

function fileNameForTranscription(fileName: string | undefined, mimeType: string) {
  const trimmed = fileName?.trim();
  if (trimmed) return trimmed;
  return `photo-description${extensionForMimeType(mimeType)}`;
}

export async function transcribePhotoDescriptionAudio(input: {
  audio: Buffer;
  mimeType: string;
  fileName?: string;
}): Promise<PhotoTranscriptionResult> {
  const mimeType = normalizeMimeType(input.mimeType);
  assertAllowedAudioMimeType(mimeType);
  assertAudioBytes(input.audio);

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new AppError(503, "Voice transcription is not configured.");
  }

  const form = new FormData();
  form.set("model", "whisper-1");
  form.set(
    "file",
    new File([new Uint8Array(input.audio)], fileNameForTranscription(input.fileName, mimeType), { type: mimeType })
  );

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.message ?? "Voice transcription failed.";
    throw new AppError(response.status >= 500 ? 502 : 429, message);
  }

  const transcript = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!transcript) {
    throw new AppError(502, "Voice transcription returned an empty transcript.");
  }

  return {
    transcript,
    language: typeof payload?.language === "string" && payload.language.trim() ? payload.language.trim() : undefined,
    duration: Number.isFinite(payload?.duration) ? Number(payload.duration) : undefined,
  };
}

export async function getAccessibleFieldPhoto(
  tenantDb: TenantDb,
  access: FieldPhotoAccessContext,
  photoId: string
) {
  const photo = await getFileById(tenantDb, photoId);
  if (!photo || photo.category !== "photo") {
    throw new AppError(404, "Photo not found.");
  }

  const hasDealOrLeadLink = Boolean(photo.dealId || photo.leadId);
  const hasOtherEntityLink = Boolean(photo.contactId || photo.procoreProjectId || photo.changeOrderId);

  if (!hasDealOrLeadLink && !hasOtherEntityLink) {
    if (photo.uploadedBy !== access.userId) {
      throw new AppError(404, "Photo not found.");
    }
    return photo;
  }

  if (!hasDealOrLeadLink) {
    throw new AppError(404, "Photo not found.");
  }

  await assertAccessibleFieldCaptureTarget(tenantDb, {
    dealId: photo.dealId ?? undefined,
    leadId: photo.leadId ?? undefined,
    opportunityId: undefined,
    userId: access.userId,
    userRole: access.userRole,
  });

  return photo;
}

export async function transcribeAndPersistFieldPhotoDescription(
  tenantDb: TenantDb,
  access: FieldPhotoAccessContext,
  input: {
    photoId: string;
    audio: Buffer;
    mimeType: string;
    fileName?: string;
    auditContext?: PhotoTranscriptionAuditContext;
  }
): Promise<PhotoTranscriptionResult> {
  const photo = await getAccessibleFieldPhoto(tenantDb, access, input.photoId);
  const result = await transcribePhotoDescriptionAudio({
    audio: input.audio,
    mimeType: input.mimeType,
    fileName: input.fileName,
  });

  await updateFile(tenantDb, photo.id, {
    description: result.transcript,
  });

  await logPhotoEvent(tenantDb, {
    photoId: photo.id,
    eventType: "voice_description_transcribed",
    userId: access.userId,
    ipAddress: input.auditContext?.ipAddress ?? null,
    userAgent: input.auditContext?.userAgent ?? null,
    metadata: {
      oldCaption: photo.description ?? null,
      newCaption: result.transcript,
      language: result.language ?? null,
      duration: result.duration ?? null,
    },
  });

  return result;
}
