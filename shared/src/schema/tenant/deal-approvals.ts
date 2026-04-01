import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { APPROVAL_STATUSES } from "../../types/enums.js";
import { userRoleEnum } from "../public/users.js";

export const approvalStatusEnum = pgEnum("approval_status", APPROVAL_STATUSES);

export const dealApprovals = pgTable(
  "deal_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id").notNull(),
    targetStageId: uuid("target_stage_id").notNull(),
    requiredRole: userRoleEnum("required_role").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    approvedBy: uuid("approved_by"),
    status: approvalStatusEnum("status").default("pending").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [unique().on(table.dealId, table.targetStageId, table.requiredRole)]
);
