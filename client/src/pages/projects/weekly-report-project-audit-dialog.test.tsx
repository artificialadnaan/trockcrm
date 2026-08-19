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

describe("the summary counts", () => {
  it("does not count a failure that a later correction resolved", () => {
    // THE BUG: a week whose v1 bounced and whose v2 was then delivered is RESOLVED — the client has
    // their report. Counting v1 left a permanent red "1 not delivered" on a project with nothing
    // outstanding, and it contradicted the two surfaces beside it: the report card already suppresses
    // its chip on a superseded row, and the sent count already skipped them. Three views of one fact,
    // and the aggregate was the one still calling it a failure.
    render({
      reports: [
        report({ id: "v2", version: 2, status: "sent", undelivered: false }),
        report({
          id: "v1",
          version: 1,
          status: "sent",
          supersededById: "v2",
          undelivered: true,
          deliveryStatus: "bounced",
        }),
      ],
    });

    expect(statValue("Not delivered")).toBe("0");
    expect(statValue("Reports sent")).toBe("1");
  });

  it("still counts a failure nothing has replaced", () => {
    // The control. Without it the assertion above passes for a page that never flags anything — which
    // would hide exactly the case this whole feature exists to surface.
    render({
      reports: [report({ id: "v1", status: "sent", undelivered: true, deliveryStatus: "bounced" })],
    });

    expect(statValue("Not delivered")).toBe("1");
  });

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
});

describe("the report card", () => {
  it("marks a superseded version without also calling it a live failure", () => {
    render({
      reports: [
        report({
          id: "v1",
          supersededById: "v2",
          undelivered: true,
          deliveryStatus: "bounced",
        }),
      ],
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("Superseded");
    // The red delivery chip belongs to the version somebody still has to act on.
    expect(text).not.toContain("bounced");
  });

  it("shows the delivery verdict on a version nothing replaced", () => {
    render({
      reports: [report({ id: "v1", undelivered: true, deliveryStatus: "bounced" })],
    });
    expect(document.body.textContent ?? "").toContain("bounced");
  });
});
