import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  bigint,
  integer,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { FILE_CATEGORIES } from "../../types/enums.js";

export const fileCategoryEnum = pgEnum("file_category", FILE_CATEGORIES);

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
    r2Bucket: varchar("r2_bucket", { length: 100 }).notNull(),
    dealId: uuid("deal_id"),
    contactId: uuid("contact_id"),
    procoreProjectId: bigint("procore_project_id", { mode: "number" }),
    changeOrderId: uuid("change_order_id"),
    description: text("description"),
    notes: text("notes"),
    version: integer("version").default(1).notNull(),
    parentFileId: uuid("parent_file_id"),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    geoLat: numeric("geo_lat", { precision: 10, scale: 7 }),
    geoLng: numeric("geo_lng", { precision: 10, scale: 7 }),
    uploadedBy: uuid("uploaded_by").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("files_deal_idx").on(table.dealId, table.category, table.createdAt),
    index("files_folder_idx").on(table.folderPath, table.displayName),
  ]
);
