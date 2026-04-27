import {
  pgTable,
  uuid,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { users } from "../public/users.js";
import { projectTypeQuestionNodes } from "../public/project-type-question-nodes.js";
import { leads } from "./leads.js";

export const leadQuestionAnswerHistory = pgTable(
  "lead_question_answer_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id").references(() => leads.id).notNull(),
    questionId: uuid("question_id").references(() => projectTypeQuestionNodes.id).notNull(),
    oldValueJson: jsonb("old_value_json"),
    newValueJson: jsonb("new_value_json"),
    changedBy: uuid("changed_by").references(() => users.id),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("lead_question_answer_history_lead_idx").on(table.leadId, table.changedAt),
    index("lead_question_answer_history_question_idx").on(table.questionId, table.changedAt),
  ]
);
