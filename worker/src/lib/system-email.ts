import { Resend } from "resend";

let resendClient: Resend | null = null;
let resendClientApiKey: string | null = null;

function client(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  if (!resendClient || resendClientApiKey !== apiKey) {
    resendClient = new Resend(apiKey);
    resendClientApiKey = apiKey;
  }
  return resendClient;
}

function toArray(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

export interface SendSystemEmailAttachment {
  filename: string;
  content: Buffer;
}

export interface SendSystemEmailOptions {
  cc?: string | string[];
  bcc?: string | string[];
  text?: string;
  idempotencyKey?: string;
  /** File attachments (e.g. a rendered PDF). Passed through to Resend as { filename, content }. */
  attachments?: SendSystemEmailAttachment[];
}

export interface SendSystemEmailResult {
  success: boolean;
  messageId: string | null;
}

export async function sendSystemEmailWithMetadata(
  to: string | string[],
  subject: string,
  htmlBody: string,
  options: SendSystemEmailOptions = {}
): Promise<SendSystemEmailResult> {
  const override = process.env.EMAIL_OVERRIDE_RECIPIENT?.trim();
  const originalTo = toArray(to);
  const originalCc = toArray(options.cc);
  const originalBcc = toArray(options.bcc);
  const recipients = override ? [override] : originalTo;
  const cc = override ? [] : originalCc;
  const bcc = override ? [] : originalBcc;
  const allOriginal = [...originalTo, ...originalCc, ...originalBcc];
  const subjectLine = override ? `[-> ${allOriginal.join(", ")}] ${subject}` : subject;
  const body = override
    ? `<div style="background:#fef3c7;border:1px solid #f59e0b;color:#78350f;padding:12px 16px;margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;border-radius:4px;">
  <strong>DEV MODE:</strong> This email was originally addressed to <code>${escapeHtml(allOriginal.join(", ") || "(no recipients)")}</code>. Override active via <code>EMAIL_OVERRIDE_RECIPIENT</code>.
</div>${htmlBody}`
    : htmlBody;

  const resend = client();
  if (!resend) {
    if (process.env.NODE_ENV === "production") {
      console.error("[Email] RESEND_API_KEY is not configured in production");
      return { success: false, messageId: null };
    }
    console.log("[Email:dev] Would send email:");
    if (override) console.log(`  [override active -> ${recipients.join(", ")}]`);
    console.log(`  To: ${recipients.join(", ")}`);
    if (cc.length) console.log(`  Cc: ${cc.join(", ")}`);
    if (bcc.length) console.log(`  Bcc: ${bcc.join(", ")}`);
    console.log(`  From: ${fromAddress()}`);
    console.log(`  Subject: ${subjectLine}`);
    if (options.attachments?.length) {
      console.log(`  Attachments: ${options.attachments.map((a) => a.filename).join(", ")}`);
    }
    console.log(`  Body: ${body.substring(0, 200)}...`);
    return { success: true, messageId: null };
  }

  if (recipients.length === 0) {
    console.warn("[Email] No recipients after override - skipping");
    return { success: false, messageId: null };
  }

  // Resend's post-encoding attachment limit is ~40MB and base64 inflates raw bytes by ~33%, so warn well
  // before that (Resend still rejects oversized payloads via result.error as the backstop). Makes an
  // oversized scorecard PDF easy to diagnose instead of a bare provider error.
  const attachmentBytes = (options.attachments ?? []).reduce((sum, a) => sum + (a.content?.length ?? 0), 0);
  if (attachmentBytes > 28 * 1024 * 1024) {
    console.warn(
      `[Email] Attachments total ${(attachmentBytes / (1024 * 1024)).toFixed(1)}MB — near Resend's ~40MB post-encoding limit; the send may be rejected.`,
      { subject: subjectLine }
    );
  }

  const result = await resend.emails.send({
    from: fromAddress(),
    to: recipients,
    subject: subjectLine,
    html: body,
    ...(options.text ? { text: options.text } : {}),
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    ...(options.attachments?.length
      ? { attachments: options.attachments.map((a) => ({ filename: a.filename, content: a.content })) }
      : {}),
  }, options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined);

  if (result.error) {
    console.error("[Email] Resend error:", result.error);
    return { success: false, messageId: null };
  }

  const tag = override ? " [override]" : "";
  console.log(`[Email] Sent${tag}: "${subjectLine}" to ${recipients.join(", ")} (id: ${result.data?.id})`);
  return { success: true, messageId: result.data?.id ?? null };
}

function fromAddress(): string {
  return process.env.RESEND_FROM_ADDRESS ?? "crm@trockconstruction.com";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
