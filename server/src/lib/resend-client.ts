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

export interface SendEmailOptions {
  cc?: string | string[];
  bcc?: string | string[];
  text?: string;
  /** Credential-bearing messages must not be copied to the global monitoring mailbox. */
  suppressGlobalBcc?: boolean;
  /** Fail closed instead of treating a missing mail transport as a successful dev send. */
  requireConfiguredTransport?: boolean;
}

export interface SendEmailResult {
  success: boolean;
  messageId: string | null;
}

interface OverrideResult {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  htmlBody: string;
  active: boolean;
}

function toArray(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

/**
 * Addresses to bcc on EVERY system email (SYSTEM_EMAIL_BCC, comma-separated) — a delivery-PRESERVING monitor
 * copy, unlike the EMAIL_OVERRIDE_RECIPIENT redirect. Empty/whitespace entries are dropped.
 */
function resolveGlobalBcc(): string[] {
  return (process.env.SYSTEM_EMAIL_BCC ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Apply EMAIL_OVERRIDE_RECIPIENT if set: route all mail to one address,
 * prefix subject with original recipients, prepend dev banner to body.
 *
 * Applies in BOTH dev (no API key) and production paths so the override is
 * universal — any new email feature inherits it automatically.
 */
function applyOverride(
  to: string | string[],
  subject: string,
  htmlBody: string,
  options: SendEmailOptions
): OverrideResult {
  const originalTo = toArray(to);
  const originalCc = toArray(options.cc);
  const originalBcc = toArray(options.bcc);

  const override = process.env.EMAIL_OVERRIDE_RECIPIENT?.trim();
  if (!override) {
    // Global monitoring bcc: deliver to the REAL recipients AND bcc SYSTEM_EMAIL_BCC on every system email.
    // Skipped only when EMAIL_OVERRIDE_RECIPIENT is active (that already reroutes everything to one address).
    // De-duped case-insensitively against the visible recipients AND within the resolved list itself, so a repeated
    // address (e.g. "a@x" + "A@x") is bcc'd once. This server path passes no Resend idempotencyKey, so there is no
    // keyed-retry concern here — the worker sender handles that with an idempotency-conflict-as-delivered fallback.
    const seen = new Set([...originalTo, ...originalCc, ...originalBcc].map((address) => address.toLowerCase()));
    const globalBcc: string[] = [];
    if (!options.suppressGlobalBcc) {
      for (const address of resolveGlobalBcc()) {
        const key = address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        globalBcc.push(address);
      }
    }
    return {
      to: originalTo,
      cc: originalCc,
      bcc: [...originalBcc, ...globalBcc],
      subject,
      htmlBody,
      active: false,
    };
  }

  const allOriginal = [...originalTo, ...originalCc, ...originalBcc];
  const subjectPrefix = `[→ ${allOriginal.join(", ")}] `;
  const banner = `<div style="background:#fef3c7;border:1px solid #f59e0b;color:#78350f;padding:12px 16px;margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;border-radius:4px;">
  <strong>DEV MODE:</strong> This email was originally addressed to <code>${allOriginal.join(", ") || "(no recipients)"}</code>. Override active via <code>EMAIL_OVERRIDE_RECIPIENT</code>.
</div>`;

  return {
    to: [override],
    cc: [],
    bcc: [],
    subject: subjectPrefix + subject,
    htmlBody: banner + htmlBody,
    active: true,
  };
}

/**
 * Send a system email via Resend.
 *
 * In dev mode (no RESEND_API_KEY), logs the email to console instead of sending.
 * If EMAIL_OVERRIDE_RECIPIENT is set, all mail is rerouted to that address with
 * a subject prefix and body banner showing the original recipients.
 *
 * Returns true if the email was sent (or logged) successfully.
 */
export async function sendSystemEmail(
  to: string | string[],
  subject: string,
  htmlBody: string,
  options: SendEmailOptions = {}
): Promise<boolean> {
  const result = await sendSystemEmailWithMetadata(to, subject, htmlBody, options);
  return result.success;
}

export async function sendSystemEmailWithMetadata(
  to: string | string[],
  subject: string,
  htmlBody: string,
  options: SendEmailOptions = {}
): Promise<SendEmailResult> {
  const overridden = applyOverride(to, subject, htmlBody, options);
  const client = getClient();

  if (!client) {
    if (options.requireConfiguredTransport) {
      console.error("[Email] Required email transport is not configured");
      return { success: false, messageId: null };
    }
    console.log("[Email:dev] Would send email:");
    if (overridden.active) {
      console.log(`  [override active → ${overridden.to.join(", ")}]`);
    }
    console.log(`  To: ${overridden.to.join(", ")}`);
    if (overridden.cc.length) console.log(`  Cc: ${overridden.cc.join(", ")}`);
    if (overridden.bcc.length) console.log(`  Bcc: ${overridden.bcc.join(", ")}`);
    console.log(`  From: ${FROM_ADDRESS}`);
    console.log(`  Subject: ${overridden.subject}`);
    console.log(`  Body: ${overridden.htmlBody.substring(0, 200)}...`);
    return { success: true, messageId: null };
  }

  if (overridden.to.length === 0) {
    console.warn("[Email] No recipients after override — skipping");
    return { success: false, messageId: null };
  }

  try {
    const result = await client.emails.send({
      from: FROM_ADDRESS,
      to: overridden.to,
      subject: overridden.subject,
      html: overridden.htmlBody,
      ...(options.text ? { text: options.text } : {}),
      ...(overridden.cc.length ? { cc: overridden.cc } : {}),
      ...(overridden.bcc.length ? { bcc: overridden.bcc } : {}),
    });

    if (result.error) {
      console.error("[Email] Resend error:", result.error);
      return { success: false, messageId: null };
    }

    const tag = overridden.active ? " [override]" : "";
    console.log(`[Email] Sent${tag}: "${overridden.subject}" to ${overridden.to.join(", ")} (id: ${result.data?.id})`);
    return { success: true, messageId: result.data?.id ?? null };
  } catch (err) {
    console.error("[Email] Failed to send:", err);
    return { success: false, messageId: null };
  }
}
