import {
  pgSchema,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

const migrationSchema = pgSchema("migration");

export const importRuns = migrationSchema.table("import_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: varchar("type", { length: 50 }).notNull(), // "extract" | "validate" | "promote"
  status: varchar("status", { length: 50 }).notNull(), // "running" | "completed" | "failed" | "rolled_back"
  stats: jsonb("stats").default({}).notNull(),
  errorLog: text("error_log"),
  runBy: uuid("run_by"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
