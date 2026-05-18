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
