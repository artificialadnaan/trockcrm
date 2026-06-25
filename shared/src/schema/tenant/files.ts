import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  bigint,
  integer,
  jsonb,
  numeric,
  timestamp,
  index,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  FILE_CATEGORIES,
  PHOTO_ADDRESS_SOURCES,
  PHOTO_AUDIT_EVENT_TYPES,
  PHOTO_CATEGORIES,
  PROCORE_PHOTO_SYNC_STATUSES,
} from "../../types/enums.js";
import { users } from "../public/users.js";
import { deals } from "./deals.js";
import { leads } from "./leads.js";

export const fileCategoryEnum = pgEnum("file_category", FILE_CATEGORIES);
export const photoAddressSourceEnum = pgEnum("photo_address_source", PHOTO_ADDRESS_SOURCES);
export const photoCategoryEnum = pgEnum("photo_category", PHOTO_CATEGORIES);
export const procorePhotoSyncStatusEnum = pgEnum("procore_photo_sync_status", PROCORE_PHOTO_SYNC_STATUSES);
export const photoAuditEventTypeEnum = pgEnum("photo_audit_event_type", PHOTO_AUDIT_EVENT_TYPES);

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    category: fileCategoryEnum("category").notNull(),
    subcategory: varchar("subcategory", { length: 100 }),
    folderPath: varchar("folder_path", { length: 1000 }),
    tags: text("tags").array().default([]).notNull(),
    displayName: varchar("display_name", { length: 500 }).notNull(),
    systemFilename: varchar("system_filename", { length: 500 }).notNull(),
    originalFilename: varchar("original_filename", { length: 500 }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
    fileExtension: varchar("file_extension", { length: 20 }).notNull(),
    r2Key: varchar("r2_key", { length: 1000 }).unique().notNull(),
    // Optional sibling R2 object: a small JPEG thumbnail of an image `r2Key`, generated server-side at
    // ingest (confirm-upload + CompanyCam sync). The grid loads this; the lightbox keeps the full original.
    // Null for non-images and for rows uploaded before thumbnails existed — callers fall back to r2Key.
    thumbnailR2Key: varchar("thumbnail_r2_key", { length: 1000 }),
    r2Bucket: varchar("r2_bucket", { length: 100 }).notNull(),
    dealId: uuid("deal_id"),
    leadId: uuid("lead_id").references(() => leads.id),
    intakeSection: varchar("intake_section", { length: 100 }),
    intakeRequirementKey: varchar("intake_requirement_key", { length: 100 }),
    intakeSource: varchar("intake_source", { length: 30 }),
    contactId: uuid("contact_id"),
    procoreProjectId: bigint("procore_project_id", { mode: "number" }),
    changeOrderId: uuid("change_order_id"),
    externalUrl: varchar("external_url", { length: 2000 }),
    externalThumbnailUrl: varchar("external_thumbnail_url", { length: 2000 }),
    companycamPhotoId: varchar("companycam_photo_id", { length: 50 }),
    description: text("description"),
    notes: text("notes"),
    version: integer("version").default(1).notNull(),
    parentFileId: uuid("parent_file_id"),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    geoLat: numeric("geo_lat", { precision: 10, scale: 7 }),
    geoLng: numeric("geo_lng", { precision: 10, scale: 7 }),
    latitude: numeric("latitude", { precision: 10, scale: 7 }),
    longitude: numeric("longitude", { precision: 10, scale: 7 }),
    address: text("address"),
    addressSource: photoAddressSourceEnum("address_source"),
    geocodedAt: timestamp("geocoded_at", { withTimezone: true }),
    photoCategory: photoCategoryEnum("photo_category"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
    procoreSyncStatus: procorePhotoSyncStatusEnum("procore_sync_status"),
    procorePhotoId: text("procore_photo_id"),
    uploadedBy: uuid("uploaded_by").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("files_deal_idx").on(table.dealId, table.category, table.createdAt),
    index("files_lead_idx").on(table.leadId, table.category, table.createdAt),
    index("files_folder_idx").on(table.folderPath, table.displayName),
  ]
);

export const photoAuditLog = pgTable(
  "photo_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    photoId: uuid("photo_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    eventType: photoAuditEventTypeEnum("event_type").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata"),
  },
  (table) => [
    index("photo_audit_log_photo_idx").on(table.photoId),
    index("photo_audit_log_user_idx").on(table.userId),
    index("photo_audit_log_photo_created_idx").on(table.photoId, table.createdAt.desc()),
    index("photo_audit_log_user_created_idx").on(table.userId, table.createdAt.desc()),
  ]
);

export const fieldUserStarredProjects = pgTable(
  "field_user_starred_projects",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    dealId: uuid("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
    starredAt: timestamp("starred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "field_user_starred_projects_user_id_deal_id_pk",
      columns: [table.userId, table.dealId],
    }),
    index("field_user_starred_projects_user_idx").on(table.userId),
  ]
);

export const photoTags = pgTable(
  "photo_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    photoId: uuid("photo_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  },
  (table) => [
    index("photo_tags_photo_idx").on(table.photoId),
    index("photo_tags_tag_idx").on(table.tag),
    index("photo_tags_created_at_idx").on(table.createdAt.desc()),
    index("photo_tags_photo_created_idx").on(table.photoId, table.createdAt.desc()),
    uniqueIndex("photo_tags_photo_id_tag_idx").on(table.photoId, table.tag),
  ]
);
