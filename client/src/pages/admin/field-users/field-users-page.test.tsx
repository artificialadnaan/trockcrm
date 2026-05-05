/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldUsersPage } from "./field-users-page";

const apiMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("sonner", () => ({ toast: toastMock }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  apiMock.mockReset();
  vi.clearAllMocks();
});

function renderPage(initialEntry = "/admin/field-users") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <FieldUsersPage />
    </MemoryRouter>
  );
  return container;
}

function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("FieldUsersPage", () => {
  it("renders field users, serializes filters, sends invites, and triggers actions", async () => {
    apiMock.mockImplementation(async (path: string, options?: { method?: string; json?: Record<string, unknown> }) => {
      if (path.startsWith("/admin/field-users?")) {
        return {
          users: [{
            id: "invite-1",
            userId: null,
            inviteId: "invite-1",
            email: "field@example.com",
            firstName: "Field",
            lastName: "User",
            phone: "555-1234",
            active: false,
            createdAt: "2026-05-05T12:00:00.000Z",
            lastLoginAt: null,
            inviteStatus: "pending",
            invitedBy: { id: "admin-1", name: "Admin User" },
            invitedAt: "2026-05-05T12:00:00.000Z",
            acceptedAt: null,
            expiresAt: "2026-05-12T12:00:00.000Z",
          }],
          total: 1,
          page: 1,
          perPage: 25,
        };
      }
      if (path === "/admin/field-users/invite" && options?.method === "POST") {
        return { invite: { id: "invite-2", email: options.json?.email, expiresAt: "2026-05-12T12:00:00.000Z" } };
      }
      if (path.includes("/resend-invite") || path.includes("/revoke") || path.includes("/deactivate") || path.includes("/reactivate")) {
        return { success: true, user: { id: "field-1", active: false }, invite: { id: "invite-1" } };
      }
      return {};
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const node = renderPage("/admin/field-users?status=pending-invite");
    await vi.waitFor(() => expect(node.textContent).toContain("Field Users"));
    await vi.waitFor(() => expect(node.textContent).toContain("field@example.com"));
    expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("status=pending-invite"));

    changeInput(node.querySelector<HTMLInputElement>('[placeholder="Search field users"]')!, "field");
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("search=field")));

    node.querySelector<HTMLButtonElement>('[aria-label="Invite field user"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Invite User"));
    changeInput(document.body.querySelector<HTMLInputElement>('[name="email"]')!, "new@example.com");
    changeInput(document.body.querySelector<HTMLInputElement>('[name="firstName"]')!, "New");
    changeInput(document.body.querySelector<HTMLInputElement>('[name="lastName"]')!, "User");
    document.body.querySelector<HTMLButtonElement>('[aria-label="Send field user invite"]')?.click();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/admin/field-users/invite", expect.objectContaining({
      method: "POST",
      json: expect.objectContaining({ email: "new@example.com", firstName: "New", lastName: "User" }),
    })));
    expect(toastMock.success).toHaveBeenCalledWith("Invite sent to new@example.com");

    node.querySelector<HTMLButtonElement>('[aria-label="Resend invite"]')?.click();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/admin/field-users/invite-1/resend-invite", { method: "POST" }));

    node.querySelector<HTMLButtonElement>('[aria-label="Cancel invite"]')?.click();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/admin/field-users/invites/invite-1/revoke", { method: "POST" }));
  });
});
