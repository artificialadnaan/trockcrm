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
