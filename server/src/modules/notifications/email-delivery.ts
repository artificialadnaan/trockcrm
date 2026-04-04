import { sendSystemEmail } from "../../lib/resend-client.js";

/** Notification types that should trigger an email delivery */
const CRITICAL_NOTIFICATION_TYPES = new Set([
  "stale_deal",
  "activity_drop",
  "approval_needed",
  "inbound_email",
]);

export const SYSTEM_NOTIFICATION_EMAIL_OVERRIDE_ADDRESS = "adnaan.iqbal@gmail.com";
export const systemNotificationEmailOverrideAddress =
  process.env.SYSTEM_NOTIFICATION_EMAIL_OVERRIDE_ADDRESS?.trim() ||
  SYSTEM_NOTIFICATION_EMAIL_OVERRIDE_ADDRESS;

export type NotificationEmailClassification = "critical_system_notification" | "non_system_notification";

/**
 * Check if a notification type is critical and warrants email delivery.
 */
export function isCriticalNotificationType(type: string): boolean {
  return CRITICAL_NOTIFICATION_TYPES.has(type);
}

/**
 * Classify a notification email so routing can apply only to explicit system notifications.
 */
export function classifyNotificationEmail(type: string): NotificationEmailClassification {
  return isCriticalNotificationType(type) ? "critical_system_notification" : "non_system_notification";
}

/**
 * Check whether a classified notification email should be routed to the shared override inbox.
 */
export function isEligibleForSystemEmailOverride(
  classification: NotificationEmailClassification
): boolean {
  return classification === "critical_system_notification";
}

/**
 * Resolve the actual recipient for a classified system notification email.
 */
export function resolveNotificationEmailRecipient(
  recipientEmail: string,
  classification: NotificationEmailClassification
): string {
  return isEligibleForSystemEmailOverride(classification)
    ? systemNotificationEmailOverrideAddress
    : recipientEmail;
}

/**
 * Format a notification into an HTML email and send it via Resend.
 *
 * Called by the notification service after creating a notification,
 * if the notification type is critical.
 */
export async function sendNotificationEmail(
  notification: {
    type: string;
    title: string;
    body?: string | null;
    link?: string | null;
  },
  recipientEmail: string
): Promise<boolean> {
  if (!recipientEmail) {
    console.warn("[EmailDelivery] No recipient email — skipping");
    return false;
  }

  const classification = classifyNotificationEmail(notification.type);
  if (!isEligibleForSystemEmailOverride(classification)) {
    console.warn("[EmailDelivery] Notification is not eligible for system email delivery — skipping");
    return false;
  }

  const subject = notification.title;
  const htmlBody = formatNotificationHtml(notification);
  const routedRecipient = resolveNotificationEmailRecipient(recipientEmail, classification);

  return sendSystemEmail(routedRecipient, subject, htmlBody);
}

/**
 * Format a notification into a branded HTML email body.
 */
function formatNotificationHtml(notification: {
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
}): string {
  const typeLabel = notification.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const baseUrl = process.env.FRONTEND_URL ?? "https://crm.trockconstruction.com";
  const linkUrl = notification.link ? `${baseUrl}${notification.link}` : null;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5; padding:24px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background-color:#1e293b; padding:20px 24px;">
              <span style="color:#ffffff; font-size:18px; font-weight:bold;">T Rock CRM</span>
              <span style="color:#94a3b8; font-size:14px; float:right; line-height:24px;">${typeLabel}</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:24px;">
              <h2 style="margin:0 0 12px; color:#1e293b; font-size:18px;">${escapeHtml(notification.title)}</h2>
              ${notification.body ? `<p style="margin:0 0 16px; color:#475569; font-size:14px; line-height:1.6;">${escapeHtml(notification.body)}</p>` : ""}
              ${linkUrl ? `<a href="${linkUrl}" style="display:inline-block; background-color:#2563eb; color:#ffffff; padding:10px 20px; border-radius:6px; text-decoration:none; font-size:14px; font-weight:500;">View in CRM</a>` : ""}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:16px 24px; border-top:1px solid #e2e8f0; color:#94a3b8; font-size:12px;">
              This is an automated notification from T Rock CRM. Do not reply to this email.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
