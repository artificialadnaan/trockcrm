export interface RfpRequestDeliveryPayload {
  dealId: string;
  syncHubUrl: string;
  body: Record<string, unknown>;
  dealHandled?: boolean | "claimed";
}

/**
 * EVERY queued job that belongs to a deal's RFP cycle, and therefore must be cancelled when that cycle
 * is retired ("Move back to Opportunity").
 *
 * THE RULE, decided once: an `rfp_*` job is scoped to the round that enqueued it. Retiring the round
 * retires its queued work — all of it, with no exemptions. The four notification jobs are as much a part
 * of the cycle as the two delivery jobs: each one addresses a HUMAN about a decision on a round that no
 * longer exists, and none of them is a gate (their own docs call them "an FYI notification, not a gate"
 * and are careful to "never crash — the linkage already committed"). So cancelling them costs nothing
 * but a wrong email, while letting them run tells a rep their RFP passed and a Bid Board project is
 * being created for a deal this action has just detached.
 *
 * WHY A CONSTANT AND NOT A HAND-WRITTEN `IN (...)` LIST. The list lived inline in the move-back's cancel
 * statement and covered 3 of these 7. Three consecutive review rounds each added exactly one more job
 * type. A hand-maintained list cannot be checked, so it silently drifts every time a new `rfp_*` job is
 * added. This constant is the single source of truth, and
 * `worker/tests/jobs/rfp-round-scoped-jobs.invariant.test.ts` asserts it against the worker's ACTUAL
 * handler registry — so a newly registered `rfp_*` job fails the build until it is classified here.
 *
 * If a future `rfp_*` job genuinely SHOULD survive retirement, it still has to be named: add it to
 * RFP_JOB_TYPES_EXEMPT_FROM_CYCLE_RETIREMENT below with the reason, so the decision is recorded rather
 * than expressed as an omission.
 */
export const RFP_ROUND_SCOPED_JOB_TYPES = [
  // Outbound work that creates external state for the round.
  "rfp_request_delivery",
  "rfp_bidboard_create",
  // Human notifications about the round's progress or verdict.
  "rfp_vote_invitation",
  "rfp_vote_outcome",
  "rfp_rejected_email",
  "rfp_override_approved_email",
  "rfp_reconfirm_denial_email",
] as const;

export type RfpRoundScopedJobType = (typeof RFP_ROUND_SCOPED_JOB_TYPES)[number];

/**
 * `rfp_*` job types that deliberately OUTLIVE the cycle they were queued for. Empty today, and that is a
 * decision rather than an oversight: all seven current RFP jobs describe a specific round to a person or
 * to SyncHub, so all seven are void once the round is. Kept as the explicit escape hatch so the
 * invariant test has somewhere to point a genuinely cycle-independent future job.
 */
export const RFP_JOB_TYPES_EXEMPT_FROM_CYCLE_RETIREMENT: readonly string[] = [];
