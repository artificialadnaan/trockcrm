/**
 * Single source of truth for who may read the Daily Activity Log report.
 *
 * The Daily Activity Log is the readable day-by-day record of what reps logged — notes, calls, and (for
 * admin/director) the CONTENT of synced emails. That last part makes it the most privacy-sensitive report
 * surface in the CRM, so who may open it is an explicit allowlist (`DAILY_ACTIVITY_LOG_VIEWER_EMAILS`),
 * not a role: it is a named handful of leaders, and a role check would silently widen it to every future
 * admin/director/rep the moment one is provisioned.
 *
 * Consequences of the allowlist model, stated because they were chosen deliberately:
 *   - it is GLOBAL. An email on this list reads the log in every office they can already reach; it does NOT
 *     widen office scope, which is still enforced by the tenant search_path and the in-service scoping.
 *   - role still applies UNDERNEATH it. The list can only narrow, never widen: a rep on the list is still
 *     row-scoped to their own entries, and email CONTENT still requires the admin/director baseRole check
 *     inside the service. Being listed is necessary, not sufficient.
 *   - an unset or empty list means NOBODY can open the report. That must fail closed — never degrade to the
 *     old role check, which would quietly restore the access this list exists to withhold.
 *
 * Mirrors correctiveActionApprovers.ts / rfpReviewerEmails.ts and reuses their parser so parsing and
 * de-duplication behaviour cannot drift between the allowlists.
 */
import { parseReviewerEmails } from "./rfpReviewerEmails.js";

/** Non-personal placeholder for the dev/test fallback; never used in prod (see resolve below). */
export const DEFAULT_NON_PROD_DAILY_ACTIVITY_LOG_VIEWER = "activity-log-dev@trockconstruction.com";

const DEV_FALLBACK_NODE_ENVS = new Set(["development", "test"]);

/**
 * Resolve the Daily Activity Log viewer emails from `DAILY_ACTIVITY_LOG_VIEWER_EMAILS`.
 *
 * In dev/test only, falls back to `DEV_DAILY_ACTIVITY_LOG_VIEWER` if set, otherwise to a non-personal
 * placeholder address. Note what that placeholder means in practice: it belongs to nobody, so an
 * unconfigured local environment denies EVERY developer. That is intentional — the alternative is a
 * fallback that opens the report to whoever is signed in locally, which would make the gate untestable by
 * hand and invite a "works on my machine" that never had the gate on. To use it locally, set
 * DEV_DAILY_ACTIVITY_LOG_VIEWER to your own address.
 *
 * In any other env — including a misconfigured prod — this returns [], and callers must treat that as
 * "nobody may open it" rather than as "anybody may".
 */
export function resolveDailyActivityLogViewers(env: NodeJS.ProcessEnv): string[] {
  const parsed = parseReviewerEmails(env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS);
  if (parsed.length > 0) return parsed;
  const isDev = typeof env.NODE_ENV === "string" && DEV_FALLBACK_NODE_ENVS.has(env.NODE_ENV);
  if (!isDev) return [];
  const devOverride = parseReviewerEmails(env.DEV_DAILY_ACTIVITY_LOG_VIEWER);
  return devOverride.length > 0 ? devOverride : [DEFAULT_NON_PROD_DAILY_ACTIVITY_LOG_VIEWER];
}

/**
 * True iff `email` is one of the configured Daily Activity Log viewers (case-insensitive, trimmed).
 * Used as the authorization boundary for GET /api/reports/daily-activity-log and for the `canViewDailyActivityLog`
 * session flag that hides the report card and route in the web client.
 */
export function isDailyActivityLogViewerEmail(
  email: string | null | undefined,
  env: NodeJS.ProcessEnv
): boolean {
  if (typeof email !== "string") return false;
  const target = email.trim().toLowerCase();
  if (target.length === 0) return false;
  return resolveDailyActivityLogViewers(env).some((viewer) => viewer.toLowerCase() === target);
}
