import { describe, expect, it } from "vitest";
import {
  renderBrandedEmail,
  renderDetailRows,
  resolveFrontendUrl,
  TROCK_LOGO_EMAIL_URL,
} from "../../src/lib/branded-email.js";

/**
 * The branded shell is not owned by any one job — it is what the weekly-report reminders, the dead-letter
 * sweep and (shortly) two more notifications all render into. It moved out of a 2100-line job file to make
 * that reuse possible, and a move is exactly when a shell quietly loses a piece: the mso-only VML button
 * and the non-mso `<a>` are two halves of ONE control, and dropping either leaves a button that is
 * invisible in half the inboxes it lands in while every existing job suite stays green.
 *
 * These assert the structure the next mover has to preserve, not the styling, which is expected to churn.
 */

const INPUT = {
  title: "Weekly report due Thursday",
  preheader: "A heads-up: this week's report is due Thursday.",
  bodyHtml: "<p>body</p>",
  primaryLabel: "Open the dashboard",
  primaryUrl: "https://trockcrm.com/projects/weekly-reports",
} as const;

describe("renderBrandedEmail", () => {
  it("renders the hosted T Rock logo", () => {
    const html = renderBrandedEmail(INPUT);
    expect(html).toContain(`src="${TROCK_LOGO_EMAIL_URL}"`);
    expect(html).toContain('alt="T Rock Construction"');
  });

  it("renders the primary CTA twice — the VML button for Outlook and the <a> for everyone else", () => {
    const html = renderBrandedEmail(INPUT);

    // Outlook desktop (Word rendering engine) ignores the styled anchor's background, so the button is
    // drawn as VML inside an mso conditional. It carries its own href.
    const vml = html.match(/<v:roundrect[^>]*href="([^"]+)"/);
    expect(vml?.[1]).toBe(INPUT.primaryUrl);
    expect(html).toContain(`<center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${INPUT.primaryLabel}</center>`);

    // Everyone else gets the anchor, hidden from Outlook by the `[if !mso]` downlevel-revealed comment.
    expect(html).toContain("<!--[if !mso]><!-- -->");
    const anchor = html.match(/<a href="([^"]+)" style="display:inline-block;background-color:#CC0000;[^"]*">([^<]+)<\/a>/);
    expect(anchor?.[1]).toBe(INPUT.primaryUrl);
    expect(anchor?.[2]).toBe(INPUT.primaryLabel);
  });

  it("renders the preheader", () => {
    expect(renderBrandedEmail(INPUT)).toContain(INPUT.preheader);
  });

  it("escapes the caller's copy and the CTA url", () => {
    const html = renderBrandedEmail({
      ...INPUT,
      title: 'Ben & "Jerry" <script>',
      primaryLabel: "A & B",
      primaryUrl: "https://trockcrm.com/deals?q=a&b",
    });
    expect(html).toContain("Ben &amp; &quot;Jerry&quot; &lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("A &amp; B");
    expect(html).toContain("https://trockcrm.com/deals?q=a&amp;b");
  });

  it("omits the secondary link unless both a label and a url are given", () => {
    expect(renderBrandedEmail(INPUT)).not.toContain("text-decoration:underline");

    const both = renderBrandedEmail({ ...INPUT, secondaryLabel: "View in the CRM", secondaryUrl: "https://trockcrm.com/x" });
    expect(both).toContain('<a href="https://trockcrm.com/x"');
    expect(both).toContain("View in the CRM");

    // A label with no url would otherwise render an anchor to nowhere.
    expect(renderBrandedEmail({ ...INPUT, secondaryLabel: "View in the CRM" })).not.toContain("View in the CRM");
  });

  it("drops the caller's bodyHtml in unescaped — it is markup, not copy", () => {
    const html = renderBrandedEmail({ ...INPUT, bodyHtml: renderDetailRows([["Project", "Bell & Oak"]]) });
    expect(html).toContain("Bell &amp; Oak");
    expect(html).toContain("<table role=\"presentation\" width=\"100%\"");
  });
});

describe("renderDetailRows", () => {
  it("escapes both the label and the value", () => {
    const html = renderDetailRows([["Client & Co", "<b>Acme</b>"]]);
    expect(html).toContain("Client &amp; Co");
    expect(html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(html).not.toContain("<b>Acme</b>");
  });

  it("renders one row per pair", () => {
    const html = renderDetailRows([["A", "1"], ["B", "2"], ["C", "3"]]);
    expect(html.match(/<tr>/g)).toHaveLength(3);
  });
});

describe("resolveFrontendUrl", () => {
  it("falls back to the public custom domain when FRONTEND_URL is unset", () => {
    expect(resolveFrontendUrl({} as NodeJS.ProcessEnv)).toBe("https://trockcrm.com");
  });

  it("prefers FRONTEND_URL when it is set", () => {
    expect(resolveFrontendUrl({ FRONTEND_URL: "https://staging.example.com" } as NodeJS.ProcessEnv)).toBe(
      "https://staging.example.com",
    );
  });
});
