import {
  pgTable,
  uuid,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "../public/users.js";
import { projectTypeQuestionNodes } from "../public/project-type-question-nodes.js";
import { leads } from "./leads.js";

export const leadQuestionAnswers = pgTable(
  "lead_question_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id").references(() => leads.id).notNull(),
    questionId: uuid("question_id").references(() => projectTypeQuestionNodes.id).notNull(),
    valueJson: jsonb("value_json"),
    updatedBy: uuid("updated_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("lead_question_answers_lead_question_uidx").on(table.leadId, table.questionId),
    index("lead_question_answers_lead_idx").on(table.leadId, table.updatedAt),
    index("lead_question_answers_question_idx").on(table.questionId, table.updatedAt),
  ]
);
