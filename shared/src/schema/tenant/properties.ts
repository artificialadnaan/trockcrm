import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  index,
  pgEnum,
  check,
} from "drizzle-orm/pg-core";
import { PROPERTY_TYPES } from "../../types/enums.js";
import { companies } from "./companies.js";

export const propertyTypeEnum = pgEnum("property_type", PROPERTY_TYPES);

export const properties = pgTable(
  "properties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id).notNull(),
    name: varchar("name", { length: 500 }).notNull(),
    address: text("address"),
    city: varchar("city", { length: 255 }),
    state: varchar("state", { length: 2 }),
    zip: varchar("zip", { length: 10 }),
    type: propertyTypeEnum("type"),
    propertyType: text("property_type"),
    buildYear: integer("build_year"),
    unitCount: integer("unit_count"),
    floors: integer("floors"),
    roofArea: integer("roof_area"),
    lat: numeric("lat", { precision: 10, scale: 7 }),
    lng: numeric("lng", { precision: 10, scale: 7 }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    procoreId: text("procore_id"),
    procorePropertyId: text("procore_property_id"),
    companycamId: text("companycam_id"),
    companycamProjectId: text("companycam_project_id"),
    hubspotPropertyId: text("hubspot_property_id"),
    // Optional cover photo for the property profile. `imageR2Key` is the full-size original in R2;
    // `imageThumbnailR2Key` is a small server-generated JPEG (sharp) used for the header avatar. Both null
    // when no photo has been uploaded. Served to clients as presigned URLs, never as raw keys.
    imageR2Key: text("image_r2_key"),
    imageThumbnailR2Key: text("image_thumbnail_r2_key"),
    notes: text("notes"),
    isTestData: boolean("is_test_data").default(false).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("properties_company_id_idx").on(table.companyId),
    index("properties_company_name_idx").on(table.companyId, table.name),
    index("properties_type_idx").on(table.type),
    index("properties_last_activity_idx").on(table.lastActivityAt),
    check(
      "properties_property_type_check",
      sql`${table.propertyType} IS NULL OR ${table.propertyType} IN ('school', 'office', 'industrial', 'retail', 'healthcare', 'government', 'mixed_use')`
    ),
  ]
);
