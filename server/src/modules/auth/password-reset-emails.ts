/**
 * The two emails in the self-service reset flow.
 *
 * Both are built here rather than inline so the wording is reviewable in one place, and so the sending
 * code stays about delivery. Neither carries any credential except the reset link itself.
 */

// Matches the brand red used by the other transactional templates (field invites, daily summary).
const BRAND_RED = "#CC0000";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function buildPasswordResetEmail(input: {
  displayName: string;
  resetUrl: string;
  ttlMinutes: number;
}): { subject: string; html: string; text: string } {
  const firstName = input.displayName.trim().split(/\s+/)[0] || input.displayName;
  const subject = "Reset your T Rock CRM password";
  // Escaped: display_name comes from the users table and the URL embeds a generated token. Neither is
  // attacker-controlled today, but this is the one email whose body is a credential.
  const safeName = escapeHtml(firstName);
  const safeUrl = escapeHtml(input.resetUrl);
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111827">
      <p>Hi ${safeName},</p>
      <p>Use the button below to set a new T Rock CRM password.</p>
      <p><a href="${safeUrl}" style="display:inline-block;background:${BRAND_RED};color:#ffffff;padding:10px 14px;border-radius:6px;text-decoration:none;font-weight:600">Set a new password</a></p>
      <p>This link works once and expires in ${input.ttlMinutes} minutes.</p>
      <p>If you didn't ask for this, you can ignore this email — your current password still works.</p>
    </div>
  `;
  const text = [
    `Hi ${firstName},`,
    "",
    "Use the link below to set a new T Rock CRM password.",
    input.resetUrl,
    "",
    `This link works once and expires in ${input.ttlMinutes} minutes.`,
    "If you didn't ask for this, you can ignore this email — your current password still works.",
  ].join("\n");
  return { subject, html, text };
}

/**
 * Sent after a successful reset. This is what makes an unauthorized reset VISIBLE rather than silent,
 * so it deliberately contains no token and no action link — there is nothing here worth phishing, and
 * nothing for a recipient to click if they did not expect it.
 */
export function buildPasswordChangedEmail(input: {
  displayName: string;
}): { subject: string; html: string; text: string } {
  const firstName = input.displayName.trim().split(/\s+/)[0] || input.displayName;
  const subject = "Your T Rock CRM password was changed";
  const safeName = escapeHtml(firstName);
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111827">
      <p>Hi ${safeName},</p>
      <p>Your T Rock CRM password was just changed, and you have been signed out everywhere.</p>
      <p>If this wasn't you, contact your administrator immediately.</p>
    </div>
  `;
  const text = [
    `Hi ${firstName},`,
    "",
    "Your T Rock CRM password was just changed, and you have been signed out everywhere.",
    "",
    "If this wasn't you, contact your administrator immediately.",
  ].join("\n");
  return { subject, html, text };
}
