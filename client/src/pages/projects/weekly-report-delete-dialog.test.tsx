// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deleting a weekly report is not undoable from any surface — `is_active` supports a restore and nothing
// offers one — so the two things this dialog owes the user are a reason it will not accept the click
// without, and, for a report the client is already holding, the week typed back.
//
// The week is the part most easily got wrong. History renders "Aug 13, 2026" and never shows the ISO
// string the server compares against, so a dialog that says "type the week" without showing WHICH form is
// a dialog nobody can satisfy.

const mocks = vi.hoisted(() => ({
  deleteWeeklyReport: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/hooks/use-weekly-reports", () => ({
  deleteWeeklyReport: mocks.deleteWeeklyReport,
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

import { WEEKLY_REPORT_DELETE_REASON_MAX_CHARS } from "@trock-crm/shared/types";

import { WeeklyReportDeleteDialog } from "./weekly-report-delete-dialog";

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    weekOf: "2026-08-13",
    version: 1,
    status: "draft",
    sentAt: null,
    photos: [],
    ...overrides,
  } as any;
}

const SENT = report({ status: "sent", sentAt: "2026-08-13T17:00:00.000Z" });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.deleteWeeklyReport.mockReset();
  mocks.deleteWeeklyReport.mockResolvedValue(undefined);
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Record<string, unknown> = {}) {
  act(() => {
    root.render(
      <WeeklyReportDeleteDialog
        report={report()}
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        {...(props as any)}
      />,
    );
  });
}

function field(label: string): HTMLTextAreaElement | HTMLInputElement {
  const node = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[aria-label="${label}"]`);
  if (!node) throw new Error(`field ${label} not found`);
  return node;
}
function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  if (!match) throw new Error(`button ${label} not found`);
  return match as HTMLButtonElement;
}
function type(label: string, value: string) {
  const node = field(label);
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(prototype.prototype, "value")!.set!;
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("deleting a draft", () => {
  it("keeps the destructive button disabled until a reason is written", () => {
    render();
    expect(button("Delete report").disabled).toBe(true);
    type("Reason", "  ");
    expect(button("Delete report").disabled).toBe(true);
    // NON-EMPTY, matching the server's 400 and the house idiom. A longer minimum invented here would put
    // the disabled state and the server's answer into disagreement about the same click.
    type("Reason", "dupe");
    expect(button("Delete report").disabled).toBe(false);
  });

  it("sends the trimmed reason and no week, because a draft needs none", async () => {
    render();
    type("Reason", "  Test data from the runbook  ");
    await act(async () => {
      button("Delete report").click();
    });
    expect(mocks.deleteWeeklyReport).toHaveBeenCalledWith("r1", {
      reason: "Test data from the runbook",
    });
  });

  it("caps the reason at what the audit log will actually store, and shows the remaining room", async () => {
    // `audit_log` is the ONLY place this sentence is kept, and it used to be trimmed to 500 server-side
    // behind a success toast — so the half of the explanation that mattered was discarded while the user
    // was told it had been saved. The server now refuses; this stops them writing past it in the first
    // place, and the counter is what makes the limit visible before they hit it.
    render();
    expect(field("Reason").getAttribute("maxLength")).toBe(String(WEEKLY_REPORT_DELETE_REASON_MAX_CHARS));

    type("Reason", "x".repeat(460));
    expect(document.body.textContent).toContain("40 left");
  });

  it("keeps quiet about the count until the user is near the limit", () => {
    // A character counter on every reason turns a two-word explanation into a form with a budget. It is
    // there for the person writing a paragraph, not the one writing "duplicate".
    render();
    type("Reason", "Test data");
    expect(document.body.textContent).not.toMatch(/left/i);
  });

  it("reports back and closes on success", async () => {
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    render({ onDeleted, onClose });
    type("Reason", "Test data");
    await act(async () => {
      button("Delete report").click();
    });
    expect(onDeleted).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it("stays open and says why when the server refuses", async () => {
    const onClose = vi.fn();
    mocks.deleteWeeklyReport.mockRejectedValue(
      new Error("This report replaced an earlier version of the same week."),
    );
    render({ onClose });
    type("Reason", "Correction was a mistake");
    await act(async () => {
      button("Delete report").click();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "This report replaced an earlier version of the same week.",
    );
  });
});

describe("deleting a report the client already has", () => {
  it("shows the exact string it wants typed, because History never renders the ISO form", () => {
    render({ report: SENT });
    expect(document.body.textContent).toContain("2026-08-13");
  });

  it("stays disabled until the week matches exactly, reason or no reason", () => {
    render({ report: SENT });
    type("Reason", "Sent to the wrong client");
    expect(button("Delete report").disabled).toBe(true);

    // The friendly rendering History shows is NOT accepted — the server compares the ISO date.
    type("Confirm the week", "Aug 13, 2026");
    expect(button("Delete report").disabled).toBe(true);

    type("Confirm the week", "2026-08-06");
    expect(button("Delete report").disabled).toBe(true);

    type("Confirm the week", "2026-08-13");
    expect(button("Delete report").disabled).toBe(false);
  });

  it("passes the confirmed week through, which is what the server re-checks", async () => {
    render({ report: SENT });
    type("Reason", "Sent to the wrong client");
    type("Confirm the week", "2026-08-13");
    await act(async () => {
      button("Delete report").click();
    });
    expect(mocks.deleteWeeklyReport).toHaveBeenCalledWith("r1", {
      reason: "Sent to the wrong client",
      confirmWeekOf: "2026-08-13",
    });
  });

  it("tells the user the client's link stops resolving — and does not claim it is revoked", async () => {
    // The public viewer filters `is_active`, so the link genuinely stops working. It is NOT revoked, and
    // saying so would be worse than saying nothing: the revoked page reads "this link was turned off by
    // the project team, usually because a corrected version was issued", which is false for a report
    // that was simply removed and would send the client looking for a correction that does not exist.
    render({ report: SENT });
    expect(document.body.textContent).toMatch(/stop working/i);
    expect(document.body.textContent).not.toMatch(/revoked/i);
  });
});
