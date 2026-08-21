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
    sendDeliveredAt: "2026-08-13T17:00:30.000Z",
    viewSessions: [],
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
      referrerOrigin: null,
      ...over,
    };
  }

  /**
   * WHAT THIS PAGE IS ALLOWED TO SAY.
   *
   * It used to say whether a person had read the report. It no longer does — every rule separating a
   * reader from a link scanner had a counterexample, and a wrong guess here gets quoted to a client.
   * These tests pin the retreat: a count, the raw facts, and no verdict anywhere.
   */
  it("counts fetches and sittings rather than judging who they were", () => {
    render({ reports: [report({ status: "sent", viewSessions: [session()] })] });

    const text = document.body.textContent ?? "";
    expect(text).toContain("5 fetches of this link, in one sitting");
    expect(text).not.toMatch(/A person|Email scanner|Unclear|automated scanners/);
  });

  it("counts across sittings without calling them people", () => {
    // Two sittings from one address and agent is one person coming back after lunch, as often as not.
    render({
      reports: [
        report({
          status: "sent",
          viewSessions: [session(), session({ startedAt: "2026-08-14T09:00:00.000Z" })],
        }),
      ],
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("across 2 sittings");
    expect(text).not.toContain("2 people");
  });

  it("shows the address, the device and what was fetched", () => {
    // The whole substance of the retreat: the reader gets everything they need to judge for themselves,
    // which is what a dispute turns on.
    render({ reports: [report({ status: "sent", viewSessions: [session()] })] });
    act(() => {
      (Array.from(document.querySelectorAll("button")).find((element) =>
        element.textContent?.includes("fetches of this link"),
      ) as HTMLButtonElement).click();
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("73.162.44.219");
    expect(text).toContain("Chrome/141.0");
    expect(text).toContain("1 PDF download");
    expect(text).toContain("3 photos");
  });

  it("flags the delivery failure beside the count without ruling the fetches out", () => {
    // A bounce sitting beside "5 fetches of this link" reads as the client having opened it, which the
    // delivery chip a few lines up contradicts — so the failure is worth flagging.
    //
    // But it says only that. An earlier version claimed the fetches "did not come from the client's
    // copy", which is wrong the moment a report goes to several contacts: `undelivered` keeps the WORST
    // per-recipient outcome, so one bounce among three sets it while the other two received and read
    // the report. Ruling their fetches out is the same overreach as claiming them.
    render({
      reports: [
        report({
          status: "sent",
          undelivered: true,
          deliveryStatus: "bounced",
          outstanding: true,
          viewSessions: [session()],
        }),
      ],
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("Delivery failed for at least one recipient");
    // The overreach it replaced: never say where the fetches came from.
    expect(text).not.toContain("did not come from the client's copy");
  });

  it("does not announce that nobody opened a report the provider never accepted", () => {
    // THE SENTENCE THAT TOOK FOUR FINDINGS. A send the provider never took has no acceptance stamp, no
    // sessions, and nothing whatever to say about the client — and the page announced that nobody had
    // opened it. Recording is best-effort too: `recordWeeklyReportView` swallows its own failures so a
    // view that cannot be logged never breaks the page a client is reading, which means an empty list
    // never proves absence under ANY delivery state.
    render({
      reports: [
        report({
          status: "sent",
          sentAt: "2026-08-13T17:00:00.000Z",
          sendDeliveredAt: null,
          undelivered: true,
          viewSessions: [],
        }),
      ],
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("No fetches of this link have been recorded");
    expect(text).not.toMatch(/Nobody has opened/);
  });

  it("says no such thing when the report was delivered", () => {
    render({ reports: [report({ status: "sent", viewSessions: [session()] })] });
    expect(document.body.textContent).not.toContain("Delivery failed for at least one recipient");
  });

  it("shows how many times the PDF was pulled, not just that it was", () => {
    render({ reports: [report({ status: "sent", viewSessions: [session({ pdfDownloads: 3 })] })] });
    act(() => {
      (Array.from(document.querySelectorAll("button")).find((element) =>
        element.textContent?.includes("fetches of this link"),
      ) as HTMLButtonElement).click();
    });
    expect(document.body.textContent).toContain("3 PDF downloads");
  });

  it("shows where the visitor came from, which is why the referrer is kept at all", () => {
    // The origin is stored specifically to distinguish "reached it from Gmail" from "reached it from a
    // Teams message" — and it was being stored and never shown. A column retained for a purpose it
    // never serves is a column that should not have been retained, which matters doubly on a table full
    // of other people's addresses. Flagged by Codex.
    render({
      reports: [
        report({ status: "sent", viewSessions: [session({ referrerOrigin: "https://mail.google.com" })] }),
      ],
    });
    act(() => {
      (Array.from(document.querySelectorAll("button")).find((element) =>
        element.textContent?.includes("fetches of this link"),
      ) as HTMLButtonElement).click();
    });

    expect(document.body.textContent).toContain("followed a link from https://mail.google.com");
  });

  it("qualifies a report whose week predates the log even when it has fetches", () => {
    // A report accepted before the horizon whose link is fetched again afterwards HAS rows, so the
    // empty-list branch never fires — and the count then reads as a complete record when everything
    // between the send and the start of logging was never captured.
    render({
      viewTrackingSince: "2026-06-01T00:00:00.000Z",
      reports: [
        report({
          status: "sent",
          sentAt: "2026-02-02T17:00:00.000Z",
          viewSessions: [session()],
        }),
      ],
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("predates the open log");
    expect(text).toContain("fetches of this link");
  });

  it("says when the address was never recorded rather than leaving a blank", () => {
    render({
      reports: [report({ status: "sent", viewSessions: [session({ ip: null, userAgent: null })] })],
    });
    act(() => {
      (Array.from(document.querySelectorAll("button")).find((element) =>
        element.textContent?.includes("fetches of this link"),
      ) as HTMLButtonElement).click();
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("address not recorded");
    expect(text).toContain("no browser reported");
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
    expect(text).toContain("No open tracking on record");
    expect(text).not.toContain("No fetches of this link have been recorded");
  });

  it("does not assert nobody opened it when the horizon cannot be established", () => {
    // CODEX. The server returns null when it cannot place the start of logging — no migration ledger and
    // no rows to infer one from. My first fallback substituted the retention floor, which asserts that
    // logging has been running a full 24 months when the table might be a week old, and every week in
    // between would render as "nobody opened the link" out of a gap in our own records. That is the
    // finding this horizon exists to prevent, reintroduced by its own fallback.
    render({
      viewTrackingSince: null,
      reports: [report({ status: "sent", sentAt: "2026-08-13T17:00:00.000Z", viewSessions: [] })],
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("No open tracking on record");
    expect(text).not.toContain("No fetches of this link have been recorded");
  });

  it("reads a PostgreSQL-formatted horizon, not just an ISO one", () => {
    // The parse exists for THIS shape. `2026-06-01 00:00:00+00` is what the driver hands back when it
    // does not coerce to a Date — a space where the `T` goes — and it sorts BEFORE every ISO string, so
    // the old string comparison would have marked every week untracked. Both existing cases pass ISO,
    // which the string comparison also handled, so neither could tell the two apart. Flagged by
    // CodeRabbit.
    // SAME DAY, one hour apart, and that is what makes this case able to fail at all. My first attempt
    // put the two months apart, where a string comparison happens to agree with a parse — so it passed
    // against the bug and proved nothing. Here the only difference at the deciding character is `T`
    // (0x54) against a space (0x20): compared as text the send sorts AFTER the horizon and the week
    // reads as tracked; parsed, it sorts an hour BEFORE and the week is outside the log.
    render({
      viewTrackingSince: "2026-08-13 18:00:00+00",
      reports: [report({ status: "sent", sentAt: "2026-08-13T17:00:00.000Z", viewSessions: [] })],
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("No open tracking on record");
    expect(text).not.toContain("No fetches of this link have been recorded");
  });

  it("still says nobody opened a week the log DOES cover — the control", () => {
    // Without this the fix reads as "never assert the negative", which would discard the answer the
    // feature exists to give.
    render({
      viewTrackingSince: "2026-01-01T00:00:00.000Z",
      reports: [report({ status: "sent", sentAt: "2026-08-13T17:00:00.000Z", viewSessions: [] })],
    });

    expect(document.body.textContent).toContain("No fetches of this link have been recorded");
  });

  it("distinguishes never-opened from never-sent", () => {
    // A report still with the PM has nothing to have been opened; saying "nobody has opened it" about
    // one would read as a failure rather than as a stage it has not reached.
    render({ reports: [report({ status: "sent", viewSessions: [] })] });
    expect(document.body.textContent).toContain("No fetches of this link have been recorded");

    act(() => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    render({ reports: [report({ status: "pending_review", viewSessions: [] })] });
    expect(document.body.textContent).not.toContain("Nobody has opened the link yet");
  });

});
