import { pgTable, uuid, text, timestamp, index, bigserial } from "drizzle-orm/pg-core";

// Per-office (cloned into every office_* schema). The APPEND-ONLY thread documenting a corrective action's
// full back-and-forth: submitted -> rejected (with the approver's reason) -> resubmitted -> approved.
//
// Why a separate table: scorecard_corrective_actions carries a SINGLE set of response columns
// (response_comment, responder_name, responded_at), so a resubmission overwrites the previous attempt. The
// item row is the CURRENT state; this table is the history. Without it the PDF and the CRM could only ever
// show the final round, which is precisely what "all the back-and-forth is documented" rules out.
//
// FKs, the event_type CHECK and the rejected-needs-comment CHECK are owned by migration 0202; Drizzle keeps
// bare columns to match the field-scorecards / corrective-actions convention in this directory.
export const scorecardCorrectiveActionEvents = pgTable(
  "scorecard_corrective_action_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Monotonic insertion order — the ONLY stable sort for this thread. created_at alone is not: several
     * events can be written in one transaction and share a timestamp, and the uuid PK is random, so the
     * thread would render in an arbitrary order. For an audit trail whose value IS the sequence, that is a
     * correctness bug rather than a cosmetic one.
     */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    /**
     * Nullable, matching migration 0202's ON DELETE SET NULL. An edit that removes a flagged item must not
     * erase the approver's rejection and the responder's answer — that history is what the PDF and the CRM
     * exist to show, and scorecard_id keeps a detached event readable as part of its card's record.
     */
    correctiveActionId: uuid("corrective_action_id"),
    /** Denormalized: the whole thread for a card is one indexed read. */
    scorecardId: uuid("scorecard_id").notNull(),
    /** 'submitted' | 'approved' | 'rejected' */
    eventType: text("event_type").notNull(),
    /** Null for a token responder, who has no CRM user id. */
    actorUserId: uuid("actor_user_id"),
    /** Captured at write time so a later rename/archive cannot rewrite history. */
    actorName: text("actor_name"),
    actorEmail: text("actor_email"),
    /** The response text, or the rejection reason. Required for a rejection (enforced by a CHECK in 0202). */
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("scorecard_corrective_action_events_scorecard_idx").on(table.scorecardId, table.seq),
    index("scorecard_corrective_action_events_item_idx").on(table.correctiveActionId, table.seq),
  ],
);
