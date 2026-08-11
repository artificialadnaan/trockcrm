/**
 * Single source of truth for who may APPROVE or REJECT a corrective-action response.
 *
 * A super/PM submission no longer closes a corrective action — it goes to an approver, who accepts the work
 * or sends it back with comments. That authority is an explicit allowlist (`QC_APPROVER_EMAILS`), not a role:
 * the decision is a named person's to make, and adding a role would silently widen it to everyone holding it.
 *
 * Both the server (who authorizes the verb) and the worker (who addresses the "awaiting your approval"
 * email) resolve the set through here, so the notified set and the authorized set cannot drift apart — the
 * same reason resolveRfpReviewerEmails exists for the RFP override flow.
 *
 * Consequences of the allowlist model, stated because they were chosen deliberately:
 *   - it is GLOBAL. An email on this list can approve on every deal, in every office.
 *   - there is NO fallback approver and no escalation. If the approver is unavailable, corrective actions sit
 *     awaiting approval until the env var is edited.
 *   - an unset or empty list means NOBODY can approve. That must fail closed — never degrade to a role check,
 *     which would quietly grant the authority the allowlist exists to withhold.
 */
import { parseReviewerEmails } from "./rfpReviewerEmails.js";

/** Non-personal placeholder for the dev/test fallback; never used in prod (see resolve below). */
export const DEFAULT_NON_PROD_QC_APPROVER = "qc-approver-dev@trockconstruction.com";

const DEV_FALLBACK_NODE_ENVS = new Set(["development", "test"]);

/**
 * Resolve the corrective-action approver emails from `QC_APPROVER_EMAILS`.
 *
 * In dev/test only, falls back to a single placeholder so local runs can exercise the flow. In any other env
 * — including a misconfigured prod — this returns [], and callers must treat that as "nobody can approve"
 * rather than as "anybody can".
 */
export function resolveCorrectiveActionApprovers(env: NodeJS.ProcessEnv): string[] {
  const parsed = parseReviewerEmails(env.QC_APPROVER_EMAILS);
  if (parsed.length > 0) return parsed;
  const isDev = typeof env.NODE_ENV === "string" && DEV_FALLBACK_NODE_ENVS.has(env.NODE_ENV);
  if (!isDev) return [];
  const devOverride = parseReviewerEmails(env.DEV_QC_APPROVER_EMAIL);
  return devOverride.length > 0 ? devOverride.slice(0, 1) : [DEFAULT_NON_PROD_QC_APPROVER];
}

/**
 * Whether a signed-in user may approve/reject. Case-insensitive, whitespace-tolerant.
 *
 * Deliberately takes the resolved list rather than the env, so a caller cannot accidentally authorize
 * against a different source than the one that addressed the email.
 */
export function isCorrectiveActionApprover(
  email: string | null | undefined,
  approvers: string[],
): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  return approvers.some((approver) => approver.trim().toLowerCase() === normalized);
}
