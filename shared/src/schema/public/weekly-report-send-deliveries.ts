import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

// PUBLIC, not per-office, for the same reason public.weekly_report_tokens is: the thing that arrives has
// no office context, and this row is what supplies it.
//
// A delivery webhook carries no session, no office header and no tenant hint at all — only the provider's
// event and the `send_delivery_key` the message was tagged with. Without this map the handler would have
// to fan that key across every `office_*` schema on every event, which is a cross-office scan driven by a
// world-reachable endpoint and a way to read one office's rows from another. Same reasoning that put
// public.field_ai_report_runs (0209) in public. Migration 0227 owns the DDL.
//
// ONE ROW PER SEND REQUEST, keyed on the request's own idempotency key. A retry replays the same key and
// inserts nothing; a correction is a new report row with its own key and gets its own row here — which is
// exactly what keeps a bounce on version N off version N+1.
export const weeklyReportSendDeliveries = pgTable(
  "weekly_report_send_deliveries",
  {
    /** `weekly_reports.send_delivery_key`. The provider's idempotency key, minted per send request. */
    deliveryKey: uuid("delivery_key").primaryKey(),
    /** Bare uuid: the report lives in an office_* schema, which no public-schema FK can reach. */
    weeklyReportId: uuid("weekly_report_id").notNull(),
    /** `offices.id`. Bare, matching public.weekly_report_tokens' shipped DDL, which declares no FK either. */
    tenantId: uuid("tenant_id").notNull(),
    /** Carried on the row so the webhook can pick a search_path from the delivery key alone. */
    officeSlug: text("office_slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("weekly_report_send_deliveries_report_idx").on(table.weeklyReportId)],
);
