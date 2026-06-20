/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForcePasswordChangeScreen } from "./force-password-change-screen";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { changePasswordMock, logoutMock } = vi.hoisted(() => ({
  changePasswordMock: vi.fn(),
  logoutMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { email: "ashaw@trockgc.com", displayName: "Adam Shaw" },
    changePassword: changePasswordMock,
    logout: logoutMock,
  }),
}));

let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<ForcePasswordChangeScreen />);
  });
  return container;
}

beforeEach(() => {
  changePasswordMock.mockReset();
  logoutMock.mockReset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

describe("ForcePasswordChangeScreen", () => {
  it("renders a hidden username field bound to the account email so password managers update the saved credential", () => {
    render();

    const username = container.querySelector<HTMLInputElement>('input[autocomplete="username"]');
    expect(username).not.toBeNull();
    expect(username?.value).toBe("ashaw@trockgc.com");
    expect(username?.readOnly).toBe(true);
  });

  it("lets the user unmask the new password to verify what they typed", () => {
    render();

    const newPassword = container.querySelector<HTMLInputElement>("#new-password");
    expect(newPassword?.type).toBe("password");

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Show new password"]');
    expect(toggle).not.toBeNull();

    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector<HTMLInputElement>("#new-password")?.type).toBe("text");
  });
});
