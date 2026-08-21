// The classifier that decides whether an access log is evidence or noise.
//
// The fixtures below are the real shape of the problem: a commercial client's mail security fetches the
// link within seconds of delivery, and the person reads it hours later. Getting that backwards in either
// direction is a specific harm — reporting a scanner as the client is how the whole trail loses
// credibility in a dispute, and reporting a person as a scanner is how somebody concludes "they never
// looked" when they did.

import { describe, expect, it } from "vitest";
import {
  looksLikeScannerAgent,
  summariseWeeklyReportViews,
  weeklyReportWasOpenedByAPerson,
  WEEKLY_REPORT_SCANNER_WINDOW_SECONDS,
  type WeeklyReportViewEvent,
} from "./weeklyReportViews.js";

const SENT_AT = "2026-08-13T14:00:00.000Z";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";
const PROOFPOINT = "Mozilla/5.0 (compatible; ProofpointURLDefense/1.0)";

function event(over: Partial<WeeklyReportViewEvent> & { occurredAt: string }): WeeklyReportViewEvent {
  return { eventType: "page", ip: "73.162.44.219", userAgent: CHROME, ...over };
}

describe("telling a person from their mail server", () => {
  it("calls the scan that lands seconds after the send a scanner", () => {
    const sessions = summariseWeeklyReportViews(
      [event({ occurredAt: "2026-08-13T14:00:04.000Z", ip: "67.231.156.9", userAgent: PROOFPOINT })],
      SENT_AT,
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.kind).toBe("scanner");
    expect(weeklyReportWasOpenedByAPerson(sessions)).toBe(false);
  });

  it("does not call a burst of photo loads a person", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and it was asserting a bug as correct.
    //
    // The viewer emits `<img loading="lazy">`. A browser fetches everything inside its preload margin
    // with no scroll, no click and nobody in the room, and a headless scanner that renders the HTML does
    // the same. Three fetches inside two seconds is what a preload looks like — treating it as proof
    // meant merely RENDERING the page could become evidence the client read the report. Caught by Codex.
    const sessions = summariseWeeklyReportViews(
      [
        event({ occurredAt: "2026-08-13T19:41:02.000Z" }),
        event({ occurredAt: "2026-08-13T19:41:03.000Z", eventType: "photo" }),
        event({ occurredAt: "2026-08-13T19:41:04.000Z", eventType: "photo" }),
      ],
      SENT_AT,
    );

    expect(sessions[0]!.kind).toBe("unclear");
    expect(sessions[0]!.photoViews).toBe(2);
    expect(weeklyReportWasOpenedByAPerson(sessions)).toBe(false);
  });

  it("does not stretch a single photo into a reading span with a later page hit", () => {
    // CODEX'S FINDING. The span used to be measured across the SITTING, and `endedAt` advances on any
    // event — so one preloaded image plus a refresh two minutes later (its images served from cache, so
    // no second photo request) produced a two-minute "span" containing exactly one photo, and the page
    // called it somebody scrolling. One photo cannot be spread over anything.
    const sessions = summariseWeeklyReportViews(
      [
        event({ occurredAt: "2026-08-13T19:41:02.000Z" }),
        event({ occurredAt: "2026-08-13T19:41:03.000Z", eventType: "photo" }),
        event({ occurredAt: "2026-08-13T19:44:30.000Z" }),
      ],
      SENT_AT,
    );

    expect(sessions[0]!.kind).toBe("unclear");
    expect(weeklyReportWasOpenedByAPerson(sessions)).toBe(false);
  });

  it("calls photos loaded across a sitting a person", () => {
    // What a preload cannot fake is TIME. Images inside the margin arrive together; somebody scrolling a
    // report pulls them over minutes. That span is the signal, and it is the only one photos can honestly
    // carry on their own.
    const sessions = summariseWeeklyReportViews(
      [
        event({ occurredAt: "2026-08-13T19:41:02.000Z" }),
        event({ occurredAt: "2026-08-13T19:42:30.000Z", eventType: "photo" }),
        event({ occurredAt: "2026-08-13T19:46:10.000Z", eventType: "photo" }),
      ],
      SENT_AT,
    );

    expect(sessions[0]!.kind).toBe("person");
    expect(weeklyReportWasOpenedByAPerson(sessions)).toBe(true);
  });

  it("keeps a self-identified scanner a scanner even when it pulls the PDF", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, on the theory that some corporate proxies rewrite the user
    // agent of ordinary browser traffic. The theory is true and the ordering was still wrong: the PDF is
    // an ordinary link on the page, and following every link is exactly what these products are FOR. So
    // a fetch by something calling itself Proofpoint made the audit claim a person read the report while
    // the log underneath said "ProofpointURLDefense" — and somebody would have read that to a client.
    //
    // Understating is the direction this page must fail in. The raw session renders beside the verdict,
    // so a reader can see a rewritten agent and judge; a confident wrong claim leaves nothing to check.
    const sessions = summariseWeeklyReportViews(
      [
        event({ occurredAt: "2026-08-13T19:41:02.000Z", userAgent: "ProofpointURLDefense/1.0" }),
        event({
          occurredAt: "2026-08-13T19:41:09.000Z",
          eventType: "pdf",
          userAgent: "ProofpointURLDefense/1.0",
        }),
      ],
      SENT_AT,
    );

    expect(sessions[0]!.kind).toBe("scanner");
    expect(weeklyReportWasOpenedByAPerson(sessions)).toBe(false);
  });

  it("calls a PDF download from an ordinary browser a person", () => {
    // The control. Making the agent authoritative must not cost the verdict the feature exists to give.
    const sessions = summariseWeeklyReportViews(
      [
        event({ occurredAt: "2026-08-13T19:41:02.000Z" }),
        event({ occurredAt: "2026-08-13T19:41:09.000Z", eventType: "pdf" }),
      ],
      SENT_AT,
    );

    expect(sessions[0]!.kind).toBe("person");
    expect(sessions[0]!.reason).toContain("PDF");
  });

  it("does NOT call a real reader a scanner just for arriving quickly", () => {
    // Somebody watching for the email opens it in under 90 seconds and reads it. The send-window rule
    // must not fire when the session went on to do something a scanner does not do.
    //
    // The PDF carries this now rather than the photos. A fast arrival that loads images in a burst is
    // genuinely ambiguous — that is exactly what a scanner rendering the page produces — so the download
    // is what separates them, and it is the one action nothing automated takes by accident.
    const sessions = summariseWeeklyReportViews(
      [
        event({ occurredAt: "2026-08-13T14:00:30.000Z" }),
        event({ occurredAt: "2026-08-13T14:00:33.000Z", eventType: "photo" }),
        event({ occurredAt: "2026-08-13T14:00:41.000Z", eventType: "pdf" }),
      ],
      SENT_AT,
    );

    expect(sessions[0]!.kind).toBe("person");
  });

  it("admits when it does not know", () => {
    // A real browser, hours later, that opened the page and read no further. Somebody who glanced and
    // closed it is indistinguishable from a scanner this file does not recognise, and saying so is more
    // useful than guessing.
    const sessions = summariseWeeklyReportViews(
      [event({ occurredAt: "2026-08-13T19:41:02.000Z" })],
      SENT_AT,
    );

    expect(sessions[0]!.kind).toBe("unclear");
    expect(weeklyReportWasOpenedByAPerson(sessions)).toBe(false);
  });

  it("treats a missing user agent as automated", () => {
    expect(looksLikeScannerAgent(null)).toBe(true);
    expect(looksLikeScannerAgent("")).toBe(true);
    expect(looksLikeScannerAgent(CHROME)).toBe(false);
  });

  it("pins the send window to an interval, not to whatever the constant happens to be", () => {
    // Both fixtures are absolute. A test computing its timestamps FROM the constant cannot fail when the
    // constant moves — the exact defect this codebase has shipped more than once.
    expect(WEEKLY_REPORT_SCANNER_WINDOW_SECONDS).toBe(90);

    const inside = summariseWeeklyReportViews(
      [event({ occurredAt: "2026-08-13T14:01:29.000Z" })], // 89s
      SENT_AT,
    );
    const outside = summariseWeeklyReportViews(
      [event({ occurredAt: "2026-08-13T14:01:31.000Z" })], // 91s
      SENT_AT,
    );

    expect(inside[0]!.kind).toBe("scanner");
    expect(outside[0]!.kind).toBe("unclear");
  });
});

describe("grouping fetches into sittings", () => {
  it("keeps one visitor's page, photos and PDF together", () => {
    const sessions = summariseWeeklyReportViews(
      [
        event({ occurredAt: "2026-08-13T19:41:02.000Z" }),
        event({ occurredAt: "2026-08-13T19:41:05.000Z", eventType: "photo" }),
        event({ occurredAt: "2026-08-13T19:49:20.000Z", eventType: "pdf" }),
      ],
      SENT_AT,
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!).toMatchObject({ pageViews: 1, photoViews: 1, pdfDownloads: 1 });
  });

  it("separates two people behind one office IP", () => {
    // A shared NAT address is many people. Collapsing on IP alone would report one long sitting where
    // there were two short ones — and in a dispute, "two people looked" is a different fact from "one".
    const sessions = summariseWeeklyReportViews(
      [
        event({ occurredAt: "2026-08-13T19:41:02.000Z", userAgent: CHROME }),
        event({ occurredAt: "2026-08-13T19:42:02.000Z", userAgent: "Mozilla/5.0 (iPhone) Safari/605.1" }),
      ],
      SENT_AT,
    );

    expect(sessions).toHaveLength(2);
  });

  it("separates the same person coming back the next day", () => {
    const sessions = summariseWeeklyReportViews(
      [
        event({ occurredAt: "2026-08-13T19:41:02.000Z" }),
        event({ occurredAt: "2026-08-14T09:15:00.000Z" }),
      ],
      SENT_AT,
    );

    expect(sessions).toHaveLength(2);
    // Newest first — the audit page is read to answer "did they ever look", and the latest access
    // answers it.
    expect(sessions[0]!.startedAt).toBe("2026-08-14T09:15:00.000Z");
  });

  it("survives a report that was never sent, so there is no send to measure against", () => {
    const sessions = summariseWeeklyReportViews(
      [event({ occurredAt: "2026-08-13T19:41:02.000Z" })],
      null,
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.kind).toBe("unclear");
  });

  it("reports nothing at all for a report nobody fetched", () => {
    expect(summariseWeeklyReportViews([], SENT_AT)).toEqual([]);
    expect(weeklyReportWasOpenedByAPerson([])).toBe(false);
  });
});
