import crypto from "node:crypto";
import { and, desc, eq, ilike, isNull, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { callRecordings, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { UserRole } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import {
  deleteObject,
  generateDownloadUrl,
  generateMockDownloadUrl,
  generateMockUploadUrl,
  generateUploadUrl,
  headObject,
  isR2Configured,
} from "../../lib/r2-client.js";
import { createActivity } from "../activities/service.js";

type TenantDb = NodePgDatabase<typeof schema>;
export type CallRecordingEntityType = "deal" | "lead" | "company" | "contact";
export type CallRecordingAllowedRole = Exclude<UserRole, "field_contractor">;
export type CallRecordingViewer = {
  role: CallRecordingAllowedRole;
  userId: string;
};

export const MAX_CALL_RECORDING_SIZE_BYTES = 200 * 1024 * 1024;
export const ALLOWED_CALL_RECORDING_MIME_TYPES = new Set([
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

export function isAllowedCallRecordingMimeType(mimeType: string) {
  return ALLOWED_CALL_RECORDING_MIME_TYPES.has(mimeType);
}

function assertEntityType(entityType: string): asserts entityType is CallRecordingEntityType {
  if (!["deal", "lead", "company", "contact"].includes(entityType)) {
    throw new AppError(400, "entityType must be one of deal, lead, company, contact.");
  }
}

function validateMimeType(mimeType: string) {
  if (!isAllowedCallRecordingMimeType(mimeType)) {
    throw new AppError(400, "Unsupported audio type. Use M4A, MP3, WAV, MP4 audio, or WebM audio.");
  }
}

function extensionFor(filename: string, mimeType: string) {
  const ext = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".")).toLowerCase()
    : "";
  const allowedExt = MIME_EXTENSION[mimeType] ?? ".m4a";
  if ([".m4a", ".mp4", ".mp3", ".mpeg", ".wav", ".webm"].includes(ext)) {
    return ext === ".mpeg" ? ".mp3" : ext;
  }
  return allowedExt;
}

export function buildCallRecordingR2Key(input: {
  tenantId: string;
  recordingId: string;
  filename: string;
  mimeType: string;
}) {
  const ext = extensionFor(input.filename, input.mimeType);
  return `call-recordings/${input.tenantId}/${input.recordingId}${ext}`;
}

export async function createUploadUrl(
  tenantDb: TenantDb,
  input: {
    tenantId: string;
    uploadedBy: string;
    entityType: string;
    entityId: string;
    filename: string;
    mimeType: string;
    title?: string | null;
    notes?: string | null;
    callDate?: string | null;
  }
) {
  assertEntityType(input.entityType);
  validateMimeType(input.mimeType);

  const recordingId = crypto.randomUUID();
  const r2Key = buildCallRecordingR2Key({
    tenantId: input.tenantId,
    recordingId,
    filename: input.filename,
    mimeType: input.mimeType,
  });
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  await tenantDb.insert(callRecordings).values({
    id: recordingId,
    tenantId: input.tenantId,
    uploadedBy: input.uploadedBy,
    entityType: input.entityType,
    entityId: input.entityId,
    originalFilename: input.filename,
    r2Key,
    mimeType: input.mimeType,
    fileSizeBytes: 0,
    durationSeconds: null,
    title: input.title?.trim() || null,
    notes: input.notes?.trim() || null,
    callDate: input.callDate ? new Date(input.callDate) : null,
    expiresAt,
    transcriptionStatus: "none",
  });

  const uploadResult = isR2Configured()
    ? await generateUploadUrl(r2Key, input.mimeType, MAX_CALL_RECORDING_SIZE_BYTES)
    : generateMockUploadUrl(r2Key);

  return {
    uploadUrl: uploadResult.uploadUrl,
    r2Key,
    r2_key: r2Key,
    recordingId,
    recording_id: recordingId,
    expiresIn: uploadResult.expiresIn,
  };
}

export async function confirmUpload(
  tenantDb: TenantDb,
  recordingId: string,
  input: {
    fileSizeBytes: number;
    durationSeconds?: number | null;
    userId?: string;
  }
) {
  if (!Number.isFinite(input.fileSizeBytes) || input.fileSizeBytes <= 0) {
    throw new AppError(400, "fileSizeBytes must be greater than 0.");
  }
  if (input.fileSizeBytes > MAX_CALL_RECORDING_SIZE_BYTES) {
    throw new AppError(400, "Call recordings must be 200 MB or smaller.");
  }

  const [recording] = await tenantDb
    .select()
    .from(callRecordings)
    .where(and(eq(callRecordings.id, recordingId), isNull(callRecordings.deletedAt)))
    .limit(1);

  if (!recording) throw new AppError(404, "Call recording not found.");

  if (isR2Configured()) {
    const object = await headObject(recording.r2Key);
    if (!object) {
      throw new AppError(400, "Upload verification failed: object not found in R2.");
    }
    if (object.contentLength != null && object.contentLength !== input.fileSizeBytes) {
      throw new AppError(400, "Upload verification failed: file size does not match R2.");
    }
  }

  const [updated] = await tenantDb
    .update(callRecordings)
    .set({
      fileSizeBytes: input.fileSizeBytes,
      durationSeconds: input.durationSeconds != null && Number.isFinite(input.durationSeconds)
        ? Math.round(input.durationSeconds)
        : null,
      uploadedAt: new Date(),
      transcriptionStatus: "pending",
      transcriptionError: null,
    })
    .where(eq(callRecordings.id, recordingId))
    .returning();

  await createActivity(tenantDb, {
    type: "call",
    responsibleUserId: recording.uploadedBy,
    performedByUserId: input.userId ?? recording.uploadedBy,
    sourceEntityType: recording.entityType as CallRecordingEntityType,
    sourceEntityId: recording.entityId,
    companyId: recording.entityType === "company" ? recording.entityId : undefined,
    leadId: recording.entityType === "lead" ? recording.entityId : undefined,
    dealId: recording.entityType === "deal" ? recording.entityId : undefined,
    contactId: recording.entityType === "contact" ? recording.entityId : undefined,
    subject: `Call recording uploaded: ${recording.title || recording.originalFilename}`,
    body: recording.notes ?? undefined,
    durationMinutes: updated.durationSeconds ? Math.ceil(updated.durationSeconds / 60) : undefined,
    occurredAt: recording.callDate?.toISOString(),
  });

  return updated;
}

export async function listForEntity(
  tenantDb: TenantDb,
  entityType: string,
  entityId: string,
  viewer: CallRecordingViewer,
  options: { search?: string } = {}
) {
  assertEntityType(entityType);
  if (viewer.role === "construction") return [];
  const search = options.search?.trim();

  const rows = await tenantDb
    .select({
      id: callRecordings.id,
      entityType: callRecordings.entityType,
      entityId: callRecordings.entityId,
      originalFilename: callRecordings.originalFilename,
      mimeType: callRecordings.mimeType,
      fileSizeBytes: callRecordings.fileSizeBytes,
      durationSeconds: callRecordings.durationSeconds,
      title: callRecordings.title,
      notes: callRecordings.notes,
      callDate: callRecordings.callDate,
      uploadedAt: callRecordings.uploadedAt,
      uploadedBy: callRecordings.uploadedBy,
      uploadedByName: users.displayName,
      transcriptionStatus: callRecordings.transcriptionStatus,
      transcriptionError: callRecordings.transcriptionError,
      transcriptSummary: callRecordings.transcriptSummary,
    })
    .from(callRecordings)
    .leftJoin(users, eq(users.id, callRecordings.uploadedBy))
    .where(and(
      eq(callRecordings.entityType, entityType),
      eq(callRecordings.entityId, entityId),
      isNull(callRecordings.deletedAt),
      sql`${callRecordings.fileSizeBytes} > 0`,
      search
        ? or(
            ilike(callRecordings.transcriptText, `%${search}%`),
            ilike(callRecordings.transcriptSummary, `%${search}%`)
          )
        : undefined
    ))
    .orderBy(desc(callRecordings.callDate), desc(callRecordings.uploadedAt));

  if (viewer.role === "rep") {
    return rows.filter((recording) => recording.uploadedBy === viewer.userId);
  }

  return rows;
}

export async function getTranscript(
  tenantDb: TenantDb,
  recordingId: string,
  viewer: CallRecordingViewer
) {
  if (viewer.role === "construction") {
    throw new AppError(403, "Call recordings are not available for this role.");
  }

  const [recording] = await tenantDb
    .select({
      uploadedBy: callRecordings.uploadedBy,
      fileSizeBytes: callRecordings.fileSizeBytes,
      transcriptSummary: callRecordings.transcriptSummary,
      transcriptText: callRecordings.transcriptText,
      transcriptionStatus: callRecordings.transcriptionStatus,
      transcriptionError: callRecordings.transcriptionError,
    })
    .from(callRecordings)
    .where(and(eq(callRecordings.id, recordingId), isNull(callRecordings.deletedAt)))
    .limit(1);

  if (!recording || recording.fileSizeBytes <= 0) {
    throw new AppError(404, "Call recording not found.");
  }
  if (viewer.role === "rep" && recording.uploadedBy !== viewer.userId) {
    throw new AppError(404, "Call recording not found.");
  }

  return {
    summary: recording.transcriptSummary,
    fullText: recording.transcriptText,
    status: recording.transcriptionStatus,
    error: recording.transcriptionError,
  };
}

export async function getPlaybackUrl(
  tenantDb: TenantDb,
  recordingId: string,
  viewer: CallRecordingViewer
) {
  if (viewer.role === "construction") {
    throw new AppError(403, "Call recordings are not available for this role.");
  }

  const [recording] = await tenantDb
    .select()
    .from(callRecordings)
    .where(and(eq(callRecordings.id, recordingId), isNull(callRecordings.deletedAt)))
    .limit(1);

  if (!recording || recording.fileSizeBytes <= 0) {
    throw new AppError(404, "Call recording not found.");
  }
  if (viewer.role === "rep" && recording.uploadedBy !== viewer.userId) {
    throw new AppError(404, "Call recording not found.");
  }

  const playbackUrl = isR2Configured()
    ? await generateDownloadUrl(recording.r2Key, 3600)
    : generateMockDownloadUrl(recording.r2Key);

  return { playbackUrl, expiresIn: 3600 };
}

export async function softDelete(
  tenantDb: TenantDb,
  recordingId: string,
  userId: string,
  role = "admin"
): Promise<typeof callRecordings.$inferSelect | null> {
  if (role !== "admin") {
    throw new AppError(403, "Only admins can delete call recordings.");
  }

  const [existing] = await tenantDb
    .select()
    .from(callRecordings)
    .where(eq(callRecordings.id, recordingId))
    .limit(1);

  if (!existing) throw new AppError(404, "Call recording not found.");
  if (existing.deletedAt) return null;

  const [recording] = await tenantDb
    .update(callRecordings)
    .set({ deletedAt: new Date() })
    .where(and(eq(callRecordings.id, recordingId), isNull(callRecordings.deletedAt)))
    .returning();

  if (!recording) throw new AppError(404, "Call recording not found.");

  await createActivity(tenantDb, {
    type: "note",
    responsibleUserId: recording.uploadedBy,
    performedByUserId: userId,
    sourceEntityType: recording.entityType as CallRecordingEntityType,
    sourceEntityId: recording.entityId,
    companyId: recording.entityType === "company" ? recording.entityId : undefined,
    leadId: recording.entityType === "lead" ? recording.entityId : undefined,
    dealId: recording.entityType === "deal" ? recording.entityId : undefined,
    contactId: recording.entityType === "contact" ? recording.entityId : undefined,
    subject: `Call recording deleted: ${recording.title || recording.originalFilename}`,
  });

  return recording;
}

export async function cleanupExpired(tenantDb: TenantDb) {
  const expired = await tenantDb
    .select({ id: callRecordings.id, r2Key: callRecordings.r2Key })
    .from(callRecordings)
    .where(lt(callRecordings.expiresAt, new Date()));

  let deletedObjects = 0;
  for (const recording of expired) {
    if (isR2Configured()) {
      await deleteObject(recording.r2Key);
      deletedObjects += 1;
    }
  }

  if (expired.length > 0) {
    await tenantDb
      .delete(callRecordings)
      .where(lt(callRecordings.expiresAt, new Date()));
  }

  return { deletedRecords: expired.length, deletedObjects };
}
