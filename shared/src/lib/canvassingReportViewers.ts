/**
 * Single source of truth for who may read the Canvassing Activity report.
 *
 * The report names individuals and counts their output, so it is a performance-management surface: it is
 * meant for the leaders accountable for the canvassing push, not for everyone who happens to hold a role.
 * Readership is therefore an explicit allowlist (`CANVASSING_REPORT_VIEWER_EMAILS`) rather than a role
 * check, which would silently widen to every admin/director provisioned later.
 *
 * Consequences of the allowlist model, stated because they were chosen deliberately:
 *   - it is GLOBAL. A listed address reads the report in any office it can already reach; it does not
 *     widen office scope, which the tenant search_path still enforces.
 *   - it does not let a listed person see anything they could not otherwise reach — the underlying records
 *     are ordinary CRM data. What it withholds is the AGGREGATED per-person scoreboard.
 *   - an unset or empty list means NOBODY can open it. That must fail closed rather than degrade to a role
 *     check, which would hand the scoreboard to the people it was deliberately kept from.
 *
 * Mirrors dailyActivityLogViewers.ts / correctiveActionApprovers.ts and reuses the same parser, so parsing
 * and de-duplication cannot drift between the allowlists.
 */
import { parseReviewerEmails } from "./rfpReviewerEmails.js";

/** Non-personal placeholder for the dev/test fallback; never used in prod (see resolve below). */
export const DEFAULT_NON_PROD_CANVASSING_VIEWER = "canvassing-report-dev@trockconstruction.com";

const DEV_FALLBACK_NODE_ENVS = new Set(["development", "test"]);

/**
 * Resolve the Canvassing Activity viewer emails from `CANVASSING_REPORT_VIEWER_EMAILS`.
 *
 * In dev/test only, falls back to `DEV_CANVASSING_REPORT_VIEWER` or a non-personal placeholder so local
 * runs can exercise the flow. In any other env — including a misconfigured prod — this returns [], and
 * callers must treat that as "nobody may open it" rather than as "anybody may".
 */
export function resolveCanvassingReportViewers(env: NodeJS.ProcessEnv): string[] {
  const parsed = parseReviewerEmails(env.CANVASSING_REPORT_VIEWER_EMAILS);
  if (parsed.length > 0) return parsed;
  const isDev = typeof env.NODE_ENV === "string" && DEV_FALLBACK_NODE_ENVS.has(env.NODE_ENV);
  if (!isDev) return [];
  const devOverride = parseReviewerEmails(env.DEV_CANVASSING_REPORT_VIEWER);
  return devOverride.length > 0 ? devOverride : [DEFAULT_NON_PROD_CANVASSING_VIEWER];
}

/**
 * True iff `email` is one of the configured Canvassing Activity viewers (case-insensitive, trimmed).
 * The authorization boundary for GET /api/reports/canvassing-activity and the `canViewCanvassingReport`
 * session flag the web client uses to hide the card and the page.
 */
export function isCanvassingReportViewerEmail(
  email: string | null | undefined,
  env: NodeJS.ProcessEnv
): boolean {
  if (typeof email !== "string") return false;
  const target = email.trim().toLowerCase();
  if (target.length === 0) return false;
  return resolveCanvassingReportViewers(env).some((viewer) => viewer.toLowerCase() === target);
}
