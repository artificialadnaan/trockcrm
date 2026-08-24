import { escapeHtml, normalizeText } from "./email-format.js";

/**
 * The branded shell every system email is drawn in: red rule, hosted logo, title, preheader, caller body,
 * one primary call-to-action, an optional secondary link, and the do-not-reply footer.
 *
 * It lives in `lib/` rather than in the job that first needed it because it is not that job's — the weekly
 * report reminders, the dead-letter sweep and the notifications queued behind this refactor all render the
 * same shell, and a job importing another job to get at it is how `lib/` and `jobs/` stop being layers.
 * Nothing in `lib/` imports from `jobs/`; keep it that way.
 *
 * The frontend URL and the logo URL come along for the same reason. Every branded email resolves both, and
 * they used to be re-exported from a job file purely because that is where they happened to be written.
 */

// Production CRM frontend. trockcrm.com is the public custom domain on the Frontend service
// (the railway-generated crm.trockconstruction.com is NOT the address operators use). FRONTEND_URL
// overrides this when set; the worker leaves it unset, so this default is what every link renders.
export const DEFAULT_FRONTEND_URL = "https://trockcrm.com";

// Hosted in client/public/ → served by the Frontend service at the domain root (e.g. serve dist -s,
// same as /logo.png and /favicon.png). White-background PNG so it renders predictably on Outlook chrome.
export const TROCK_LOGO_EMAIL_URL = "https://trockcrm.com/trock-logo-email.png";

export function resolveFrontendUrl(env: NodeJS.ProcessEnv): string {
  return normalizeText(env.FRONTEND_URL) ?? DEFAULT_FRONTEND_URL;
}

export interface BrandedEmailInput {
  title: string;
  preheader: string;
  bodyHtml: string;
  primaryLabel: string;
  primaryUrl: string;
  secondaryLabel?: string;
  secondaryUrl?: string;
}

/**
 * Shared rather than hand-copied per notification. A copied shell is one more place the brand has to be
 * changed twice, and two emails about the same feature arriving in the same inbox looking subtly different
 * is how a recipient starts wondering which of them is the real one.
 *
 * The primary button is rendered TWICE on purpose: Outlook desktop drops the anchor's background, so the
 * mso conditional draws it as VML and the downlevel-revealed `[if !mso]` comment hides the anchor from it.
 * Removing either half leaves a button that is invisible in half the inboxes it reaches.
 */
export function renderBrandedEmail(input: BrandedEmailInput): string {
  const primaryUrl = escapeHtml(input.primaryUrl);
  const secondary =
    input.secondaryUrl && input.secondaryLabel
      ? `
          <tr>
            <td align="center" style="padding:0 24px 24px 24px;">
              <a href="${escapeHtml(input.secondaryUrl)}" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#64748b;text-decoration:underline;">${escapeHtml(input.secondaryLabel)}</a>
            </td>
          </tr>`
      : "";

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${escapeHtml(input.title)}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;">
          <tr>
            <td style="background-color:#CC0000;height:4px;line-height:4px;font-size:4px;mso-line-height-rule:exactly;">&nbsp;</td>
          </tr>
          <tr>
            <td align="center" style="padding:28px 24px 8px 24px;background-color:#ffffff;">
              <img src="${TROCK_LOGO_EMAIL_URL}" alt="T Rock Construction" width="220" height="246" style="display:block;width:220px;height:246px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:4px 24px 0 24px;">
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#111111;font-weight:bold;">${escapeHtml(input.title)}</h1>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:6px 24px 16px 24px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#64748b;">${escapeHtml(input.preheader)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px;">${input.bodyHtml}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 24px 12px 24px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${primaryUrl}" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="9%" stroke="f" fillcolor="#CC0000">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${escapeHtml(input.primaryLabel)}</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-- -->
              <a href="${primaryUrl}" style="display:inline-block;background-color:#CC0000;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:260px;border-radius:4px;">${escapeHtml(input.primaryLabel)}</a>
              <!--<![endif]-->
            </td>
          </tr>${secondary}
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e2e8f0;background-color:#fafafa;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">This is an automated notification from T Rock Construction CRM. Please do not reply to this email.</p>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Lives alongside `renderBrandedEmail`, and for the same reason — every one of these emails renders it. */
export function renderDetailRows(rows: ReadonlyArray<readonly [string, string]>): string {
  const cells = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;vertical-align:top;width:150px;">${escapeHtml(label)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;font-weight:bold;vertical-align:top;">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join("");
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;">${cells}
              </table>`;
}
