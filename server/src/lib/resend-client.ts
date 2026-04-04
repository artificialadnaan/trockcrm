import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS ?? "crm@trockconstruction.com";
export const SYSTEM_EMAIL_OVERRIDE_ADDRESS =
  process.env.SYSTEM_EMAIL_OVERRIDE_ADDRESS?.trim() || "adnaan.iqbal@gmail.com";

let resendClient: Resend | null = null;

function getClient(): Resend | null {
  if (!RESEND_API_KEY) {
    return null;
  }
  if (!resendClient) {
    resendClient = new Resend(RESEND_API_KEY);
  }
  return resendClient;
}

/**
 * Resolve the actual recipient for a system email.
 *
 * This intentionally ignores the caller-supplied recipient list so system
 * notification mail always lands in the shared override inbox.
 */
export function resolveSystemEmailRecipient(_to: string | string[]): string {
  return SYSTEM_EMAIL_OVERRIDE_ADDRESS;
}

/**
 * Send a system email via Resend.
 *
 * In dev mode (no RESEND_API_KEY), logs the email to console instead of sending.
 * Returns true if the email was sent (or logged) successfully.
 */
export async function sendSystemEmail(
  to: string | string[],
  subject: string,
  htmlBody: string
): Promise<boolean> {
  const client = getClient();
  const recipient = resolveSystemEmailRecipient(to);

  if (!client) {
    console.log("[Email:dev] Would send email:");
    console.log(`  To: ${recipient}`);
    console.log(`  From: ${FROM_ADDRESS}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body: ${htmlBody.substring(0, 200)}...`);
    return true;
  }

  try {
    const result = await client.emails.send({
      from: FROM_ADDRESS,
      to: [recipient],
      subject,
      html: htmlBody,
    });

    if (result.error) {
      console.error("[Email] Resend error:", result.error);
      return false;
    }

    console.log(`[Email] Sent: "${subject}" to ${recipient} (id: ${result.data?.id})`);
    return true;
  } catch (err) {
    console.error("[Email] Failed to send:", err);
    return false;
  }
}
