/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcceptInvitePage } from "./AcceptInvitePage";

const authMock = vi.hoisted(() => ({
  user: null as unknown,
  acceptInvite: vi.fn(),
  previewInvite: vi.fn(),
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
  authMock.acceptInvite.mockReset();
  authMock.previewInvite.mockReset();
});

function renderPage(entry: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<MemoryRouter initialEntries={[entry]}><AcceptInvitePage /></MemoryRouter>);
  return container;
}

function changeInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AcceptInvitePage", () => {
  it("shows invalid link state when token is missing", async () => {
    const node = renderPage("/accept-invite");
    await vi.waitFor(() => expect(node.textContent).toContain("This invite link is invalid"));
    expect(authMock.previewInvite).not.toHaveBeenCalled();
  });

  it("previews invite, validates password confirmation, and submits", async () => {
    authMock.previewInvite.mockResolvedValue({ firstName: "Field", lastName: "User", email: "field@example.com" });
    authMock.acceptInvite.mockResolvedValue(undefined);
    const node = renderPage("/accept-invite?token=raw-token");

    await vi.waitFor(() => expect(authMock.previewInvite).toHaveBeenCalledWith("raw-token"));
    await vi.waitFor(() => expect(node.textContent).toContain("field@example.com"));

    changeInput(node.querySelector<HTMLInputElement>('[name="password"]')!, "password-123");
    changeInput(node.querySelector<HTMLInputElement>('[name="confirmPassword"]')!, "different");
    node.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Passwords do not match."));

    changeInput(node.querySelector<HTMLInputElement>('[name="confirmPassword"]')!, "password-123");
    node.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await vi.waitFor(() => expect(authMock.acceptInvite).toHaveBeenCalledWith("raw-token", "password-123"));
  });

  it("renders a hidden username field bound to the invite email so password managers save the credential", async () => {
    authMock.previewInvite.mockResolvedValue({ firstName: "Field", lastName: "User", email: "field@example.com" });
    const node = renderPage("/accept-invite?token=raw-token");

    await vi.waitFor(() => expect(node.querySelector('[name="password"]')).not.toBeNull());

    const username = node.querySelector<HTMLInputElement>('input[autocomplete="username"]');
    expect(username).not.toBeNull();
    expect(username?.value).toBe("field@example.com");
    expect(username?.readOnly).toBe(true);
  });

  it("lets the user unmask the new password to verify what they typed", async () => {
    authMock.previewInvite.mockResolvedValue({ firstName: "Field", lastName: "User", email: "field@example.com" });
    const node = renderPage("/accept-invite?token=raw-token");

    await vi.waitFor(() => expect(node.querySelector('[name="password"]')).not.toBeNull());
    expect(node.querySelector<HTMLInputElement>('[name="password"]')?.getAttribute("type")).toBe("password");

    const toggle = node.querySelector<HTMLButtonElement>('button[aria-label="Show password"]');
    expect(toggle).not.toBeNull();
    toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() =>
      expect(node.querySelector<HTMLInputElement>('[name="password"]')?.getAttribute("type")).toBe("text"),
    );
  });
});
