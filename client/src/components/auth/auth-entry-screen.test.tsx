/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import authEntrySource from "./auth-entry-screen.tsx?raw";
import { AuthEntryScreen } from "./auth-entry-screen";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { localLoginMock } = vi.hoisted(() => ({
  localLoginMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    localLogin: localLoginMock,
  }),
}));

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

describe("AuthEntryScreen source contract", () => {
  const source = normalize(authEntrySource);

  it("renders the branded split-screen CRM login copy", () => {
    expect(source).toContain("T Rock Construction CRM");
    expect(source).toContain("Built for how T Rock works.");
    expect(source).toContain("Lead to bid to project. One CRM, every office, every rep.");
    expect(source).toContain("Bid Board synced in real time");
    expect(source).toContain("Photos straight from the field");
    expect(source).toContain("DD approvals built in");
    expect(source).toContain("Sign in to your CRM.");
  });

  it("keeps the form as the only unauthenticated action surface", () => {
    expect(source).toContain("localLogin(email, password, returnTo)");
    expect(source).toContain('autoComplete="username"');
    expect(source).toContain('autoComplete="current-password"');
    expect(source).toContain('type="submit"');
    expect(source).not.toContain("/auth/dev/users");
    expect(source).not.toContain("/auth/dev/login");
    expect(source).not.toContain("Dev login");
    expect(source).not.toContain("Register");
    expect(source).not.toContain("Sign up");
  });
});

let container: HTMLDivElement;
let root: Root;

function renderAuthEntry(path = "/login") {
  window.history.pushState({}, "", path);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(<AuthEntryScreen />);
  });

  return container;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submitLogin(email = "test-admin@trock.test", password = "dev123!") {
  const form = container.querySelector("form");
  const emailInput = container.querySelector<HTMLInputElement>("#email");
  const passwordInput = container.querySelector<HTMLInputElement>("#password");
  if (!form || !emailInput || !passwordInput) throw new Error("Login form did not render");

  await act(async () => {
    setInputValue(emailInput, email);
    setInputValue(passwordInput, password);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  localLoginMock.mockReset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

describe("AuthEntryScreen form behavior", () => {
  it("submits local credentials with the returnTo query and does not redirect during must-change-password", async () => {
    localLoginMock.mockResolvedValue({ mustChangePassword: true, returnTo: "https://onboarding.trockcrm.com/cleanup" });
    renderAuthEntry("/login?returnTo=https%3A%2F%2Fonboarding.trockcrm.com%2Fcleanup");

    await submitLogin();

    expect(localLoginMock).toHaveBeenCalledWith(
      "test-admin@trock.test",
      "dev123!",
      "https://onboarding.trockcrm.com/cleanup",
    );
    expect(container.textContent).toContain("Sign In");
  });

  it("shows loading state while local login is pending", async () => {
    let resolveLogin: (value: { mustChangePassword: boolean }) => void = () => undefined;
    localLoginMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve;
      }),
    );
    renderAuthEntry();

    await submitLogin();

    const button = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Signing in...");

    await act(async () => {
      resolveLogin({ mustChangePassword: true });
      await Promise.resolve();
    });

    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toContain("Sign In");
  });

  it("renders the local login error clearly", async () => {
    localLoginMock.mockRejectedValue(new Error("Invalid email or password"));
    renderAuthEntry();

    await submitLogin("test-admin@trock.test", "wrong-password");

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Invalid email or password");
  });
});
