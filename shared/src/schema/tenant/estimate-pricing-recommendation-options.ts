import { index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { estimatePricingRecommendations } from "./estimate-pricing-recommendations.js";

export const estimatePricingRecommendationOptions = pgTable(
  "estimate_pricing_recommendation_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recommendationId: uuid("recommendation_id")
      .references(() => estimatePricingRecommendations.id, { onDelete: "cascade" })
      .notNull(),
    catalogItemId: uuid("catalog_item_id"),
    localCatalogItemId: uuid("local_catalog_item_id"),
    rank: integer("rank").notNull(),
    optionLabel: text("option_label").notNull(),
    optionKind: text("option_kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("estimate_pricing_recommendation_options_rank_uidx").on(
      table.recommendationId,
      table.rank
    ),
    index("estimate_pricing_recommendation_options_recommendation_idx").on(
      table.recommendationId
    ),
  ]
);
