/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationRecipientsPage } from "./notification-recipients-page";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getNotificationRecipientGroup: vi.fn(),
  updateNotificationRecipientGroup: vi.fn(),
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
  useAdminUsers: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: mocks.toast,
}));

vi.mock("@/hooks/use-admin-users", () => ({
  useAdminUsers: mocks.useAdminUsers,
}));

vi.mock("@/hooks/use-lead-due-diligence", () => ({
  getNotificationRecipientGroup: mocks.getNotificationRecipientGroup,
  updateNotificationRecipientGroup: mocks.updateNotificationRecipientGroup,
}));

let container: HTMLDivElement;
let root: Root;

const users = [
  {
    id: "admin-1",
    email: "admin@example.com",
    displayName: "Admin User",
    role: "admin",
    officeId: "office-1",
    officeName: "Dallas",
    isActive: true,
    extraOfficeCount: 0,
    sourceSystems: [],
    localAuthStatus: "active",
    inviteSentAt: null,
    inviteExpiresAt: null,
    lastLoginAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    passwordChangedAt: null,
    revokedAt: null,
    latestLocalAuthEvent: null,
  },
  {
    id: "director-1",
    email: "director@example.com",
    displayName: "Director User",
    role: "director",
    officeId: "office-1",
    officeName: "Dallas",
    isActive: true,
    extraOfficeCount: 0,
    sourceSystems: [],
    localAuthStatus: "active",
    inviteSentAt: null,
    inviteExpiresAt: null,
    lastLoginAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    passwordChangedAt: null,
    revokedAt: null,
    latestLocalAuthEvent: null,
  },
  {
    id: "rep-1",
    email: "rep@example.com",
    displayName: "Rep User",
    role: "rep",
    officeId: "office-1",
    officeName: "Dallas",
    isActive: true,
    extraOfficeCount: 0,
    sourceSystems: [],
    localAuthStatus: "active",
    inviteSentAt: null,
    inviteExpiresAt: null,
    lastLoginAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    passwordChangedAt: null,
    revokedAt: null,
    latestLocalAuthEvent: null,
  },
];

const groupResponse = {
  group: {
    id: "group-1",
    key: "lead_due_diligence",
    name: "Lead Due Diligence",
    description: "Recipients who receive DD emails.",
  },
  recipients: [
    { userId: "director-1", email: "director@example.com", displayName: "Director User" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useAdminUsers.mockReturnValue({ users, loading: false, error: null });
  mocks.getNotificationRecipientGroup.mockResolvedValue(groupResponse);
  mocks.updateNotificationRecipientGroup.mockResolvedValue(groupResponse);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  vi.restoreAllMocks();
  container.remove();
});

async function renderPage() {
  await act(async () => {
    root.render(<NotificationRecipientsPage />);
  });
}

async function waitForLoaded() {
  await vi.waitFor(() => expect(container.textContent).toContain("Notification Recipients"));
  await vi.waitFor(() => expect(container.textContent).toContain("Admin User"));
}

function saveButton() {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    button.textContent?.includes("Save recipients") || button.textContent?.includes("Saving")
  );
}

function checkboxForUser(userId: string) {
  const labels = Array.from(container.querySelectorAll<HTMLLabelElement>("label"));
  const label = labels.find((candidate) => candidate.textContent?.includes(userId === "admin-1" ? "Admin User" : "Director User"));
  return label?.querySelector<HTMLInputElement>("input");
}

async function clickSave() {
  const button = saveButton();
  expect(button).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("NotificationRecipientsPage", () => {
  it("renders loading state initially", async () => {
    mocks.getNotificationRecipientGroup.mockReturnValue(new Promise(() => {}));

    await renderPage();

    expect(container.textContent).toContain("Loading notification recipients");
  });

  it("renders the active admin/director user list once loaded", async () => {
    await renderPage();
    await waitForLoaded();

    expect(container.textContent).toContain("Admin User");
    expect(container.textContent).toContain("Director User");
    expect(container.textContent).not.toContain("Rep User");
  });

  it("pre-selects existing recipients", async () => {
    await renderPage();
    await waitForLoaded();

    expect(checkboxForUser("director-1")?.checked).toBe(true);
    expect(checkboxForUser("admin-1")?.checked).toBe(false);
  });

  it("saves the selected recipient IDs", async () => {
    await renderPage();
    await waitForLoaded();
    const adminCheckbox = checkboxForUser("admin-1");

    await act(async () => {
      adminCheckbox?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await clickSave();

    expect(mocks.updateNotificationRecipientGroup).toHaveBeenCalledWith(
      "lead_due_diligence",
      expect.arrayContaining(["admin-1", "director-1"])
    );
  });

  it("shows success toast after save", async () => {
    await renderPage();
    await waitForLoaded();

    await clickSave();

    expect(mocks.toast.success).toHaveBeenCalledWith("Notification recipients updated");
  });

  it("shows error toast when save fails", async () => {
    mocks.updateNotificationRecipientGroup.mockRejectedValueOnce(new Error("Invalid user ID"));
    await renderPage();
    await waitForLoaded();

    await clickSave();

    expect(mocks.toast.error).toHaveBeenCalledWith("Failed to update recipients: Invalid user ID");
  });

  it("disables save while saving to prevent duplicate calls", async () => {
    let resolveSave!: (value: unknown) => void;
    mocks.updateNotificationRecipientGroup.mockReturnValueOnce(new Promise((resolve) => {
      resolveSave = resolve;
    }));
    await renderPage();
    await waitForLoaded();

    await act(async () => {
      saveButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(saveButton()?.disabled).toBe(true);
    await act(async () => {
      saveButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.updateNotificationRecipientGroup).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave(groupResponse);
    });
  });

  it("confirms before saving an empty recipient list", async () => {
    await renderPage();
    await waitForLoaded();

    await act(async () => {
      checkboxForUser("director-1")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await clickSave();

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Save with no recipients?"));
    expect(mocks.updateNotificationRecipientGroup).toHaveBeenCalledWith("lead_due_diligence", []);
  });

  it("does not save an empty recipient list when confirmation is declined", async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await renderPage();
    await waitForLoaded();

    await act(async () => {
      checkboxForUser("director-1")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await clickSave();

    expect(mocks.updateNotificationRecipientGroup).not.toHaveBeenCalled();
  });

  it("renders fetch errors instead of an empty user list", async () => {
    mocks.getNotificationRecipientGroup.mockRejectedValueOnce(new Error("network down"));

    await renderPage();
    await vi.waitFor(() => expect(container.textContent).toContain("Failed to load recipients: network down"));

    expect(container.textContent).not.toContain("Admin User");
    expect(container.textContent).toContain("Retry");
  });
});
