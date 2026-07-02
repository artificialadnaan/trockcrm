/**
 * Recipients for the Field Scorecard submission email.
 *
 * When a superintendent submits a weekly Field Scorecard from T-Rock Cam, the server renders a PDF and the
 * worker emails it to the recipients configured in `FIELD_SCORECARD_EMAIL_RECIPIENTS` (comma-separated).
 * Kept in shared so the worker (who sends) and any future server-side gate resolve the same set from one
 * config. Reuses the RFP list parser so parsing/de-dupe behaviour can't drift between the two features.
 */
import { parseReviewerEmails } from "./rfpReviewerEmails";

export const DEFAULT_NON_PROD_FIELD_SCORECARD_RECIPIENT = "adnaan.iqbal@gmail.com";

const DEV_FALLBACK_NODE_ENVS = new Set(["development", "test"]);

/**
 * Resolve the Field Scorecard email recipients from `FIELD_SCORECARD_EMAIL_RECIPIENTS`.
 * In dev/test only, falls back to a single dev address so local runs work. In any other env (including a
 * misconfigured prod) it returns [] so the send fails loudly — the worker job retries then dead-letters,
 * making the misconfiguration visible instead of silently dropping the notification.
 */
export function resolveFieldScorecardRecipients(env: NodeJS.ProcessEnv): string[] {
  const parsed = parseReviewerEmails(env.FIELD_SCORECARD_EMAIL_RECIPIENTS);
  if (parsed.length > 0) return parsed;
  const isDev = typeof env.NODE_ENV === "string" && DEV_FALLBACK_NODE_ENVS.has(env.NODE_ENV);
  return isDev ? [DEFAULT_NON_PROD_FIELD_SCORECARD_RECIPIENT] : [];
}
