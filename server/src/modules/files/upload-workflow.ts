import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { DOMAIN_EVENTS } from "@trock-crm/shared/types";
import { eventBus } from "../../events/bus.js";
import { logPhotoEvent } from "./audit-log-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

type UploadedFile = {
  id: string;
  r2Key: string;
  mimeType: string;
  dealId: string | null;
  leadId: string | null;
  contactId: string | null;
  category: string;
  uploadedBy: string;
  addressSource?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  photoCategory?: string | null;
  fileSizeBytes?: number | null;
};

export type UploadAuditContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function recordUploadedFileSideEffects(
  tenantDb: TenantDb,
  input: {
    file: UploadedFile;
    userId: string;
    officeId: string;
    addressSource?: string | null;
    auditContext?: UploadAuditContext;
    /**
     * How many captures were still waiting on the uploading device when this one was confirmed.
     *
     * Recorded because the absence of this number is what made a real incident invisible. A crew's
     * device queue is local to the phone: the server sees photos arrive and has no idea whether one
     * arrived alone or with 300 behind it. A superintendent's backlog therefore grew for three days in
     * silence and was only found by reconstructing capture-vs-arrival dates AFTER he filed a report.
     * With this, a 260-deep queue is one query against photo_audit_log.metadata, not a forensics job.
     *
     * Reported by the client, so it is a hint and not a fact — clamped, never trusted for any decision,
     * and only ever read as telemetry.
     */
    queueDepth?: number | null;
  }
): Promise<void> {
  const { file, userId, officeId, addressSource, auditContext, queueDepth } = input;

  if (file.category === "photo") {
    await logPhotoEvent(tenantDb, {
      photoId: file.id,
      eventType: "uploaded",
      userId,
      ipAddress: auditContext?.ipAddress ?? null,
      userAgent: auditContext?.userAgent ?? null,
      metadata: {
        addressSource: file.addressSource ?? addressSource ?? null,
        hasGpsCoordinates: Boolean(file.latitude && file.longitude),
        category: file.photoCategory ?? null,
        sizeBytes: file.fileSizeBytes ?? null,
        // Omitted entirely rather than written as null when the client did not report one, so a query
        // can tell "this build does not send it" apart from "this device's queue was empty".
        ...(typeof queueDepth === "number" ? { deviceQueueDepth: queueDepth } : {}),
      },
    });
  }

  const jobPayload = JSON.stringify({
    eventName: "file.uploaded",
    fileId: file.id,
    r2Key: file.r2Key,
    mimeType: file.mimeType,
    dealId: file.dealId,
    leadId: file.leadId,
    contactId: file.contactId,
    category: file.category,
    uploadedBy: userId,
  });
  await tenantDb.execute(
    sql`INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
        VALUES ('domain_event', ${jobPayload}::jsonb, ${officeId}::uuid, 'pending', NOW())`
  );
}

export function emitUploadedFileEvent(input: {
  file: UploadedFile;
  userId: string;
  officeId: string;
}): void {
  const { file, userId, officeId } = input;
  try {
    eventBus.emitLocal({
      name: DOMAIN_EVENTS.FILE_UPLOADED,
      payload: {
        fileId: file.id,
        r2Key: file.r2Key,
        mimeType: file.mimeType,
        dealId: file.dealId,
        leadId: file.leadId,
        contactId: file.contactId,
        category: file.category,
        uploadedBy: userId,
      },
      officeId,
      userId,
      timestamp: new Date(),
    });
  } catch (_) {
    // Best effort — worker handles persisted job_queue entries.
  }
}
