// Grouping accesses into sittings — and, since the classifier came out, nothing else.
//
// This file used to test a verdict: person, scanner, or unclear. It no longer does, because the verdict
// no longer exists. Every rule that separated a reader from a link scanner had a counterexample, review
// found them one after another, and each fix produced the next case. HTTP requests do not carry intent.
//
// What survives is arrangement, and arrangement is checkable: the same visitor's fetches belong
// together, a different visitor's do not, and a long enough gap starts a new sitting. Those are the
// properties a reader relies on when they scan the log to answer "has anybody looked at this".

import { describe, expect, it } from "vitest";
import {
  summariseWeeklyReportViews,
  WEEKLY_REPORT_VIEW_SESSION_GAP_MINUTES,
  type WeeklyReportViewEvent,
} from "./weeklyReportViews.js";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";
const PROOFPOINT = "Mozilla/5.0 (compatible; ProofpointURLDefense/1.0)";

function event(over: Partial<WeeklyReportViewEvent> & { occurredAt: string }): WeeklyReportViewEvent {
  return { eventType: "page", ip: "73.162.44.219", userAgent: CHROME, ...over };
}

describe("grouping one visitor's fetches", () => {
  it("keeps a page, its photos and the PDF download in one sitting", () => {
    const sessions = summariseWeeklyReportViews([
      event({ occurredAt: "2026-08-13T19:41:02.000Z" }),
      event({ occurredAt: "2026-08-13T19:41:03.000Z", eventType: "photo" }),
      event({ occurredAt: "2026-08-13T19:41:04.000Z", eventType: "photo" }),
      event({ occurredAt: "2026-08-13T19:49:20.000Z", eventType: "pdf" }),
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.pageViews).toBe(1);
    expect(sessions[0]!.photoViews).toBe(2);
    expect(sessions[0]!.pdfDownloads).toBe(1);
    expect(sessions[0]!.startedAt).toBe("2026-08-13T19:41:02.000Z");
    expect(sessions[0]!.endedAt).toBe("2026-08-13T19:49:20.000Z");
  });

  it("starts a new sitting once the gap is exceeded", () => {
    // Somebody who comes back after lunch is a second sitting, not a second person — which is exactly
    // why nothing downstream counts sittings as people.
    const sessions = summariseWeeklyReportViews([
      event({ occurredAt: "2026-08-13T12:00:00.000Z" }),
      event({ occurredAt: `2026-08-13T${12 + 1}:00:00.000Z` }),
    ]);

    expect(sessions).toHaveLength(2);
  });

  it("keeps fetches inside the gap together", () => {
    // The control for the case above. Without it, a grouping that never groups would still pass.
    const minutesInside = WEEKLY_REPORT_VIEW_SESSION_GAP_MINUTES - 5;
    const sessions = summariseWeeklyReportViews([
      event({ occurredAt: "2026-08-13T12:00:00.000Z" }),
      event({ occurredAt: `2026-08-13T12:${String(minutesInside).padStart(2, "0")}:00.000Z` }),
    ]);

    expect(sessions).toHaveLength(1);
  });
});

describe("telling visitors apart", () => {
  it("does not merge two visitors who share an address", () => {
    // An office behind one NAT address is many people. Grouping on IP alone would report one long
    // sitting where there were several, and a reader counting them would be counting the wrong thing.
    const sessions = summariseWeeklyReportViews([
      event({ occurredAt: "2026-08-13T14:00:04.000Z", userAgent: PROOFPOINT }),
      event({ occurredAt: "2026-08-13T14:00:06.000Z", userAgent: CHROME }),
    ]);

    expect(sessions).toHaveLength(2);
  });

  it("does not merge one agent arriving from two addresses", () => {
    const sessions = summariseWeeklyReportViews([
      event({ occurredAt: "2026-08-13T14:00:04.000Z", ip: "67.231.156.9" }),
      event({ occurredAt: "2026-08-13T14:00:06.000Z", ip: "73.162.44.219" }),
    ]);

    expect(sessions).toHaveLength(2);
  });

  it("groups an anonymous visitor rather than dropping them", () => {
    // No address and no agent still happened, and a log that silently omits what it cannot attribute is
    // not a record. They group with each other, which is the most the data supports.
    const sessions = summariseWeeklyReportViews([
      event({ occurredAt: "2026-08-13T14:00:04.000Z", ip: null, userAgent: null }),
      event({ occurredAt: "2026-08-13T14:00:06.000Z", ip: null, userAgent: null, eventType: "pdf" }),
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.pdfDownloads).toBe(1);
  });
});

describe("the order a reader gets them in", () => {
  it("returns the most recent sitting first", () => {
    // The page is opened to answer "has anybody looked", and the newest access answers it.
    const sessions = summariseWeeklyReportViews([
      event({ occurredAt: "2026-08-13T09:00:00.000Z" }),
      event({ occurredAt: "2026-08-14T09:00:00.000Z" }),
      event({ occurredAt: "2026-08-15T09:00:00.000Z" }),
    ]);

    expect(sessions.map((session) => session.startedAt)).toEqual([
      "2026-08-15T09:00:00.000Z",
      "2026-08-14T09:00:00.000Z",
      "2026-08-13T09:00:00.000Z",
    ]);
  });

  it("puts the sitting with the latest fetch first, not the one that began earliest", () => {
    // A long sitting that is still going is more recent activity than a short one that started and
    // finished inside it. Ordering on `startedAt` buried the longer one underneath — in the one place a
    // reader looks first to answer "has anybody looked at this lately".
    const sessions = summariseWeeklyReportViews([
      // 13:00 → 15:00, one visitor.
      event({ occurredAt: "2026-08-13T13:00:00.000Z" }),
      event({ occurredAt: "2026-08-13T13:20:00.000Z" }),
      event({ occurredAt: "2026-08-13T13:40:00.000Z" }),
      event({ occurredAt: "2026-08-13T14:00:00.000Z" }),
      event({ occurredAt: "2026-08-13T14:30:00.000Z" }),
      event({ occurredAt: "2026-08-13T15:00:00.000Z" }),
      // A different visitor, in and out at 14:00.
      event({ occurredAt: "2026-08-13T14:00:30.000Z", ip: "10.2.2.2" }),
    ]);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.endedAt).toBe("2026-08-13T15:00:00.000Z");
  });

  it("orders correctly even when the rows arrive out of order", () => {
    // The caller orders by occurred_at, but a grouping that depended on that would break silently the
    // day the query changed.
    const sessions = summariseWeeklyReportViews([
      event({ occurredAt: "2026-08-15T09:00:00.000Z" }),
      event({ occurredAt: "2026-08-13T09:00:00.000Z" }),
    ]);

    expect(sessions[0]!.startedAt).toBe("2026-08-15T09:00:00.000Z");
  });

  it("returns nothing for a report nobody fetched", () => {
    expect(summariseWeeklyReportViews([])).toEqual([]);
  });
});
