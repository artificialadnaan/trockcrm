import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  fieldUserStarredProjects,
  files,
  photoAddressSourceEnum,
  photoAuditEventTypeEnum,
  photoAuditLog,
  photoCategoryEnum,
  procorePhotoSyncStatusEnum,
} from "../../../../shared/src/schema/index.js";
import { USER_ROLES } from "../../../../shared/src/types/enums.js";

describe("photo schema foundation", () => {
  it("adds nullable photo metadata columns without changing the required file category", () => {
    const columns = getTableColumns(files);

    expect(columns.category.notNull).toBe(true);
    expect(columns.latitude.name).toBe("latitude");
    expect(columns.latitude.notNull).toBe(false);
    expect(columns.longitude.name).toBe("longitude");
    expect(columns.longitude.notNull).toBe(false);
    expect(columns.address.name).toBe("address");
    expect(columns.addressSource.name).toBe("address_source");
    expect(columns.geocodedAt.name).toBe("geocoded_at");
    expect(columns.takenAt.name).toBe("taken_at");
    expect(columns.photoCategory.name).toBe("photo_category");
    expect(columns.deletedAt.name).toBe("deleted_at");
    expect(columns.deletedByUserId.name).toBe("deleted_by_user_id");
    expect(columns.procoreSyncStatus.name).toBe("procore_sync_status");
    expect(columns.procorePhotoId.name).toBe("procore_photo_id");
  });

  it("exposes the photo enum values needed by follow-on PRs", () => {
    expect(photoAddressSourceEnum.enumValues).toEqual([
      "exif",
      "live_gps",
      "deal_fallback",
      "manual_override",
    ]);
    // Legacy values (retained for existing rows) followed by the 6 phase
    // categories added in migration 0165. Order mirrors PHOTO_CATEGORIES.
    expect(photoCategoryEnum.enumValues).toEqual([
      "before",
      "after",
      "progress",
      "site_visit",
      "damage",
      "safety",
      "delivery",
      "other",
      "estimating",
      "preconstruction",
      "construction",
      "final_completion",
      "punch",
      "issues",
    ]);
    expect(procorePhotoSyncStatusEnum.enumValues).toEqual([
      "pending",
      "synced",
      "failed",
      "skipped",
    ]);
  });

  it("models the photo audit log with event/user indexes and json metadata", () => {
    const columns = getTableColumns(photoAuditLog);
    const config = getTableConfig(photoAuditLog);

    expect(columns.id.primary).toBe(true);
    expect(columns.photoId.name).toBe("photo_id");
    expect(columns.userId.name).toBe("user_id");
    expect(columns.createdAt.hasDefault).toBe(true);
    expect(columns.ipAddress.name).toBe("ip_address");
    expect(columns.userAgent.name).toBe("user_agent");
    expect(columns.metadata.name).toBe("metadata");
    expect(photoAuditEventTypeEnum.enumValues).toEqual([
      "uploaded",
      "category_changed",
      "address_changed",
      "caption_changed",
      "voice_description_transcribed",
      "downloaded",
      "deleted",
      "restored",
      "procore_synced",
      "procore_sync_failed",
      "procore_sync_retry_requested",
    ]);
    expect(config.indexes.map((idx) => idx.config.name)).toEqual(
      expect.arrayContaining([
        "photo_audit_log_photo_idx",
        "photo_audit_log_user_idx",
        "photo_audit_log_photo_created_idx",
        "photo_audit_log_user_created_idx",
      ])
    );
  });

  it("models field user starred projects with a composite primary key", () => {
    const columns = getTableColumns(fieldUserStarredProjects);
    const config = getTableConfig(fieldUserStarredProjects);

    expect(columns.userId.name).toBe("user_id");
    expect(columns.dealId.name).toBe("deal_id");
    expect(columns.starredAt.hasDefault).toBe(true);
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.primaryKeys[0].getName()).toBe("field_user_starred_projects_user_id_deal_id_pk");
    expect(config.indexes.map((idx) => idx.config.name)).toContain("field_user_starred_projects_user_idx");
  });

  it("adds the field contractor role value for future auth wiring", () => {
    expect(USER_ROLES).toContain("field_contractor");
  });
});
