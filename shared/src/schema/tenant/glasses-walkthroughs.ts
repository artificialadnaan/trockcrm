import { pgTable, uuid, varchar, timestamp, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import type { GlassesWalkCaptureCensus } from "../../types/glasses-walk-capture-census.js";
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
    /**
     * Which TROCK Scope work-type catalog this walk should be graded against.
     *
     * RESOLVED AT INGEST, never merely received: the client's statement if it made one, otherwise the
     * DEAL's own project type. No capture client sends a job type and none is likely to — nobody picks a
     * work-type catalog on a phone mid-walk — so in practice this column is the deal's answer, mapped in
     * server/src/modules/walkthrough-capture/glasses-walkthrough-job-type.ts.
     *
     * NULL means "filed before anyone asked": every historical row, and nothing backfills them, because
     * the deal's type today is not evidence of what it was on the day of the walk.
     *
     * WIDER THAN WHAT IS SENT, deliberately. This says what the walk IS; the forward job withholds a job
     * type TROCK Scope has no seeded catalog for, since sending one it cannot ground is a 422 that costs
     * the walk entirely. So this stays correct for the day that catalog exists.
     *
     * The authoritative vocabulary is `JOB_TYPES` in the trock-scope repo, validated at the ingest route
     * and again by TROCK Scope. Migration 0243 owns the DDL and explains why there is no CHECK here.
     */
    jobType: varchar("job_type", { length: 40 }),
    /**
     * What the phone's recorder ACTUALLY wrote during this walk — frames and audio buffers received,
     * appended and dropped, seconds of narration landed, audio engine restarts — as counted by the phone
     * itself and sent on the completion call. NULL when the client did not send one: every walk before
     * migration 0244, and every walk from an app build that predates the census.
     *
     * The phone already measures this for its completion screen and then throws it away; on 2026-09-02
     * two walks lost minutes of narration and finding out why meant reading packet timestamps out of
     * 400 MB of video. Filed here, that diagnosis is one row read. See migration 0244 for why this is one
     * jsonb column rather than a column per counter (the recorder owns the shape, on its own release
     * cadence), and shared/src/types/glasses-walk-capture-census.ts for the contract, the bounds the ingest
     * route enforces, and the one number derived from it at read time — the narration shortfall — which is
     * deliberately never stored, so it cannot disagree with the counts it came from.
     *
     * A THIRD WRITER joins the two named above, but only of this column: `recordGlassesWalkthrough` fills
     * it on a re-filed walk when — and only when — it is still NULL, so the first non-null census wins in
     * the same way every other fact on this row belongs to the first completion.
     */
    captureCensus: jsonb("capture_census").$type<GlassesWalkCaptureCensus>(),
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
