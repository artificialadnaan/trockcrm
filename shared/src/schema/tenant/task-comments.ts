import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tasks } from "./tasks.js";
import { users } from "../public/users.js";

/**
 * The three shapes a row on a task's thread can take.
 *
 * 'reply' is the one the closed loop turns on: only a reply from the ASSIGNEE stamps
 * `tasks.last_reply_at` and puts the task in the assigner's "Needs your attention" bucket. 'note' is
 * a comment that deliberately does not raise anything, and 'system' is reserved for rows written by
 * the platform rather than a person.
 */
export const TASK_COMMENT_KINDS = ["reply", "note", "system"] as const;
export type TaskCommentKind = (typeof TASK_COMMENT_KINDS)[number];

/**
 * Flat, append-only thread on a task. Migration 0234.
 *
 * NOT THREADED, and there is no `updated_at`. One level is what the ask describes, and
 * `ai_disconnect_case_history` -- the closest existing shape in this schema -- is flat too. The
 * missing `updated_at` is deliberate rather than an omission: nothing edits a comment, so a column
 * with no writer would sit there reading as "last edited" while only ever holding the insert time
 * (the same dead-column trap `disqualified_at` is).
 */
export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    // FK to public.users, mirroring the `tasks.created_by` this column parallels. NULL means the
    // platform wrote the row (kind = 'system'), not "we lost the author".
    authorId: uuid("author_id").references(() => users.id),
    body: text("body").notNull(),
    kind: varchar("kind", { length: 20 }).default("reply").notNull(),
    // Migration 0234 defaults this to clock_timestamp(), not now(): now() is transaction-START, and
    // a reply committed by a slow transaction would carry a timestamp older than an acknowledgement
    // that never saw it, permanently hiding it from "Needs your attention". Drizzle's defaultNow()
    // renders now(), so 0234's SQL is authoritative for the default -- this marker exists for the
    // column's type and nullability.
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    // Serves the thread read (one task, oldest->newest or newest-first) and the unread-since-ack count.
    index("task_comments_task_created_idx").on(table.taskId, table.createdAt),
    // A whitespace-only body is not a reply. Enforced in the DB because the composer is not the only
    // possible writer -- the reply-by-email path this design leaves room for would bypass any JS guard.
    //
    // `btrim(body) <> ''` -- the obvious spelling, and the one the spec called for -- does NOT do this:
    // btrim's default trim set is the SPACE character alone, so a body of newlines and tabs sails past
    // it. Requiring at least one non-whitespace character is the rule that was actually meant.
    check("task_comments_body_not_blank", sql`${table.body} ~ '[^[:space:]]'`),
    check(
      "task_comments_kind_check",
      sql`${table.kind} IN ('reply', 'note', 'system')`
    ),
  ]
);
