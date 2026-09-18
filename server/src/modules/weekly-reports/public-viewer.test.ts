import { describe, expect, it } from "vitest";
import {
  WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS,
  WEEKLY_REPORT_SECTION_MAX_CHARS,
} from "@trock-crm/shared/types";
import { boundWeeklyReportPhotoCaption, boundWeeklyReportSectionText } from "./pdf.js";
import {
  escapeHtml,
  renderWeeklyReportUnavailableHtml,
  renderWeeklyReportViewerHtml,
} from "./public-viewer.js";
import type { WeeklyReportView } from "./report-view.js";

function view(overrides: Partial<WeeklyReportView["pdf"]> = {}, top: Partial<WeeklyReportView> = {}): WeeklyReportView {
  return {
    pdf: {
      propertyName: "4123 Cedar Springs",
      weekOfLabel: "8/13/26",
      clientName: "Mack Real Estate Group",
      clientTeam: [
        { label: "DOC", name: "Jay Stauble" },
        { label: "PM", name: "Melissa Garcia" },
        { label: "RM", name: null },
        { label: "CM", name: null },
      ],
      trockTeam: [
        { label: "PM", name: "Adam Sherwood" },
        { label: "SUPER", name: "Steve Sanchez" },
      ],
      workCompleted: "- Material delivered for balcony mock up",
      nextWeekLookAhead: "- Complete sample balcony coat",
      issuesConcerns: null,
      schedule: {
        contractDate: "7/8/26",
        projectStartDate: "TBD Permit",
        projectCompletionDate: "TBD Permit",
        completionPercent: "0",
        weatherDelayDays: "0",
      },
      duration: { projectedWeeks: 19, remainingWeeks: 4 },
      photos: [
        {
          fileId: "file-1",
          caption: "Balcony mock-up complete",
          r2Key: "k/1.jpg",
          externalUrl: null,
          externalThumbnailUrl: null,
          mimeType: "image/jpeg",
        },
      ],
      version: 1,
      superseded: false,
      creationDate: new Date("2026-08-13T21:00:00.000Z"),
      ...overrides,
    },
    weekOf: "2026-08-13",
    sentAt: "2026-08-13T21:00:00.000Z",
    status: "sent",
    trockPm: { userId: "pm-1", name: "Adam Sherwood" },
    fromSnapshot: true,
    propertyNameFromDeal: false,
    ...top,
  };
}

function render(overrides: Partial<WeeklyReportView["pdf"]> = {}, top: Partial<WeeklyReportView> = {}, extra: { supersededNotice?: string | null } = {}) {
  return renderWeeklyReportViewerHtml({
    view: view(overrides, top),
    photoUrl: (fileId) => `/wr/tok/photos/${fileId}`,
    pdfUrl: "/wr/tok/pdf",
    ...extra,
  });
}

describe("escapeHtml", () => {
  it("neutralises every character that could break out of an attribute or a text node", () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;",
    );
  });

  it("renders nothing for null and undefined instead of the words", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("the client-facing report page", () => {
  it("prints the header block, the sections and the schedule", () => {
    const html = render();
    expect(html).toContain("Weekly Progress Summary");
    expect(html).toContain("Week of 8/13/26");
    expect(html).toContain("4123 Cedar Springs");
    expect(html).toContain("Mack Real Estate Group");
    expect(html).toContain("Material delivered for balcony mock up");
    expect(html).toContain("Adam Sherwood");
    expect(html).toContain("TBD Permit");
  });

  it("is marked noindex — a forwarded link must not reach a search index", () => {
    expect(render()).toContain('<meta name="robots" content="noindex, nofollow, noarchive">');
  });

  it("prints a section through the SAME bound the PDF uses, so the two cannot disagree", () => {
    // report-view.ts: the page and the attachment are one document seen twice, and a client compares them
    // side by side. The PDF once stopped at 6,000 characters while this page printed everything.
    const long = "z".repeat(WEEKLY_REPORT_SECTION_MAX_CHARS + 500);
    const html = render({ workCompleted: long });
    expect(html).toContain(boundWeeklyReportSectionText(long));
    expect(html).not.toContain(long);
  });

  it("prints a CAPTION through the SAME bound the PDF uses", () => {
    // The half that was missed when the sections were fixed. The API took 500 characters and the picker
    // pre-fills a caption from the file's description, while the PDF drew it into a fixed two-line box
    // with `ellipsis: true` — so a long caption appeared here in full and truncated in the attachment.
    const long = "q".repeat(WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS + 120);
    const html = render({
      photos: [
        {
          fileId: "file-1",
          caption: long,
          r2Key: null,
          externalUrl: null,
          externalThumbnailUrl: null,
          mimeType: null,
        },
      ],
    });
    expect(html).toContain(`<figcaption>${boundWeeklyReportPhotoCaption(long)}</figcaption>`);
    expect(html).not.toContain(long);
    // The alt text is the caption too, and must be bounded with it rather than left as the raw value.
    expect(html).not.toMatch(new RegExp(`alt="q{${WEEKLY_REPORT_PHOTO_CAPTION_MAX_CHARS + 1},}"`));
  });

  it("offers the PDF and loads photos through the token, never from R2 directly", () => {
    const html = render();
    expect(html).toContain('href="/wr/tok/pdf"');
    expect(html).toContain('src="/wr/tok/photos/file-1"');
    // The R2 key embeds the deal number, which this surface deliberately hides.
    expect(html).not.toContain("k/1.jpg");
  });

  it("escapes a caption that contains markup", () => {
    const html = render({
      photos: [
        {
          fileId: "f",
          caption: `<img src=x onerror="alert(1)">`,
          r2Key: null,
          externalUrl: null,
          externalThumbnailUrl: null,
          mimeType: null,
        },
      ],
    });
    // The angle brackets and quotes are what make it executable; assert the live form is gone and the inert
    // one is present. (A bare `not.toContain("onerror=")` would fail on the ESCAPED text and prove nothing.)
    expect(html).not.toContain(`<img src=x onerror="alert(1)">`);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("escapes a property name that contains markup", () => {
    const html = render({ propertyName: "<b>Cedar</b>" });
    expect(html).not.toContain("<b>Cedar</b>");
    expect(html).toContain("&lt;b&gt;Cedar&lt;/b&gt;");
  });

  it("says so when nothing was reported, rather than showing an empty card", () => {
    expect(render({ issuesConcerns: null })).toContain("Nothing reported this week.");
  });

  it("omits the unfilled client-team roles instead of printing four blanks", () => {
    const html = render();
    expect(html).toContain("Jay Stauble");
    // RM and CM are routinely unstaffed; four empty rows read as missing data rather than as a small team.
    expect(html).not.toMatch(/<span class="k">RM<\/span>/);
  });

  it("tells a reader on an old link that a newer version exists", () => {
    // The original link keeps resolving — a client who bookmarked it must never hit a 404 — but it must not
    // present superseded content as current either.
    const html = render({}, {}, { supersededNotice: "A newer version of this report has since been issued." });
    expect(html).toContain("A newer version of this report has since been issued.");
  });

  it("labels a correction as a revision", () => {
    expect(render({ version: 2 })).toContain("revision 2");
  });

  it("scales the remaining bar against the projected duration", () => {
    expect(render({ duration: { projectedWeeks: 20, remainingWeeks: 5 } })).toContain("width:25%");
  });

  it("draws a FULL remaining bar when there is no projected duration to scale against", () => {
    // A short bar would read as "nearly finished" when the honest answer is "we do not know".
    const html = render({ duration: { projectedWeeks: null, remainingWeeks: null } });
    expect(html).toContain('class="bar remaining" style="width:100%"');
  });

  it("renders without photos rather than an empty grid", () => {
    const html = render({ photos: [] });
    expect(html).not.toContain("Weekly Progress Photos");
  });
});

describe("the dead-link page", () => {
  it("names the T-Rock PM and their email, which is the whole point of it", () => {
    const html = renderWeeklyReportUnavailableHtml({
      reason: "expired",
      contact: { name: "Adam Sherwood", email: "adam@example.com" },
      propertyName: "4123 Cedar Springs",
    });
    expect(html).toContain("This report link has expired");
    expect(html).toContain("Adam Sherwood");
    expect(html).toContain('href="mailto:adam@example.com"');
    expect(html).toContain("4123 Cedar Springs");
  });

  it("distinguishes revoked from expired, because the reasons differ", () => {
    const revoked = renderWeeklyReportUnavailableHtml({ reason: "revoked", contact: null });
    expect(revoked).toContain("no longer active");
    expect(revoked).toContain("corrected version");
  });

  it("invents no support address when the token resolved to nothing", () => {
    const html = renderWeeklyReportUnavailableHtml({ reason: "unknown", contact: null });
    expect(html).toContain("couldn’t find that report link");
    expect(html).toContain("reply to the email this link came from");
    expect(html).not.toContain("mailto:");
  });

  it("names the PM even without an email for them", () => {
    const html = renderWeeklyReportUnavailableHtml({ reason: "expired", contact: { name: "Adam Sherwood", email: null } });
    expect(html).toContain("Adam Sherwood");
    expect(html).not.toContain("mailto:");
  });

  it("tells a client whose report was pulled back that their link still works", () => {
    // Distinct from expired/revoked: nothing is wrong with the link, the report moved. Deliberately vague
    // about why — "your superintendent is rewriting it" is an internal detail.
    const html = renderWeeklyReportUnavailableHtml({ reason: "withdrawn", contact: null });
    expect(html).toContain("being updated");
    // The apostrophe is escaped on the way out, like every other interpolated character.
    expect(html).toContain("pulled this week&#39;s report back for revision");
  });

  it("distinguishes our outage from a link that does not exist", () => {
    // Telling somebody holding a good link that it does not exist sends them chasing a replacement that
    // will behave exactly the same way.
    const html = renderWeeklyReportUnavailableHtml({ reason: "unavailable", contact: null });
    expect(html).toContain("can’t load this report right now");
    expect(html).toContain("Your link is fine");
  });

  it("is a page, not a stack trace, and is also noindex", () => {
    const html = renderWeeklyReportUnavailableHtml({ reason: "unknown", contact: null });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('content="noindex, nofollow, noarchive"');
  });

  it("escapes a contact name that contains markup", () => {
    const html = renderWeeklyReportUnavailableHtml({
      reason: "expired",
      contact: { name: "<b>PM</b>", email: "a@b.com" },
    });
    expect(html).not.toContain("<b>PM</b>");
  });
});
