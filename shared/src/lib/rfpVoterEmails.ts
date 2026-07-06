/**
 * Single source of truth for the RFP voting trio (non-service deals: Sidney, Tim, James).
 *
 * Non-service RFPs are decided by a 3-person 2-of-3 vote in the CRM. Both the server (which authorizes
 * casting a vote and gates the vote UI) and the worker (which emails the invitations) resolve that set
 * through these helpers, so the invited set and the eligible-voter set are defined in one config and can
 * never drift apart. Mirrors rfpReviewerEmails.ts (RFP override reviewers) with its own env var.
 */

// Generic, non-deliverable example address (not a real personal inbox) so a dev/test run with RFP_VOTER_EMAILS
// unset can't accidentally email a real person. Real dev testing sets RFP_VOTER_EMAILS explicitly.
export const DEFAULT_NON_PROD_RFP_VOTER = "rfp-voter@example.com";

const DEV_FALLBACK_NODE_ENVS = new Set(["development", "test"]);

function isDevFallbackContext(env: NodeJS.ProcessEnv): boolean {
  return typeof env.NODE_ENV === "string" && DEV_FALLBACK_NODE_ENVS.has(env.NODE_ENV);
}

/**
 * Parse a comma-separated email list: trim each entry, drop blanks, and de-duplicate
 * case-insensitively while preserving the first spelling encountered.
 */
export function parseVoterEmails(raw: string | null | undefined): string[] {
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
 * Resolve the RFP voter emails from `RFP_VOTER_EMAILS`. In dev/test only, falls back to a single dev
 * address so local runs work. In any other env (including a misconfigured prod) it returns [] so the
 * gate fails closed and the worker fails loudly.
 */
export function resolveRfpVoterEmails(env: NodeJS.ProcessEnv): string[] {
  const parsed = parseVoterEmails(env.RFP_VOTER_EMAILS);
  if (parsed.length > 0) return parsed;
  return isDevFallbackContext(env) ? [DEFAULT_NON_PROD_RFP_VOTER] : [];
}

/**
 * True iff `email` is one of the configured RFP voters (case-insensitive, trimmed).
 * Used as the authorization boundary for the RFP vote endpoint + the vote UI flag.
 */
export function isRfpVoterEmail(email: string | null | undefined, env: NodeJS.ProcessEnv): boolean {
  if (typeof email !== "string") return false;
  const target = email.trim().toLowerCase();
  if (target.length === 0) return false;
  return resolveRfpVoterEmails(env).some((voter) => voter.toLowerCase() === target);
}
