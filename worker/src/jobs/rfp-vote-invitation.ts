import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";
import { resolveRfpVoterEmails } from "@trock-crm/shared/lib/rfpVoterEmails";
import { escapeHtml, normalizeText } from "../lib/email-format.js";

export const RFP_VOTE_INVITATION_JOB = "rfp_vote_invitation";

interface RfpVoteInvitationPayload {
  dealId?: string;
  dealNumber?: string | null;
  dealName?: string | null;
  officeId?: string | null;
  roundEventId?: string | null;
}

interface HandlerDeps {
  sendEmail?: (
    to: string | string[],
    subject: string,
    html: string,
    options: { text: string; idempotencyKey: string }
  ) => Promise<SendSystemEmailResult>;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Email the three designated RFP voters (RFP_VOTER_EMAILS = Sidney/Tim/James) a focused /rfp-vote/:dealId
 * link when a non-service RFP vote round opens. Enqueued by openRfpVoteRound -> enqueueRfpVoteInvitation.
 * Fails loudly (throw -> retry -> dead-letter) if RFP_VOTER_EMAILS is unset, mirroring rfp-rejection-email.
 */
export async function handleRfpVoteInvitation(
  payload: RfpVoteInvitationPayload,
  _officeId: string | null,
  deps: HandlerDeps = {},
): Promise<void> {
  const logger = deps.logger ?? console;
  const env = deps.env ?? process.env;
  const dealId = normalizeText(payload.dealId);
  if (!dealId) {
    logger.warn("[RfpVoteInvitation] Invalid job payload (missing dealId) - skipping");
    return;
  }

  const recipients = resolveRfpVoterEmails(env);
  if (recipients.length === 0) {
    const error = new Error("RFP_VOTER_EMAILS is not configured");
    logger.error(
      "[RfpVoteInvitation] RFP_VOTER_EMAILS is not set - cannot send vote invitations. Set it (comma-separated) on the worker service; the job retries then dead-letters.",
      { dealId },
    );
    throw error;
  }

  const officeId = normalizeText(payload.officeId);
  const roundEventId = normalizeText(payload.roundEventId);
  const email = buildRfpVoteInvitationEmail({
    dealId,
    dealName: normalizeText(payload.dealName) ?? "Deal",
    dealNumber: normalizeText(payload.dealNumber),
    officeId,
    frontendUrl: resolveFrontendUrl(env),
  });

  const recipientCount = recipients.length;
  const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
  try {
    const sendResult = await sendEmail(recipients, email.subject, email.html, {
      text: email.text,
      idempotencyKey: `rfp-vote-invite-${dealId}-${roundEventId ?? "noroundid"}`,
    });
    if (!sendResult.success) {
      throw new Error("Email provider returned unsuccessful result");
    }
    logger.log("[RfpVoteInvitation] Sent vote invitations", {
      dealId,
      recipientCount,
      messageId: sendResult.messageId,
    });
  } catch (error) {
    logger.error("[RfpVoteInvitation] Failed to send vote invitations", { dealId, recipientCount, error });
    throw error;
  }
}

export function buildRfpVoteInvitationEmail(input: {
  dealId: string;
  dealName: string;
  dealNumber: string | null;
  officeId?: string | null;
  frontendUrl: string;
}) {
  const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
  const baseUrl = input.frontendUrl.replace(/\/+$/, "");
  const voteUrl = `${baseUrl}/rfp-vote/${encodeURIComponent(input.dealId)}${officeParam}`;
  const safeVoteUrl = escapeHtml(voteUrl);

  const subject = input.dealNumber
    ? `RFP vote needed: ${input.dealNumber} (${input.dealName})`
    : `RFP vote needed: ${input.dealName}`;
  const text = `An RFP needs your vote (approve or reject). Two of three votes decide; a reject needs a written reason. Open ${voteUrl} to cast your vote.`;

  const rows = [
    ["Deal name", input.dealName],
    ["Project number", input.dealNumber ?? "Pending"],
  ] as const;
  const htmlRows = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;vertical-align:top;width:150px;">${escapeHtml(label)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;vertical-align:top;">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join("");

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>RFP Vote Needed</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;">
          <tr><td style="background-color:#CC0000;height:4px;line-height:4px;font-size:4px;mso-line-height-rule:exactly;">&nbsp;</td></tr>
          <tr><td align="center" style="padding:28px 24px 8px 24px;"><img src="${TROCK_LOGO_EMAIL_URL}" alt="T Rock Construction" width="220" height="246" style="display:block;width:220px;height:246px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" /></td></tr>
          <tr><td align="center" style="padding:4px 24px 0 24px;"><h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">RFP Vote Needed</h1></td></tr>
          <tr><td align="center" style="padding:6px 24px 16px 24px;"><p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">You are one of three RFP voters. Approve or reject this RFP — two of three votes decide. A reject requires a written reason.</p></td></tr>
          <tr><td style="padding:0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;">${htmlRows}</table></td></tr>
          <tr><td align="center" style="padding:24px 24px 8px 24px;">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeVoteUrl}" style="height:44px;v-text-anchor:middle;width:240px;" arcsize="9%" stroke="f" fillcolor="#CC0000"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">Cast your vote</center></v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-- -->
            <a href="${safeVoteUrl}" style="display:inline-block;background-color:#CC0000;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:240px;border-radius:4px;">Cast your vote</a>
            <!--<![endif]-->
          </td></tr>
          <tr><td align="center" style="padding:0 24px 24px 24px;"><p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">Votes are final once cast. Live progress is shown on the deal.</p></td></tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html, text, dealNumber: input.dealNumber };
}
