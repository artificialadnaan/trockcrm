// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWeeklyReportSettings: vi.fn(),
  saveWeeklyReportSettings: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/hooks/use-weekly-reports", () => ({
  useWeeklyReportSettings: mocks.useWeeklyReportSettings,
  saveWeeklyReportSettings: mocks.saveWeeklyReportSettings,
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

import { WeeklyReportSettingsDialog } from "./weekly-report-settings-dialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.useWeeklyReportSettings.mockReset();
  mocks.saveWeeklyReportSettings.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.useWeeklyReportSettings.mockReturnValue({
    settings: { leadershipRecipientEmails: ["adam@example.com"], updatedAt: null },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mocks.saveWeeklyReportSettings.mockResolvedValue({ leadershipRecipientEmails: [], updatedAt: null });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => {
    root.render(<WeeklyReportSettingsDialog onClose={vi.fn()} />);
  });
}

/** The dialog renders through a portal, so its nodes live on document.body. */
function field(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Add a leadership recipient"]');
  if (!input) throw new Error("recipient input not found");
  return input;
}
function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  if (!match) throw new Error(`button ${label} not found`);
  return match as HTMLButtonElement;
}
function type(value: string) {
  const input = field();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("a typed-but-not-added recipient", () => {
  it("is included when the user clicks Save without clicking Add", async () => {
    // The data-loss bug: the address stayed in local draft state, Save sent the previous array, and
    // a success toast closed the dialog — telling the user their recipient was saved while it was
    // discarded, so the person they had just added would never receive the digest.
    render();
    type("takashi@example.com");
    await act(async () => {
      button("Save").click();
    });

    expect(mocks.saveWeeklyReportSettings).toHaveBeenCalledWith([
      "adam@example.com",
      "takashi@example.com",
    ]);
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it("reports a malformed pending address rather than dropping it", async () => {
    render();
    type("not-an-email");
    await act(async () => {
      button("Save").click();
    });

    expect(mocks.saveWeeklyReportSettings).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalled();
  });

  it("does not duplicate an address that is already listed", async () => {
    render();
    type("ADAM@example.com");
    await act(async () => {
      button("Save").click();
    });

    expect(mocks.saveWeeklyReportSettings).toHaveBeenCalledWith(["adam@example.com"]);
  });

  it("saves the list unchanged when nothing is pending", async () => {
    render();
    await act(async () => {
      button("Save").click();
    });

    expect(mocks.saveWeeklyReportSettings).toHaveBeenCalledWith(["adam@example.com"]);
  });
});
