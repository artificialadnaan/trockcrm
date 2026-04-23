import {
  pgTable,
  date,
  uuid,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { offices } from "../public/offices.js";
import { users } from "../public/users.js";
import { notificationTypeEnum } from "./notifications.js";

export const aiManagerAlertSendLedger = pgTable(
  "ai_manager_alert_send_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    officeId: uuid("office_id").references(() => offices.id).notNull(),
    recipientUserId: uuid("recipient_user_id").references(() => users.id).notNull(),
    summaryType: notificationTypeEnum("summary_type").notNull(),
    officeLocalDate: date("office_local_date").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("ai_manager_alert_send_ledger_office_id_recipient_user_id_summary_type_office_local_date_uidx").on(
      table.officeId,
      table.recipientUserId,
      table.summaryType,
      table.officeLocalDate
    ),
  ]
);
