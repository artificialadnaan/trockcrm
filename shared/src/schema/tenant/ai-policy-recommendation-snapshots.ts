import { pgTable, uuid, varchar, timestamp, index } from "drizzle-orm/pg-core";
import { offices } from "../public/offices.js";
import { users } from "../public/users.js";

export const aiPolicyRecommendationSnapshots = pgTable(
  "ai_policy_recommendation_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").references(() => offices.id).notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id),
    supersedesSnapshotId: uuid("supersedes_snapshot_id"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
    staleAt: timestamp("stale_at", { withTimezone: true }).notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("ai_policy_recommendation_snapshots_office_id_status_idx").on(table.officeId, table.status)]
);
