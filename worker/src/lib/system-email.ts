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

export interface SendSystemEmailOptions {
  cc?: string | string[];
  bcc?: string | string[];
  text?: string;
  idempotencyKey?: string;
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
    console.log(`  Body: ${body.substring(0, 200)}...`);
    return { success: true, messageId: null };
  }

  if (recipients.length === 0) {
    console.warn("[Email] No recipients after override - skipping");
    return { success: false, messageId: null };
  }

  const result = await resend.emails.send({
    from: fromAddress(),
    to: recipients,
    subject: subjectLine,
    html: body,
    ...(options.text ? { text: options.text } : {}),
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
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
