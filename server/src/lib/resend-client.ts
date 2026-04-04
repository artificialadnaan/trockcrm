import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS ?? "crm@trockconstruction.com";

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

  if (!client) {
    console.log("[Email:dev] Would send email:");
    console.log(`  To: ${Array.isArray(to) ? to.join(", ") : to}`);
    console.log(`  From: ${FROM_ADDRESS}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body: ${htmlBody.substring(0, 200)}...`);
    return true;
  }

  try {
    const override = process.env.TEST_EMAIL_OVERRIDE;
    const recipients = override ? [override] : (Array.isArray(to) ? to : [to]);
    const result = await client.emails.send({
      from: FROM_ADDRESS,
      to: recipients,
      subject,
      html: htmlBody,
    });

    if (result.error) {
      console.error("[Email] Resend error:", result.error);
      return false;
    }

    console.log(`[Email] Sent: "${subject}" to ${recipients.join(", ")} (id: ${result.data?.id})`);
    return true;
  } catch (err) {
    console.error("[Email] Failed to send:", err);
    return false;
  }
}
