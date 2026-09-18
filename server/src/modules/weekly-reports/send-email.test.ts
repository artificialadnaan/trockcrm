import { describe, expect, it } from "vitest";
import {
  WEEKLY_REPORT_SEND_LIMITS,
  normalizeWeeklyReportRecipients,
  weeklyReportDefaultContextParagraph,
  weeklyReportEmailBodyText,
  weeklyReportEmailParagraphs,
  weeklyReportEmailSubject,
  weeklyReportGreeting,
  weeklyReportSignatureLines,
  weeklyReportWeekLabel,
} from "@trock-crm/shared/lib/weeklyReportEmail";
import { formatWeeklyReportDate } from "./pdf.js";
import { normalizeWeeklyReportSendPayload } from "./send-service.js";
import { AppError } from "../../middleware/error-handler.js";

// What the client actually receives, asserted on the CONTENT rather than on a call count.
//
// This suite lives in the server package rather than in `shared` for one reason: the anti-drift test below
// needs both the shared week label and the PDF renderer's own date formatter in the same process, and
// `shared` cannot import from the server.

const SENDER = { name: "Adam Sherwood", email: "adam@trockconstruction.com", phone: "(214) 555-0142" };

describe("weeklyReportWeekLabel", () => {
  it("prints the reference report's format", () => {
    expect(weeklyReportWeekLabel("2026-08-13")).toBe("8/13/26");
  });

  it("agrees with the PDF renderer, which prints the same week in the same header", () => {
    // Two implementations of one format is exactly the drift a client notices: the subject line says one
    // week and the document they open says another. Asserted across a year rather than on one date, so a
    // change to either that only diverges at a month or year boundary is caught here.
    const dates = [
      "2026-01-01",
      "2026-02-28",
      "2026-03-01",
      "2026-08-13",
      "2026-09-09",
      "2026-10-31",
      "2026-12-31",
      "2027-01-07",
    ];
    for (const date of dates) {
      expect(weeklyReportWeekLabel(date)).toBe(formatWeeklyReportDate(date));
    }
  });

  it("is timezone-proof — a plain calendar date never slides a day", () => {
    // Parsed at UTC noon, the same technique as shared/types/weekly-report.ts. `new Date(iso)` parses at
    // UTC midnight and reads back local, which prints 8/12/26 for everyone west of Greenwich.
    expect(weeklyReportWeekLabel("2026-08-13T00:00:00Z")).toBe("8/13/26");
    expect(weeklyReportWeekLabel("2026-01-01")).toBe("1/1/26");
  });

  it("returns null rather than a fake label for a value that is not a date", () => {
    expect(weeklyReportWeekLabel(null)).toBeNull();
    expect(weeklyReportWeekLabel("not-a-date")).toBeNull();
  });
});

describe("weeklyReportEmailSubject", () => {
  it("is exactly the line the spec writes", () => {
    expect(weeklyReportEmailSubject({ propertyName: "4123 Cedar Springs", weekOf: "2026-08-13" })).toBe(
      "4123 Cedar Springs — Weekly Progress Report, Week of 8/13/26",
    );
  });

  it("still names the report when the project has no display name", () => {
    expect(weeklyReportEmailSubject({ propertyName: null, weekOf: "2026-08-13" })).toBe(
      "Weekly Progress Report — Weekly Progress Report, Week of 8/13/26",
    );
  });

  it("drops the week rather than printing an unparsed date", () => {
    expect(weeklyReportEmailSubject({ propertyName: "Cedar Springs", weekOf: null })).toBe(
      "Cedar Springs — Weekly Progress Report",
    );
  });
});

describe("weeklyReportGreeting", () => {
  it("uses the FIRST name only", () => {
    expect(weeklyReportGreeting("Jay Stauble")).toBe("Hello Jay,");
  });

  it("falls back to a bare greeting rather than to a role or a company", () => {
    expect(weeklyReportGreeting(null)).toBe("Hello,");
    expect(weeklyReportGreeting("   ")).toBe("Hello,");
  });
});

describe("normalizeWeeklyReportRecipients", () => {
  it("de-duplicates case-insensitively, keeping the first spelling", () => {
    expect(
      normalizeWeeklyReportRecipients(["Jay@Example.com", "jay@example.com", "melissa@example.com"]),
    ).toEqual(["Jay@Example.com", "melissa@example.com"]);
  });

  it("drops anything that is not an address", () => {
    expect(normalizeWeeklyReportRecipients(["jay@example.com", "nonsense", "", null, 7])).toEqual([
      "jay@example.com",
    ]);
  });
});

describe("weeklyReportEmailParagraphs", () => {
  const base = {
    greetingName: "Jay Stauble",
    contextParagraph: "Framing is complete on levels 3 and 4.",
    shareUrl: "https://reports.example.com/wr/abc",
    sender: SENDER,
    isCorrection: false,
  };

  it("orders greeting, message, link, signature — and carries the PM's phone", () => {
    expect(weeklyReportEmailParagraphs(base)).toEqual([
      "Hello Jay,",
      "Framing is complete on levels 3 and 4.",
      "Here's the link to your weekly report: https://reports.example.com/wr/abc",
      "Adam Sherwood\nadam@trockconstruction.com\n(214) 555-0142",
    ]);
  });

  it("tells the client a correction replaces what they have, even if the PM blanks the message", () => {
    // The PM's paragraph is theirs to delete. The revision notice is NOT — a client who is not told this
    // supersedes the earlier copy is left holding two reports for one week with no way to rank them.
    const paragraphs = weeklyReportEmailParagraphs({ ...base, contextParagraph: "", isCorrection: true });
    expect(paragraphs).not.toContain("");
    expect(paragraphs.some((p) => /revised version/i.test(p) && /replaces/i.test(p))).toBe(true);
  });

  it("omits the link sentence entirely rather than printing a dangling colon", () => {
    const paragraphs = weeklyReportEmailParagraphs({ ...base, shareUrl: null });
    expect(paragraphs.some((p) => p.includes("Here's the link"))).toBe(false);
  });

  it("names T-Rock rather than leaving an empty signature when no PM is on file", () => {
    expect(weeklyReportSignatureLines({ name: null, email: null, phone: null })).toEqual([
      "T-Rock Construction",
    ]);
  });

  it("renders the plain-text body as the same paragraphs, blank-line separated", () => {
    expect(weeklyReportEmailBodyText(base)).toBe(weeklyReportEmailParagraphs(base).join("\n\n"));
  });
});

describe("weeklyReportDefaultContextParagraph", () => {
  it("names the property and the week so an untouched default is still specific", () => {
    const text = weeklyReportDefaultContextParagraph({
      propertyName: "4123 Cedar Springs",
      weekOf: "2026-08-13",
      isCorrection: false,
    });
    expect(text).toContain("4123 Cedar Springs");
    expect(text).toContain("8/13/26");
  });

  it("says it replaces the previous version when it is a correction", () => {
    const text = weeklyReportDefaultContextParagraph({
      propertyName: "4123 Cedar Springs",
      weekOf: "2026-08-13",
      isCorrection: true,
    });
    expect(text).toMatch(/replaces the version sent previously/i);
  });
});

describe("normalizeWeeklyReportSendPayload", () => {
  const fallback = { subject: "Fallback subject", contextParagraph: "Fallback message" };

  function expectAppErrorSync(run: () => unknown, status: number, matcher: RegExp) {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    if (caught === undefined) throw new Error(`Expected an AppError ${status}, but the call returned`);
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(status);
    expect((caught as AppError).message).toMatch(matcher);
  }

  it("refuses a send with no recipients rather than queueing an email to nobody", () => {
    expectAppErrorSync(() => normalizeWeeklyReportSendPayload({ recipients: [] }, fallback), 400, /at least one/i);
  });

  it("refuses a payload that is not an array at all", () => {
    expectAppErrorSync(
      () => normalizeWeeklyReportSendPayload({ recipients: "jay@example.com" }, fallback),
      400,
      /must be an array/i,
    );
  });

  it("REJECTS a malformed address instead of silently dropping it", () => {
    // The failure this guards is specific: normalizing would have sent to the two valid addresses and
    // said nothing, so the PM believes three people received the report and the third never did.
    expectAppErrorSync(
      () =>
        normalizeWeeklyReportSendPayload(
          { recipients: ["jay@example.com", "melissa@example.com", "typo-at-example.com"] },
          fallback,
        ),
      400,
      /not a valid email/i,
    );
  });

  it("accepts a duplicate spelling of the same mailbox without calling it invalid", () => {
    const result = normalizeWeeklyReportSendPayload(
      { recipients: ["Jay@example.com", "jay@example.com"] },
      fallback,
    );
    expect(result.recipients).toEqual(["Jay@example.com"]);
  });

  it("refuses more recipients than the cap", () => {
    const many = Array.from(
      { length: WEEKLY_REPORT_SEND_LIMITS.maxRecipients + 1 },
      (_value, index) => `person${index}@example.com`,
    );
    expectAppErrorSync(() => normalizeWeeklyReportSendPayload({ recipients: many }, fallback), 400, /at most/i);
  });

  it("honours a DELIBERATELY empty message but falls back for an absent one", () => {
    expect(
      normalizeWeeklyReportSendPayload(
        { recipients: ["jay@example.com"], contextParagraph: "   " },
        fallback,
      ).contextParagraph,
    ).toBe("");
    expect(
      normalizeWeeklyReportSendPayload({ recipients: ["jay@example.com"] }, fallback).contextParagraph,
    ).toBe("Fallback message");
  });

  it("refuses a message longer than the cap", () => {
    expectAppErrorSync(
      () =>
        normalizeWeeklyReportSendPayload(
          {
            recipients: ["jay@example.com"],
            contextParagraph: "x".repeat(WEEKLY_REPORT_SEND_LIMITS.maxContextChars + 1),
          },
          fallback,
        ),
      400,
      /limited to/i,
    );
  });

  it("defaults the PDF ON and treats anything but an explicit true as off", () => {
    expect(normalizeWeeklyReportSendPayload({ recipients: ["jay@example.com"] }, fallback).attachPdf).toBe(
      true,
    );
    expect(
      normalizeWeeklyReportSendPayload({ recipients: ["jay@example.com"], attachPdf: false }, fallback)
        .attachPdf,
    ).toBe(false);
    expect(
      normalizeWeeklyReportSendPayload({ recipients: ["jay@example.com"], attachPdf: "yes" }, fallback)
        .attachPdf,
    ).toBe(false);
  });
});
