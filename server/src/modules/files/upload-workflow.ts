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
  }
): Promise<void> {
  const { file, userId, officeId, addressSource, auditContext } = input;

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
