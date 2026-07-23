import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";

// Per-office (cloned into every office_* schema). One row per flagged item on a below-band scorecard,
// seeded `open` at submit; flips to `resolved` when the super/PM documents corrective action. The
// scorecard auto-closes once no `open` rows remain. FKs (scorecard_id -> field_scorecards) and the
// (scorecard_id, item_type, item_ref) uniqueness are owned by migration 0192; Drizzle keeps bare uuid
// columns to match the closeout-checklist / field-scorecards convention.
export const scorecardCorrectiveActions = pgTable(
  "scorecard_corrective_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scorecardId: uuid("scorecard_id").notNull(),
    /** 'action_item' | 'critical_deficiency' */
    itemType: text("item_type").notNull(),
    /** action-item index (as string) or the critical-deficiency key. */
    itemRef: text("item_ref").notNull(),
    /** Denormalized human label captured at seed time (action text / deficiency label). */
    itemLabel: text("item_label").notNull(),
    /** 'open' | 'resolved' */
    status: text("status").default("open").notNull(),
    responseComment: text("response_comment"),
    respondedByUserId: uuid("responded_by_user_id"),
    responderName: text("responder_name"),
    responderEmail: text("responder_email"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("scorecard_corrective_actions_scorecard_item_key").on(
      table.scorecardId,
      table.itemType,
      table.itemRef,
    ),
    index("scorecard_corrective_actions_scorecard_idx").on(table.scorecardId),
    // Partial index over open items — mirrors migration 0192's scorecard_corrective_actions_open_idx so
    // db:generate sees parity. Backs the closure check (any `open` rows left for this scorecard?).
    index("scorecard_corrective_actions_open_idx")
      .on(table.scorecardId)
      .where(sql`${table.status} = 'open'`),
  ],
);
