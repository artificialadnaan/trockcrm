import { pgTable, uuid, varchar, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { deals } from "./deals.js";

// Per-office (cloned into every office_* schema). The CRM's own record that a Ray-Ban Meta glasses walk
// exists against a deal, and which TROCK Scope walkthrough it became.
//
// Before this table the only link between a deal and its TROCK Scope walkthrough lived in a
// `public.job_queue` payload — a queue row that is dead-lettered, superseded and hand-edited during
// reconciliation, and that does not exist at all in the window between a walk being filed and its forward
// being claimed. Migration 0214 owns the DDL; this file mirrors it so `db:generate` sees parity rather
// than drift, and carries the reasoning that a reader of the schema needs.
//
// TWO WRITERS, no more: `ingestGlassesWalkthrough` inserts the row alongside the walk's `files` rows
// (server/src/modules/walkthrough-capture/glasses-walkthrough-service.ts), and the forward job stamps
// `scopeWalkthroughId` once TROCK Scope answers (worker/src/jobs/glasses-walkthrough-forward.ts).
export const glassesWalkthroughs = pgTable(
  "glasses_walkthroughs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    /** The walk id minted on the PHONE. Identifies a physical walk, NOT a piece of work — it is not unique
     *  across deals, which is why every uniqueness rule in this feature is scoped to the (deal, walk) pair.
     *  varchar(100) pins MAX_WALK_ID_CHARS in glasses-walkthrough-service.ts. */
    walkId: varchar("walk_id", { length: 100 }).notNull(),
    /** TROCK Scope's own walkthrough uuid. NULL until the forward job has actually created (or resumed)
     *  it — which is exactly the "processing" state the deal-page panel renders. */
    scopeWalkthroughId: uuid("scope_walkthrough_id"),
    /** When the WALK happened, per the phone's clock — not when the upload finished. Over jobsite cellular
     *  those differ by hours, sometimes days, so ordering by created_at would order by when the signal came
     *  back rather than by when anyone was on site. */
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /**
     * The estimator who recorded it. A BARE uuid here, exactly like the responder ids in
     * field-scorecards.ts: the FK targets `public.users`, which is outside this tenant schema, so it is
     * declared in migration 0214 (ON DELETE SET NULL) rather than here — Drizzle would otherwise emit it
     * against a tenant-local `users` table that does not exist.
     *
     * Nullable, and that is the FK's direction rather than an oversight: the actor is PROVENANCE on a
     * historical record, so removing a user must neither delete the walk's link to a scope extraction
     * somebody paid for nor be blocked by it.
     */
    capturedByUserId: uuid("captured_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // The re-ingest idempotency mechanism — mirrors migration 0214's glasses_walkthroughs_deal_walk_uidx.
    // A completion is retried as a matter of course (a response lost in flight; a recovered walk re-filed
    // from a directory scan), and without this one physical walk grows a second panel entry per retry.
    // (deal_id, walk_id) rather than walk_id alone, because re-filing ONE walk against a SECOND deal is a
    // supported correction flow — the same pair the R2 keys, the forward-job dedupe (0211/0213) and TROCK
    // Scope's externalRef are all scoped by.
    uniqueIndex("glasses_walkthroughs_deal_walk_uidx").on(table.dealId, table.walkId),
  ],
);
