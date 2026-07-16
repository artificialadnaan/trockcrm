/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResetPasswordPage } from "./ResetPasswordPage";

const apiMock = vi.hoisted(() => vi.fn());
const TEST_CREDENTIAL = "<redacted - test creds in ops vault>";

vi.mock("../lib/api", () => ({ api: apiMock }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  apiMock.mockReset();
});

function renderPage(entry: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <MemoryRouter initialEntries={[entry]}>
      <ResetPasswordPage />
    </MemoryRouter>,
  );
  return container;
}

function changeInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ResetPasswordPage", () => {
  it("shows an invalid-link state when the token is missing", async () => {
    const node = renderPage("/reset-password");

    await vi.waitFor(() => expect(node.textContent).toContain("invalid or has expired"));
    expect(apiMock).not.toHaveBeenCalled();
    expect(node.querySelector<HTMLAnchorElement>('a[href="/"]')?.textContent).toContain("Return to Sign In");
  });

  it("previews the account, validates the password, and completes the reset", async () => {
    apiMock
      .mockResolvedValueOnce({ firstName: "Kevin", lastName: "Posey", email: "kposey@trockcontracting.com" })
      .mockResolvedValueOnce({ success: true });

    const node = renderPage("/reset-password?token=raw-token");

    await vi.waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/auth/field-password-reset-preview?token=raw-token", {
        signal: expect.any(AbortSignal),
      }),
    );
    await vi.waitFor(() => expect(node.textContent).toContain("kposey@trockcontracting.com"));

    changeInput(node.querySelector<HTMLInputElement>('[name="password"]')!, "short");
    changeInput(node.querySelector<HTMLInputElement>('[name="confirmPassword"]')!, "short");
    node.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();

    await vi.waitFor(() => expect(node.textContent).toContain("Password must be at least 12 characters."));
    expect(apiMock).toHaveBeenCalledTimes(1);

    changeInput(node.querySelector<HTMLInputElement>('[name="password"]')!, TEST_CREDENTIAL);
    changeInput(node.querySelector<HTMLInputElement>('[name="confirmPassword"]')!, "different-value");
    node.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();

    await vi.waitFor(() => expect(node.textContent).toContain("Passwords do not match."));
    expect(apiMock).toHaveBeenCalledTimes(1);

    changeInput(node.querySelector<HTMLInputElement>('[name="confirmPassword"]')!, TEST_CREDENTIAL);
    node.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();

    await vi.waitFor(() =>
      expect(apiMock).toHaveBeenLastCalledWith("/auth/field-password-reset", {
        method: "POST",
        json: { token: "raw-token", newPassword: TEST_CREDENTIAL },
      }),
    );
    await vi.waitFor(() => expect(node.textContent).toContain("You can now sign in to T-Rock Cam"));
    expect(node.querySelector<HTMLAnchorElement>('a[href="/"]')?.textContent).toContain("Return to Sign In");
  });

  it("binds the account email to a hidden username field for password managers", async () => {
    apiMock.mockResolvedValueOnce({
      firstName: "Kevin",
      lastName: "Posey",
      email: "kposey@trockcontracting.com",
    });
    const node = renderPage("/reset-password?token=raw-token");

    await vi.waitFor(() => expect(node.querySelector('[name="password"]')).not.toBeNull());

    const username = node.querySelector<HTMLInputElement>('input[autocomplete="username"]');
    expect(username?.value).toBe("kposey@trockcontracting.com");
    expect(username?.readOnly).toBe(true);
  });

  it("shows preview failures and does not render the password form", async () => {
    apiMock.mockRejectedValueOnce(new Error("Reset link has expired"));
    const node = renderPage("/reset-password?token=expired-token");

    await vi.waitFor(() => expect(node.textContent).toContain("Reset link has expired"));
    expect(node.querySelector('[name="password"]')).toBeNull();
  });
});
