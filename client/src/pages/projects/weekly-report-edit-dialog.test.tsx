// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The CRM has never edited a report's contents. `PATCH /reports/:id` has existed since 0222 and only
// T-Rock Cam ever called it, so a director who spotted a typo in a draft had no way to fix it from the
// office — the report had to go back to the superintendent's phone.
//
// What this dialog must not do is disagree with that endpoint. It accepts exactly five fields, it trims
// sections to null, it bounds the percentage at 0-100 and the weather days at a whole number — and a form
// that lets any of those through only finds out at the 400, with the user's work still on screen and
// nothing saying which field was wrong.

const mocks = vi.hoisted(() => ({
  updateWeeklyReportContent: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/hooks/use-weekly-reports", () => ({
  updateWeeklyReportContent: mocks.updateWeeklyReportContent,
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

import { WeeklyReportEditDialog } from "./weekly-report-edit-dialog";

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    weekOf: "2026-08-13",
    version: 1,
    status: "draft",
    workCompleted: "Framing on level 3",
    nextWeekLookAhead: "Drywall",
    issuesConcerns: null,
    completionPercent: 42,
    weatherDelayDays: 2,
    photos: [],
    ...overrides,
  } as any;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.updateWeeklyReportContent.mockReset();
  mocks.updateWeeklyReportContent.mockResolvedValue(report());
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
      <WeeklyReportEditDialog
        report={report()}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        {...(props as any)}
      />,
    );
  });
}

/** The dialog renders through a portal, so its nodes live on document.body. */
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
async function save() {
  await act(async () => {
    button("Save changes")!.click();
  });
}

describe("the weekly report edit dialog", () => {
  it("opens on what the report already says, rather than an empty form", () => {
    render();
    expect((field("Work completed") as HTMLTextAreaElement).value).toBe("Framing on level 3");
    expect((field("Completion percent") as HTMLInputElement).value).toBe("42");
    expect((field("Weather delay days") as HTMLInputElement).value).toBe("2");
  });

  it("submits all five fields the endpoint accepts, numbers as numbers", async () => {
    // The two numeric controls hand back STRINGS. `completion_percent` is numeric(5,2) and
    // `weather_delay_days` an integer, and the server's normalisers do coerce — but sending "42" also
    // sends "" for a cleared field, which is a different thing from null on a column where "nobody has
    // said yet" and "zero" are separate claims about the job.
    render();
    type("Work completed", "Framing complete");
    type("Issues / concerns", "Waiting on the permit");
    type("Completion percent", "55.5");
    await save();

    expect(mocks.updateWeeklyReportContent).toHaveBeenCalledWith("r1", {
      workCompleted: "Framing complete",
      nextWeekLookAhead: "Drywall",
      issuesConcerns: "Waiting on the permit",
      completionPercent: 55.5,
      weatherDelayDays: 2,
    });
  });

  it("sends null, not an empty string, for a section the user cleared", async () => {
    render();
    type("Issues / concerns", "   ");
    type("Completion percent", "");
    await save();

    expect(mocks.updateWeeklyReportContent).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ issuesConcerns: null, completionPercent: null }),
    );
  });

  it("refuses to save with the work-completed section empty, and never calls the API", async () => {
    // The send gate requires it and re-checks it at every forward transition, so an empty section here
    // is not merely a 400 later — it is a report that cannot move. Caught before the request so the
    // user's other edits are still in the form.
    render();
    type("Work completed", "   ");
    await save();

    expect(mocks.updateWeeklyReportContent).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringMatching(/work completed/i));
  });

  it("refuses a completion percent outside 0-100", async () => {
    render();
    type("Completion percent", "140");
    await save();

    expect(mocks.updateWeeklyReportContent).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringMatching(/between 0 and 100/i));
  });

  it("refuses a fractional weather delay, which the column cannot hold", async () => {
    render();
    type("Weather delay days", "1.5");
    await save();

    expect(mocks.updateWeeklyReportContent).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringMatching(/whole number/i));
  });

  it("hands the saved report back and closes, so the row behind it stops being stale", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const saved = report({ workCompleted: "Framing complete" });
    mocks.updateWeeklyReportContent.mockResolvedValue(saved);
    render({ onSaved, onClose });
    await save();

    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(onClose).toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it("stays open on a failure and says why", async () => {
    const onClose = vi.fn();
    mocks.updateWeeklyReportContent.mockRejectedValue(
      new Error("A sent report cannot be edited — issue a correction instead"),
    );
    render({ onClose });
    await save();

    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "A sent report cannot be edited — issue a correction instead",
    );
  });
});
