/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

const authMock = vi.hoisted(() => ({
  user: null as unknown,
  login: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  useAuth: () => authMock,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  authMock.user = null;
  authMock.login.mockReset();
});

function renderPage() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<MemoryRouter><LoginPage /></MemoryRouter>);
  return container;
}

function changeInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("LoginPage", () => {
  it("validates and submits field login credentials", async () => {
    authMock.login.mockResolvedValue(undefined);
    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("Sign in"));
    expect(node.querySelector('img[alt="T Rock Construction"]')).toBeTruthy();
    expect(node.querySelector('[data-brand-logo-surface="dark"]')).toBeTruthy();
    node.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(node.textContent).toContain("Email and password are required."));

    changeInput(node.querySelector<HTMLInputElement>('[name="email"]')!, "field@example.com");
    changeInput(node.querySelector<HTMLInputElement>('[name="password"]')!, "password-123");
    node.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(authMock.login).toHaveBeenCalledWith("field@example.com", "password-123"));
  });

  it("renders inline login errors", async () => {
    authMock.login.mockRejectedValue(new Error("Invalid email or password"));
    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("Sign in"));
    changeInput(node.querySelector<HTMLInputElement>('[name="email"]')!, "field@example.com");
    changeInput(node.querySelector<HTMLInputElement>('[name="password"]')!, "bad-password");
    node.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(node.textContent).toContain("Invalid email or password"));
  });

  it("lets the user unmask the password to verify what they typed", async () => {
    const node = renderPage();
    await vi.waitFor(() => expect(node.textContent).toContain("Sign in"));

    const password = node.querySelector<HTMLInputElement>('[name="password"]');
    expect(password?.getAttribute("type")).toBe("password");

    const toggle = node.querySelector<HTMLButtonElement>('button[aria-label="Show password"]');
    expect(toggle).not.toBeNull();
    toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() =>
      expect(node.querySelector<HTMLInputElement>('[name="password"]')?.getAttribute("type")).toBe("text"),
    );
  });

  it("renders the forgot-password admin contact as a real mailto link (no self-service reset exists)", async () => {
    const node = renderPage();
    await vi.waitFor(() => expect(node.querySelector('a[href^="mailto:aiqbal@trockgc.com"]')).not.toBeNull());
    const link = node.querySelector<HTMLAnchorElement>('a[href^="mailto:aiqbal@trockgc.com"]');
    expect(link?.textContent).toContain("Contact your administrator");
    expect(node.textContent).toContain("Forgot password?");
  });
});
