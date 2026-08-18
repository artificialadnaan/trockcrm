/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import authEntrySource from "./auth-entry-screen.tsx?raw";
import { AuthEntryScreen } from "./auth-entry-screen";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { localLoginMock, apiMock } = vi.hoisted(() => ({
  localLoginMock: vi.fn(),
  apiMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    localLogin: localLoginMock,
  }),
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
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

  it("self-serves the password reset instead of mailing an administrator", () => {
    expect(source).not.toContain("mailto:");
    expect(source).toContain("/auth/password-reset/request");
    // The TTL is quoted to the user, so it is pinned here as well as in the rendered-copy assertion below.
    expect(source).toContain("const RESET_LINK_TTL_MINUTES = 60;");
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

async function requestPasswordReset(email = "known@trockgc.com") {
  const trigger = Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Forgot password?"),
  );
  if (!trigger) throw new Error("Forgot-password trigger did not render");

  act(() => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  const emailInput = container.querySelector<HTMLInputElement>("#reset-email");
  const form = emailInput?.closest("form");
  if (!emailInput || !form) throw new Error("Reset request form did not render");

  await act(async () => {
    setInputValue(emailInput, email);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });

  return container.querySelector('[role="status"]')?.textContent ?? "";
}

beforeEach(() => {
  localLoginMock.mockReset();
  apiMock.mockReset();
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

  it("offers self-service password reset instead of the old admin mailto", () => {
    renderAuthEntry();

    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(container.textContent).toContain("Forgot password?");
    // The email field only appears once the user asks for it, so the default screen stays a single
    // sign-in form.
    expect(container.querySelector("#reset-email")).toBeNull();
  });

  it("lets the user unmask the password to verify what they typed", () => {
    renderAuthEntry();

    const password = container.querySelector<HTMLInputElement>("#password");
    expect(password?.type).toBe("password");

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Show password"]');
    expect(toggle).not.toBeNull();

    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector<HTMLInputElement>("#password")?.type).toBe("text");
  });
});

describe("AuthEntryScreen password reset request", () => {
  it("posts the address to the reset-request endpoint", async () => {
    apiMock.mockResolvedValue({ ok: true });
    renderAuthEntry();

    await requestPasswordReset("known@trockgc.com");

    expect(apiMock).toHaveBeenCalledWith("/auth/password-reset/request", {
      method: "POST",
      json: { email: "known@trockgc.com" },
    });
  });

  it("shows a byte-identical confirmation for a known address, an unknown address, and a failed request", async () => {
    // Anti-enumeration: the screen must not tell an attacker which addresses have accounts, so the
    // three outcomes have to be indistinguishable — including the network-failure path, where a
    // "couldn't send" message would itself be a signal.
    apiMock.mockResolvedValue({ ok: true });
    renderAuthEntry();
    const known = await requestPasswordReset("known@trockgc.com");

    act(() => {
      root.unmount();
    });
    container.remove();
    apiMock.mockRejectedValue(new Error("No account found for nobody@trockgc.com"));
    renderAuthEntry();
    const unknown = await requestPasswordReset("nobody@trockgc.com");

    act(() => {
      root.unmount();
    });
    container.remove();
    apiMock.mockRejectedValue(new TypeError("Failed to fetch"));
    renderAuthEntry();
    const offline = await requestPasswordReset("known@trockgc.com");

    expect(known).toContain("If that address has an account");
    expect(known).toContain("60 minutes");
    expect(unknown).toBe(known);
    expect(offline).toBe(known);
    expect(container.textContent).not.toContain("No account found");
    expect(container.textContent).not.toContain("Failed to fetch");
  });

  it("hides the email field once the request is acknowledged so the screen cannot be probed in place", async () => {
    apiMock.mockResolvedValue({ ok: true });
    renderAuthEntry();

    await requestPasswordReset();

    expect(container.querySelector("#reset-email")).toBeNull();
  });
});
