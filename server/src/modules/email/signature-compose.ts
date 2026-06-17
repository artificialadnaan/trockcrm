import { sanitizeSignatureHtml } from "../../lib/sanitize-signature.js";

// Spacer between the message body and the appended signature.
export const SIGNATURE_SPACER = "<br><br>";

/**
 * Append a (sanitized) signature below the body. Pure + standalone so the inject is unit-testable
 * without importing the heavy email service. Empty/whitespace signature → body unchanged (graceful).
 * The wrapper div is ours (the user's HTML is sanitized first), and we re-sanitize here as
 * defense-in-depth so a non-route-written value can never carry script into outbound mail.
 */
export function composeBodyWithSignature(bodyHtml: string, signatureHtml: string | null | undefined): string {
  const sig = sanitizeSignatureHtml(signatureHtml);
  if (!sig) return bodyHtml;
  return `${bodyHtml}${SIGNATURE_SPACER}<div class="trock-email-signature">${sig}</div>`;
}
