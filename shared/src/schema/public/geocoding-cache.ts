import { index, jsonb, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export interface GeocodingFormattedComponents {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export const geocodingCache = pgTable(
  "geocoding_cache",
  {
    latitude: numeric("latitude", { precision: 8, scale: 5 }).notNull(),
    longitude: numeric("longitude", { precision: 9, scale: 5 }).notNull(),
    address: text("address"),
    formattedComponents: jsonb("formatted_components").$type<GeocodingFormattedComponents | null>(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).defaultNow().notNull(),
    provider: text("provider").default("google_geocoding").notNull(),
  },
  (table) => [
    primaryKey({
      name: "geocoding_cache_latitude_longitude_provider_pk",
      columns: [table.latitude, table.longitude, table.provider],
    }),
    index("geocoding_cache_cached_at_idx").on(table.cachedAt),
  ]
);
