import {
  pgTable,
  pgEnum,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "../public/users.js";
import { leads } from "./leads.js";
import type { LeadDueDiligenceDetectionSignal } from "../../types/lead-due-diligence.js";

export const leadDueDiligenceApprovalStatusEnum = pgEnum(
  "lead_due_diligence_approval_status",
  ["pending", "approved", "rejected", "superseded"]
);

export const leadDueDiligenceApprovals = pgTable(
  "lead_due_diligence_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }).notNull(),
    status: leadDueDiligenceApprovalStatusEnum("status").default("pending").notNull(),
    approvalToken: text("approval_token").notNull(),
    requestedBy: uuid("requested_by").references(() => users.id).notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    detectionSignal: jsonb("detection_signal").$type<LeadDueDiligenceDetectionSignal>().notNull(),
    emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
    emailMessageId: text("email_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("lead_due_diligence_approvals_lead_uidx").on(table.leadId),
    uniqueIndex("lead_due_diligence_approvals_token_uidx").on(table.approvalToken),
    index("lead_due_diligence_approvals_status_requested_idx").on(table.status, table.requestedAt),
    index("lead_due_diligence_approvals_requested_idx").on(table.requestedAt),
  ]
);
