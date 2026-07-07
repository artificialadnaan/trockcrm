import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import type { UserRole } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { updateFile } from "../files/service.js";
import { logPhotoEvent } from "../files/audit-log-service.js";
import { getAccessibleFieldPhoto } from "./photo-transcription-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface FieldPhotoMetadataAccess {
  userId: string;
  userRole: UserRole;
}

export interface FieldPhotoMetadataInput {
  photoId: string;
  displayName?: string;
  description?: string | null;
  auditContext?: { ipAddress?: string | null; userAgent?: string | null };
}

/**
 * Field-auth edit of an already-uploaded photo's display name / description. Access is enforced via
 * getAccessibleFieldPhoto (rep-owned, photo-only), NOT the session assertDealFileAccess — so a field user
 * can only edit photos they can access. Runs inside the photo's resolved office (via runFieldFileWrite).
 */
export async function updateFieldPhotoMetadata(
  tenantDb: TenantDb,
  access: FieldPhotoMetadataAccess,
  input: FieldPhotoMetadataInput,
) {
  const photo = await getAccessibleFieldPhoto(tenantDb, access, input.photoId);

  // Return only client-relevant fields — never the raw files row, which would leak internal storage keys
  // (r2Key/r2Bucket/thumbnailR2Key) and the idempotency clientUploadId. No caller consumes the body today
  // (the mobile hook invalidates + refetches), so a minimal subset is sufficient.
  const toSafePhoto = (row: { id: string; displayName: string; description: string | null; category: string }) => ({
    id: row.id,
    displayName: row.displayName,
    description: row.description,
    category: row.category,
  });

  const patch: { displayName?: string; description?: string | null } = {};
  if (input.displayName !== undefined) {
    const name = input.displayName.trim();
    if (!name) throw new AppError(400, "Name cannot be empty.");
    patch.displayName = name.slice(0, 500);
  }
  if (input.description !== undefined) {
    // description is a text column (no DB limit) but cap defensively so a pathological caption can't bloat
    // the row or the audit-log metadata.
    const desc = input.description === null ? null : input.description.trim().slice(0, 2000);
    patch.description = desc && desc.length > 0 ? desc : null;
  }
  if (patch.displayName === undefined && patch.description === undefined) {
    return { photo: toSafePhoto(photo) };
  }

  const updated = await updateFile(tenantDb, photo.id, patch);

  if (patch.description !== undefined && photo.description !== updated.description) {
    await logPhotoEvent(tenantDb, {
      photoId: photo.id,
      eventType: "caption_changed",
      userId: access.userId,
      ipAddress: input.auditContext?.ipAddress ?? null,
      userAgent: input.auditContext?.userAgent ?? null,
      metadata: {
        oldCaption: photo.description ?? null,
        newCaption: updated.description ?? null,
      },
    });
  }

  return { photo: toSafePhoto(updated) };
}
