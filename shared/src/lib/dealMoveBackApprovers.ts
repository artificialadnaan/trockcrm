/**
 * Single source of truth for who may move a deal back to Opportunity.
 *
 * This is the most destructive verb in the deal surface. One call severs a deal from Bid Board sync,
 * resets its RFP cycle, and — when the deal is Won or otherwise carries booked money — VOIDS its
 * commission. None of that is undone by moving the deal forward again: the commission row is gone, the
 * RFP round is retired, and the Bid Board link has to be re-established by hand.
 *
 * So the authority is an explicit allowlist (`DEAL_MOVE_BACK_APPROVER_EMAILS`) rather than a role. Every
 * admin and director can perform ordinary backward stage moves; this one destroys money, and destroying
 * money should be a named person's decision rather than a property of a job title that anyone can be
 * granted later.
 *
 * Consequences of the allowlist model, stated because they were chosen deliberately:
 *   - it only ever NARROWS. The route's requireRole("admin","director") still runs first, and the service
 *     still re-evaluates its own eligibility rules — including the admin-only narrowing when the move
 *     would void commission. Being listed is necessary, not sufficient.
 *   - it is GLOBAL. A listed address may do this in any office they can already reach; it does not widen
 *     office scope, which the tenant search_path still enforces.
 *   - an unset or empty list means NOBODY can do it. That must fail closed. Unlike a report going dark,
 *     nothing is taken away by that: the move is a new capability, so an unset variable means it is simply
 *     not yet available to anyone, and every other path through the deal is untouched.
 *
 * Mirrors correctiveActionApprovers.ts / rfpReviewerEmails.ts and reuses their parser, so parsing and
 * de-duplication cannot drift between the allowlists.
 */
import { parseReviewerEmails } from "./rfpReviewerEmails.js";

/** Non-personal placeholder for the dev/test fallback; never used in prod (see resolve below). */
export const DEFAULT_NON_PROD_DEAL_MOVE_BACK_APPROVER = "move-back-dev@trockconstruction.com";

const DEV_FALLBACK_NODE_ENVS = new Set(["development", "test"]);

/**
 * Resolve the approver emails from `DEAL_MOVE_BACK_APPROVER_EMAILS`.
 *
 * In dev/test only, falls back to `DEV_DEAL_MOVE_BACK_APPROVER` or a non-personal placeholder so local
 * runs can exercise the flow. In any other env — including a misconfigured prod — this returns [], and
 * callers must treat that as "nobody may do this" rather than as "anybody may".
 */
export function resolveDealMoveBackApprovers(env: NodeJS.ProcessEnv): string[] {
  const parsed = parseReviewerEmails(env.DEAL_MOVE_BACK_APPROVER_EMAILS);
  if (parsed.length > 0) return parsed;
  const isDev = typeof env.NODE_ENV === "string" && DEV_FALLBACK_NODE_ENVS.has(env.NODE_ENV);
  if (!isDev) return [];
  const devOverride = parseReviewerEmails(env.DEV_DEAL_MOVE_BACK_APPROVER);
  return devOverride.length > 0 ? devOverride : [DEFAULT_NON_PROD_DEAL_MOVE_BACK_APPROVER];
}

/**
 * True iff `email` may move a deal back to Opportunity (case-insensitive, trimmed).
 *
 * The authorization boundary for both `/deals/:id/return-to-opportunity` and its `/preview`, and for the
 * `canMoveDealBackToOpportunity` session flag the deal menu hides the action on.
 */
export function isDealMoveBackApproverEmail(
  email: string | null | undefined,
  env: NodeJS.ProcessEnv
): boolean {
  if (typeof email !== "string") return false;
  const target = email.trim().toLowerCase();
  if (target.length === 0) return false;
  return resolveDealMoveBackApprovers(env).some((approver) => approver.toLowerCase() === target);
}
