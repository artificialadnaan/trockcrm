// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLogForm } from "./activity-log-form";

type ActivityLogSubmitData = Parameters<React.ComponentProps<typeof ActivityLogForm>["onSubmit"]>[0];
type ActivityLogSubmit = React.ComponentProps<typeof ActivityLogForm>["onSubmit"];

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mountActivityLogForm(props: Partial<React.ComponentProps<typeof ActivityLogForm>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  const onSubmit = props.onSubmit ?? vi.fn(async () => undefined);

  act(() => {
    root = createRoot(container);
    root.render(<ActivityLogForm onSubmit={onSubmit} {...props} />);
  });

  return {
    container,
    onSubmit,
    unmount() {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

function click(element: Element | null) {
  expect(element).toBeTruthy();
  act(() => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function change(element: Element | null, value: string) {
  expect(element).toBeTruthy();
  act(() => {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    const prototype = input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ActivityLogForm email logging", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T15:30:00.000Z"));
    mocks.useAuthMock.mockReturnValue({
      user: { id: "rep-1", displayName: "Sales Rep" },
    });
    mocks.apiMock.mockResolvedValue({
      users: [{ id: "rep-1", displayName: "Sales Rep" }],
    });
  });

  it("shows a Log Email action and opens the email form with the current date/time", async () => {
    const { container, unmount } = mountActivityLogForm();

    click(container.querySelector("button[aria-label='Log Email']"));

    expect(container.textContent).toContain("Email details");
    expect(container.querySelector("input[name='emailSubject']")).toBeTruthy();
    expect(container.querySelector("input[name='emailFrom']")).toBeTruthy();
    expect(container.querySelector("input[name='emailTo']")).toBeTruthy();
    expect(container.querySelector("textarea[name='emailBody']")).toBeTruthy();
    expect((container.querySelector("input[name='emailOccurredAt']") as HTMLInputElement).value).toBe("2026-05-18T10:30");

    unmount();
  });

  it("requires subject and submits an email activity payload with optional address fields and occurredAt", async () => {
    const onSubmit = vi.fn<ActivityLogSubmit>(async (_data: ActivityLogSubmitData) => undefined);
    const { container, unmount } = mountActivityLogForm({ onSubmit });

    click(container.querySelector("button[aria-label='Log Email']"));
    change(container.querySelector("input[name='emailFrom']"), "rep@trock.test");
    change(container.querySelector("input[name='emailTo']"), "customer@example.com");
    change(container.querySelector("textarea[name='emailBody']"), "Followed up from my phone.");

    click(container.querySelector("button[data-testid='activity-save']"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Subject is required");

    change(container.querySelector("input[name='emailSubject']"), "Roof scope follow-up");
    change(container.querySelector("input[name='emailOccurredAt']"), "2026-05-18T09:15");

    await act(async () => {
      container.querySelector("button[data-testid='activity-save']")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "email",
        subject: "Roof scope follow-up",
        body: expect.stringContaining("From: rep@trock.test"),
        occurredAt: new Date("2026-05-18T09:15").toISOString(),
      })
    );
    const submitted = onSubmit.mock.calls[0]?.[0];
    expect(submitted?.body).toContain("To: customer@example.com");
    expect(submitted?.body).toContain("Notes: Followed up from my phone.");

    unmount();
  });
});

describe("ActivityLogForm responsible owner display", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T15:30:00.000Z"));
  });

  it("shows the responsible owner's name, not their raw user id, when multiple assignees exist", async () => {
    const ownerId = "5687a3c6-1556-4dd6-a3d6-b26fbc22f471";
    mocks.useAuthMock.mockReturnValue({
      user: { id: ownerId, displayName: "Jordan Rivera" },
    });
    mocks.apiMock.mockResolvedValue({
      users: [
        { id: ownerId, displayName: "Jordan Rivera" },
        { id: "casey-2", displayName: "Casey Lee" },
      ],
    });

    const { container, unmount } = mountActivityLogForm();

    // Let GET /tasks/assignees resolve so the multi-owner dropdown renders.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const logCall = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Log Call")
    );
    click(logCall ?? null);

    const ownerLabel = [...container.querySelectorAll("label")].find(
      (label) => label.textContent === "Responsible owner"
    );
    expect(ownerLabel, "Responsible owner field should render with >1 assignee").toBeTruthy();

    const ownerTrigger = ownerLabel!.parentElement?.querySelector(
      "[data-slot='select-trigger']"
    );
    expect(ownerTrigger, "owner select trigger should render").toBeTruthy();

    // The trigger must display the human name, never the raw user UUID.
    expect(ownerTrigger!.textContent).toContain("Jordan Rivera");
    expect(ownerTrigger!.textContent).not.toContain(ownerId);

    unmount();
  });
});

describe("ActivityLogForm call outcome display", () => {
  beforeEach(() => {
    // This dropdown is exercised by opening a real Base UI Select popup, which
    // touches DOM APIs jsdom does not implement. Real timers + these stubs let
    // the popup mount so an item can be selected.
    vi.useRealTimers();

    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    if (typeof proto.scrollIntoView !== "function") proto.scrollIntoView = vi.fn();
    if (typeof proto.hasPointerCapture !== "function") proto.hasPointerCapture = vi.fn(() => false);
    if (typeof proto.setPointerCapture !== "function") proto.setPointerCapture = vi.fn();
    if (typeof proto.releasePointerCapture !== "function") proto.releasePointerCapture = vi.fn();
    const globals = globalThis as { ResizeObserver?: unknown };
    if (typeof globals.ResizeObserver !== "function") {
      globals.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }

    mocks.useAuthMock.mockReturnValue({
      user: { id: "rep-1", displayName: "Sales Rep" },
    });
    mocks.apiMock.mockResolvedValue({
      users: [{ id: "rep-1", displayName: "Sales Rep" }],
    });
  });

  it("shows the chosen outcome's label, not its raw enum value", async () => {
    const { container, unmount } = mountActivityLogForm();

    // Let the assignees fetch settle so no state updates escape act().
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The Outcome <Select> only renders for calls.
    const logCall = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Log Call")
    );
    click(logCall ?? null);

    const outcomeLabel = [...container.querySelectorAll("label")].find(
      (label) => label.textContent === "Outcome"
    );
    expect(outcomeLabel, "Outcome field should render for a call").toBeTruthy();

    const outcomeTrigger = outcomeLabel!.parentElement?.querySelector(
      "[data-slot='select-trigger']"
    );
    expect(outcomeTrigger, "outcome select trigger should render").toBeTruthy();

    // Open the dropdown.
    (outcomeTrigger as HTMLElement).focus();
    await act(async () => {
      outcomeTrigger!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      outcomeTrigger!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      outcomeTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Pick "Left Voicemail" (raw value "left_voicemail").
    const voicemailOption = [
      ...document.querySelectorAll("[data-slot='select-item']"),
    ].find((item) => item.textContent?.includes("Left Voicemail"));
    expect(
      voicemailOption,
      "Left Voicemail option should render once the dropdown is open"
    ).toBeTruthy();

    // Base UI only commits a mouse click on the "highlighted" (active) item.
    // Hover + focus the item to highlight it, then click to commit.
    await act(async () => {
      voicemailOption!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      voicemailOption!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      (voicemailOption as HTMLElement).focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      voicemailOption!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The trigger must display the human-readable label, never the raw value.
    const triggerAfter = outcomeLabel!.parentElement?.querySelector(
      "[data-slot='select-trigger']"
    );
    expect(triggerAfter!.textContent).toContain("Left Voicemail");
    expect(triggerAfter!.textContent).not.toContain("left_voicemail");

    unmount();
  });
});
