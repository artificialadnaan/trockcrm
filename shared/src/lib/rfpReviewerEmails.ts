/**
 * Single source of truth for the RFP leadership reviewer/recipient set.
 *
 * The RFP-decline email is sent to the requesting rep + the leadership recipients (Takashi + Adam Shaw)
 * configured in the `RFP_REJECTION_EMAIL_RECIPIENTS` env var. Those same leadership recipients are the ONLY
 * users allowed to open the RFP override-review page and approve/re-confirm a declined RFP. Both the worker
 * (who is notified) and the server (who is authorized to review) resolve that set through these helpers, so
 * the notified set and the reviewer set are defined in one config and can never drift apart.
 */

export const DEFAULT_NON_PROD_RFP_REVIEWER = "adnaan.iqbal@gmail.com";

const DEV_FALLBACK_NODE_ENVS = new Set(["development", "test"]);

function isDevFallbackContext(env: NodeJS.ProcessEnv): boolean {
  return typeof env.NODE_ENV === "string" && DEV_FALLBACK_NODE_ENVS.has(env.NODE_ENV);
}

/**
 * Parse a comma-separated email list: trim each entry, drop blanks, and de-duplicate
 * case-insensitively while preserving the first spelling encountered.
 */
export function parseReviewerEmails(raw: string | null | undefined): string[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Resolve the leadership reviewer/recipient emails from `RFP_REJECTION_EMAIL_RECIPIENTS`.
 * In dev/test only, falls back to a single dev address so local runs work. In any other env
 * (including a misconfigured prod) it returns [] so the gate fails closed and the worker fails loudly.
 */
export function resolveRfpReviewerEmails(env: NodeJS.ProcessEnv): string[] {
  const parsed = parseReviewerEmails(env.RFP_REJECTION_EMAIL_RECIPIENTS);
  if (parsed.length > 0) return parsed;
  return isDevFallbackContext(env) ? [DEFAULT_NON_PROD_RFP_REVIEWER] : [];
}

/**
 * True iff `email` is one of the configured leadership reviewers (case-insensitive, trimmed).
 * Used as the authorization boundary for the RFP override-review endpoints.
 */
export function isRfpReviewerEmail(email: string | null | undefined, env: NodeJS.ProcessEnv): boolean {
  if (typeof email !== "string") return false;
  const target = email.trim().toLowerCase();
  if (target.length === 0) return false;
  return resolveRfpReviewerEmails(env).some((reviewer) => reviewer.toLowerCase() === target);
}
