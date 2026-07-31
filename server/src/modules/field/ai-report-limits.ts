/**
 * The two AI-report time bounds that have to agree, in one dependency-free place.
 *
 * They were previously a constant in ai-report-runs.ts and a constant in ai-report-service.ts with a comment
 * in each asking the other to stay in range — which held only as long as nobody edited one of them, and not
 * at all once the deadline became an env override. Keeping them together makes the relationship checkable
 * instead of aspirational, and this module imports nothing so either side can read it without dragging in a
 * database handle.
 */

/**
 * How long a run may sit in queued/running before it is considered abandoned.
 *
 * This exists because of the in-flight unique index: without a way out, a run orphaned by a worker that died
 * mid-flight would occupy that (deal, requester) slot FOREVER and permanently lock the user out of AI
 * reports on that project. Generous on purpose — a 60-photo run that exhausts its retries can legitimately
 * run ~10 minutes — so it only ever fires on a genuinely dead run.
 */
export const STALE_RUN_MINUTES = 20;

/**
 * Hard ceiling on the whole-assessment deadline, including any AI_REPORT_TOTAL_DEADLINE_MS override.
 *
 * The deadline bounds the MODEL phase only; the run also has to load, render and upload around it, and the
 * lease is not renewed until rendering begins. If the deadline were allowed to reach the stale window, a
 * later enqueue by the same user would reap a run whose model call is still consuming tokens, free its
 * quota and unique-index slot, and queue a second paid assessment against the first.
 *
 * The five-minute margin covers the two short transactions either side of the model phase and the handoff
 * into rendering, where the lease is renewed and a fresh window begins.
 */
export const MAX_TOTAL_DEADLINE_MS = (STALE_RUN_MINUTES - 5) * 60 * 1000;
