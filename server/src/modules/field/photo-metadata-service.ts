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

  const patch: { displayName?: string; description?: string | null } = {};
  if (input.displayName !== undefined) {
    const name = input.displayName.trim();
    if (!name) throw new AppError(400, "Name cannot be empty.");
    patch.displayName = name.slice(0, 500);
  }
  if (input.description !== undefined) {
    const desc = input.description === null ? null : input.description.trim();
    patch.description = desc && desc.length > 0 ? desc : null;
  }
  if (patch.displayName === undefined && patch.description === undefined) {
    return { photo };
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

  return { photo: updated };
}
