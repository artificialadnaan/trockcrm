// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useWeeklyReportProjectAudit: vi.fn() }));

vi.mock("@/hooks/use-weekly-reports", () => ({
  useWeeklyReportProjectAudit: mocks.useWeeklyReportProjectAudit,
}));

import { WeeklyReportProjectAuditDialog } from "./weekly-report-project-audit-dialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.useWeeklyReportProjectAudit.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * WHAT THIS FILE IS FOR, now that it is no longer testing a rule.
 *
 * `outstanding` is decided by the server — see project-audit-service. What is worth pinning down here is
 * that the three places this page renders that one fact all read the SAME field. They did not always:
 * the count, the chip and the border each carried their own predicate and disagreed twice on this PR,
 * once each direction. So the fixtures below set `outstanding` INDEPENDENTLY of `undelivered`, including
 * in combinations the server would never emit, because a surface quietly re-deriving its own answer is
 * exactly what these tests exist to catch.
 */
function report(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    weekOf: "2026-08-13",
    version: 1,
    status: "sent",
    supersededById: null,
    recipients: ["jay@mackre.com"],
    deliveryStatus: null,
    undelivered: false,
    outstanding: false,
    sentAt: "2026-08-13T17:00:00.000Z",
    viewSessions: [],
    openedByAPerson: false,
    viewSessionsTruncated: false,
    events: [],
    ...overrides,
  };
}

function render(audit: Record<string, unknown>) {
  mocks.useWeeklyReportProjectAudit.mockReturnValue({
    audit: {
      project: {
        propertyDisplayName: "4123 Cedar Springs",
        dealName: "4123 Cedar Springs",
        projectNumber: "DFW-10432",
        clientName: "Mack Real Estate Group",
        trockPmName: "Adam Sherwood",
        trockSuperName: "Steve Sanchez",
      },
      viewTrackingSince: "2026-01-01T00:00:00.000Z",
      reports: [],
      reminders: [],
      dismissals: [],
      pauses: [],
      ...audit,
    },
    loading: false,
    error: null,
  });
  act(() => {
    root.render(<WeeklyReportProjectAuditDialog projectId="p1" onClose={vi.fn()} />);
  });
}

/** The value under a given stat label, read off the rendered card rather than from component state. */
function statValue(label: string): string | null {
  const cards = Array.from(document.querySelectorAll("div"));
  const card = cards.find(
    (node) => node.children.length === 2 && node.children[1]?.textContent?.trim() === label,
  );
  return card?.children[0]?.textContent?.trim() ?? null;
}

/** Scoped to the report card, because the summary stat is also labelled "Not delivered". */
function cards(): HTMLElement[] {
  return Array.from(document.querySelectorAll("article"));
}

function cardTone(index = 0): "red" | "amber" | "neutral" {
  const cls = cards()[index]?.className ?? "";
  if (cls.includes("brand-red")) return "red";
  if (cls.includes("amber")) return "amber";
  return "neutral";
}

describe("the three renderings of one fact", () => {
  it("counts, chips and borders a report the server called outstanding", () => {
    render({
      reports: [report({ outstanding: true, undelivered: true, deliveryStatus: "bounced" })],
    });

    expect(statValue("Not delivered")).toBe("1");
    expect(cards()[0]!.textContent).toContain("bounced");
    expect(cardTone()).toBe("red");
  });

  /**
   * The regression this PR shipped twice, in both directions. A week whose v1 bounced and whose v2 was
   * delivered is RESOLVED — the client has their report — and `undelivered` is still true on the row.
   * Every surface has to take the server's word for that, not re-read `undelivered` and re-decide.
   */
  it("stays silent on a row the server settled, however undelivered it looks", () => {
    render({
      reports: [
        report({
          id: "v1",
          supersededById: "v2",
          undelivered: true,
          deliveryStatus: "bounced",
          outstanding: false,
        }),
      ],
    });

    expect(statValue("Not delivered")).toBe("0");
    expect(cards()[0]!.textContent).not.toContain("bounced");
    expect(cardTone()).toBe("neutral");
  });

  /**
   * Unsuperseded AND undelivered AND not flagged is a combination today's server rule cannot produce —
   * which is the point. This page is not allowed an opinion of its own to fall back on, so that when the
   * definition of "outstanding" next moves, all three surfaces move with it and none has to be found.
   *
   * Without this case the border keeps passing while keyed on `undelivered && !supersededById`, because
   * that predicate and the server's agree on every input the server can actually emit. It only diverges
   * on the inputs it is not allowed to see.
   */
  it("does not overrule the server on a row that looks failed but was not flagged", () => {
    render({ reports: [report({ undelivered: true, deliveryStatus: "bounced", outstanding: false })] });

    expect(statValue("Not delivered")).toBe("0");
    expect(cards()[0]!.textContent).not.toContain("bounced");
    expect(cardTone()).toBe("neutral");
  });
});

describe("what the chip actually claims", () => {
  /**
   * Greptile's finding, at the far end. The correction was accepted and the provider has said nothing
   * since, so the honest word is "not confirmed" — calling it "Not delivered" asserts a failure the CRM
   * cannot evidence, which is the same mistake as the one being fixed, pointed the other way.
   */
  it("says a correction in flight is unconfirmed, not failed", () => {
    render({ reports: [report({ outstanding: true, undelivered: false, deliveryStatus: null })] });

    const text = cards()[0]!.textContent ?? "";
    expect(text).toContain("Not confirmed");
    expect(text).not.toContain("Not delivered");
    expect(cardTone()).toBe("amber");
  });

  it("uses the provider's own word when there is one", () => {
    render({ reports: [report({ outstanding: true, undelivered: true, deliveryStatus: "bounced" })] });
    expect(cards()[0]!.textContent).toContain("bounced");
  });

  it("falls back to 'Not delivered' for a send with no verdict at all", () => {
    render({ reports: [report({ outstanding: true, undelivered: true, deliveryStatus: null })] });
    expect(cards()[0]!.textContent).toContain("Not delivered");
  });

  it("marks a superseded version without also calling it a live failure", () => {
    render({
      reports: [
        report({ supersededById: "v2", undelivered: true, deliveryStatus: "bounced", outstanding: false }),
      ],
    });

    const text = cards()[0]!.textContent ?? "";
    expect(text).toContain("Superseded");
    expect(text).not.toContain("bounced");
  });
});

describe("the summary counts", () => {
  it("counts one week once, however many versions it went through", () => {
    render({
      reports: [
        report({ id: "v2", version: 2 }),
        report({ id: "v1", version: 1, supersededById: "v2" }),
      ],
    });

    expect(statValue("Weeks on record")).toBe("1");
    expect(statValue("Reports sent")).toBe("1");
  });

  it("counts every outstanding week, not just the first", () => {
    render({
      reports: [
        report({ id: "a", weekOf: "2026-08-13", outstanding: true, undelivered: true }),
        report({ id: "b", weekOf: "2026-08-06", outstanding: true, undelivered: false }),
      ],
    });

    expect(statValue("Not delivered")).toBe("2");
    expect(cardTone(0)).toBe("red");
    expect(cardTone(1)).toBe("amber");
  });
});

describe("the open log", () => {
  function session(over: Record<string, unknown> = {}) {
    return {
      ip: "73.162.44.219",
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/141.0",
      startedAt: "2026-08-13T22:41:02.000Z",
      endedAt: "2026-08-13T22:49:20.000Z",
      pageViews: 1,
      photoViews: 3,
      pdfDownloads: 1,
      kind: "person" as const,
      reason: "Downloaded the PDF, which link scanners do not do",
      ...over,
    };
  }

  it("says plainly when only scanners have fetched it", () => {
    // The distinction the whole feature exists for. "Opened" on a report only a robot touched is the
    // claim that would collapse in front of a client's IT department.
    render({
      reports: [
        report({ status: "sent", openedByAPerson: false, viewSessions: [session({ kind: "scanner", photoViews: 0, pdfDownloads: 0, reason: "The browser it reported is an email security scanner" })] }),
      ],
    });

    expect(document.body.textContent).toContain("Only automated scanners have fetched this");
  });

  it("does not call an unclear visit a scanner", () => {
    // GREPTILE'S FINDING. The classifier has THREE verdicts and this line had two, so `unclear` — a real
    // browser that arrived late and did nothing else — was reported as "only automated scanners".
    //
    // The reader of this line may be about to repeat it to the client, which is the entire reason the
    // log exists. "We cannot tell" is honest and still useful. "Robots only", said about a report a
    // person may well have read, is how you lose the argument the log was built to win.
    render({
      reports: [
        report({
          status: "sent",
          openedByAPerson: false,
          viewSessions: [
            session({
              kind: "unclear",
              photoViews: 0,
              pdfDownloads: 0,
              reason: "An ordinary browser, but it opened nothing beyond the page",
            }),
          ],
        }),
      ],
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("cannot tell whether it was a person");
    expect(text).not.toContain("Only automated scanners");
  });

  it("still says scanners-only when every session really is one", () => {
    // The control for the case above: widening the wording must not blur the verdict that IS supported.
    // A mixed set is unclear; an all-scanner set is not, and reporting it as unclear would be its own
    // understatement.
    render({
      reports: [
        report({
          status: "sent",
          openedByAPerson: false,
          viewSessions: [
            session({ kind: "scanner", photoViews: 0, pdfDownloads: 0, reason: "Known security scanner" }),
            session({ kind: "scanner", photoViews: 0, pdfDownloads: 0, reason: "Known security scanner" }),
          ],
        }),
      ],
    });

    expect(document.body.textContent).toContain("Only automated scanners have fetched this");
  });

  it("treats a scanner mixed with an unclear visit as unclear, not as scanners-only", () => {
    render({
      reports: [
        report({
          status: "sent",
          openedByAPerson: false,
          viewSessions: [
            session({ kind: "scanner", photoViews: 0, pdfDownloads: 0, reason: "Known security scanner" }),
            session({ kind: "unclear", photoViews: 0, pdfDownloads: 0, reason: "Ordinary browser, nothing else" }),
          ],
        }),
      ],
    });

    expect(document.body.textContent).toContain("cannot tell whether it was a person");
  });

  it("does not claim nobody opened a week the log never covered", () => {
    // CODEX'S FINDING, and the same family as the scanner wording. An empty list has two meanings the
    // page cannot tell apart on its own: nobody opened it, or nothing about that week was ever recorded.
    // Every report sent before 0231 is the second, and so is anything the retention sweep has reached.
    // Saying "Nobody has opened the link yet" turns a hole in our own records into a statement about the
    // client — on the screen built to be quoted back to them.
    render({
      viewTrackingSince: "2026-06-01T00:00:00.000Z",
      reports: [report({ status: "sent", sentAt: "2026-02-02T17:00:00.000Z", viewSessions: [] })],
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("No open tracking was kept for this week");
    expect(text).not.toContain("Nobody has opened the link yet");
  });

  it("still says nobody opened a week the log DOES cover — the control", () => {
    // Without this the fix reads as "never assert the negative", which would discard the answer the
    // feature exists to give.
    render({
      viewTrackingSince: "2026-01-01T00:00:00.000Z",
      reports: [report({ status: "sent", sentAt: "2026-08-13T17:00:00.000Z", viewSessions: [] })],
    });

    expect(document.body.textContent).toContain("Nobody has opened the link yet");
  });

  it("counts sittings, not identified people", () => {
    // The classifier groups by IP, user agent and a 30-minute gap. It does not know who anybody is, so
    // one person returning after lunch is two sessions — and "2 people opened this" is a claim about
    // human beings that nothing in the log supports.
    render({
      reports: [
        report({
          status: "sent",
          openedByAPerson: true,
          viewSessions: [session(), session({ startedAt: "2026-08-14T09:00:00.000Z" })],
        }),
      ],
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("2 separate sittings");
    expect(text).not.toContain("2 people");
  });

  it("says so when a person opened it", () => {
    // Wording deliberately narrowed from "Opened by someone at the client": the log identifies sittings,
    // not people, so a single session is "one sitting" rather than a claim about a human being.
    render({ reports: [report({ status: "sent", openedByAPerson: true, viewSessions: [session()] })] });
    expect(document.body.textContent).toContain("Opened at the client — one sitting");
  });

  it("distinguishes never-opened from never-sent", () => {
    // A report still with the PM has nothing to have been opened; saying "nobody has opened it" about
    // one would read as a failure rather than as a stage it has not reached.
    render({ reports: [report({ status: "sent", viewSessions: [] })] });
    expect(document.body.textContent).toContain("Nobody has opened the link yet");

    act(() => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    render({ reports: [report({ status: "pending_review", viewSessions: [] })] });
    expect(document.body.textContent).not.toContain("Nobody has opened the link yet");
  });
});
