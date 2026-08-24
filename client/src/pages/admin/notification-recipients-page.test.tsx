/**
 * @vitest-environment jsdom
 */
import React, { StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_RECIPIENT_GROUPS } from "@trock-crm/shared/types";
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
  {
    id: "construction-1",
    email: "super@example.com",
    displayName: "Construction User",
    role: "construction",
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
    id: "retired-1",
    email: "retired@example.com",
    displayName: "Retired User",
    role: "rep",
    officeId: "office-1",
    officeName: "Dallas",
    isActive: false,
    extraOfficeCount: 0,
    sourceSystems: [],
    localAuthStatus: "revoked",
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

const DD_KEY = "lead_due_diligence";
const BID_KEY = "bid_due_date_report";

function groupResponseFor(key: string, overrides: Partial<GroupResponse> = {}): GroupResponse {
  const definition = NOTIFICATION_RECIPIENT_GROUPS.find((group) => group.key === key)!;
  // Only DD has anyone assigned, so the fixtures also cover an empty group rendering.
  const recipients =
    key === DD_KEY ? [{ userId: "director-1", email: "director@example.com", displayName: "Director User" }] : [];
  return {
    group: {
      id: `group-${key}`,
      key,
      name: definition.name,
      description: definition.description,
    },
    recipients,
    assignedUserIds: recipients.map((recipient) => recipient.userId),
    fallbackApplied: false,
    ...overrides,
  };
}

interface GroupResponse {
  group: { id: string; key: string; name: string; description: string };
  recipients: Array<{ userId: string; email: string; displayName: string }>;
  assignedUserIds: string[];
  fallbackApplied: boolean;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useAdminUsers.mockReturnValue({ users, loading: false, error: null });
  mocks.getNotificationRecipientGroup.mockImplementation(async (key: string) => groupResponseFor(key));
  mocks.updateNotificationRecipientGroup.mockImplementation(async (key: string) => groupResponseFor(key));
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
  // Sections render immediately now, each with its own spinner, so wait for the pickers themselves.
  await vi.waitFor(() => expect(checkboxFor(DD_KEY, "Admin User")).toBeTruthy());
  await vi.waitFor(() => expect(checkboxFor(BID_KEY, "Rep User")).toBeTruthy());
}

function sectionFor(key: string) {
  return container.querySelector<HTMLElement>(`[data-group-key="${key}"]`);
}

function saveButtonFor(key: string) {
  return Array.from(sectionFor(key)?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) =>
    button.textContent?.includes("Save recipients") || button.textContent?.includes("Saving")
  );
}

function checkboxFor(key: string, displayName: string) {
  const labels = Array.from(sectionFor(key)?.querySelectorAll<HTMLLabelElement>("label") ?? []);
  return labels.find((candidate) => candidate.textContent?.includes(displayName))?.querySelector<HTMLInputElement>("input");
}

async function clickSave(key: string) {
  const button = saveButtonFor(key);
  expect(button).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("NotificationRecipientsPage", () => {
  it("renders loading state while the assignable user list is still loading", async () => {
    mocks.useAdminUsers.mockReturnValue({ users: [], loading: true, error: null });

    await renderPage();

    expect(container.textContent).toContain("Loading notification recipients");
  });

  it("renders each group's own loading state rather than gating the page on the slowest one", async () => {
    // Codex P2: a global `Promise.all` gate meant one hung request took the whole page down with it,
    // which defeats the per-group isolation the error path already had.
    mocks.getNotificationRecipientGroup.mockImplementation(async (key: string) => {
      if (key === DD_KEY) return new Promise<never>(() => {});
      return groupResponseFor(key);
    });

    await renderPage();
    await vi.waitFor(() => expect(checkboxFor(BID_KEY, "Rep User")).toBeTruthy());

    expect(sectionFor(DD_KEY)?.textContent).toContain("Loading recipients");
    expect(saveButtonFor(BID_KEY)).toBeTruthy();
  });

  it("renders one section per registered group, titled from the registry", async () => {
    await renderPage();
    await waitForLoaded();

    for (const definition of NOTIFICATION_RECIPIENT_GROUPS) {
      const section = sectionFor(definition.key);
      expect(section, `no section for ${definition.key}`).toBeTruthy();
      expect(section?.textContent).toContain(definition.name);
      expect(section?.textContent).toContain(definition.description);
    }
    expect(mocks.getNotificationRecipientGroup).toHaveBeenCalledTimes(NOTIFICATION_RECIPIENT_GROUPS.length);
  });

  it("offers every ACTIVE user, reps included — one upcoming report goes to an estimator", async () => {
    await renderPage();
    await waitForLoaded();

    const section = sectionFor(BID_KEY);
    expect(section?.textContent).toContain("Admin User");
    expect(section?.textContent).toContain("Director User");
    expect(section?.textContent).toContain("Rep User");
    // Deactivated accounts are still not assignable — that filter was never the bug.
    expect(section?.textContent).not.toContain("Retired User");
  });

  it("offers only admins and directors for due diligence — membership there is a permission", async () => {
    // DD recipients are mailed a decision token that authenticates on its own and is never audited, so
    // widening the picker for the bid report must not have widened this one too.
    await renderPage();
    await waitForLoaded();

    const section = sectionFor(DD_KEY);
    expect(section?.textContent).toContain("Admin User");
    expect(section?.textContent).toContain("Director User");
    expect(section?.textContent).not.toContain("Rep User");
    expect(section?.textContent).not.toContain("Construction User");
  });

  it("does not pre-tick fallback recipients — a stray Save would freeze the fallback into a static list", async () => {
    mocks.getNotificationRecipientGroup.mockImplementation(async (key: string) =>
      key === DD_KEY
        ? groupResponseFor(key, {
            recipients: [
              { userId: "admin-1", email: "admin@example.com", displayName: "Admin User" },
              { userId: "director-1", email: "director@example.com", displayName: "Director User" },
            ],
            assignedUserIds: [],
            fallbackApplied: true,
          })
        : groupResponseFor(key),
    );

    await renderPage();
    await waitForLoaded();

    expect(checkboxFor(DD_KEY, "Admin User")?.checked).toBe(false);
    expect(checkboxFor(DD_KEY, "Director User")?.checked).toBe(false);
    // It still has to SAY who would be mailed today, or the page reads as "nobody gets these".
    expect(sectionFor(DD_KEY)?.textContent).toContain("admin@example.com");
    expect(sectionFor(DD_KEY)?.textContent).toMatch(/no one is assigned/i);
  });

  it("gives every section an accessible name", async () => {
    // With all active users offered, a screen-reader user meets 3xN checkboxes with identical names and
    // nothing saying which group they belong to.
    await renderPage();
    await waitForLoaded();

    for (const definition of NOTIFICATION_RECIPIENT_GROUPS) {
      const section = sectionFor(definition.key);
      const labelledBy = section?.getAttribute("aria-labelledby");
      expect(labelledBy, `${definition.key} has no aria-labelledby`).toBeTruthy();
      expect(section?.querySelector(`#${labelledBy}`)?.textContent).toBe(definition.name);
    }
  });

  it("pre-selects each group's existing recipients independently", async () => {
    await renderPage();
    await waitForLoaded();

    expect(checkboxFor(DD_KEY, "Director User")?.checked).toBe(true);
    expect(checkboxFor(DD_KEY, "Admin User")?.checked).toBe(false);
    // A recipient of one group is not a recipient of another.
    expect(checkboxFor(BID_KEY, "Director User")?.checked).toBe(false);
  });

  it("saves the selected recipient IDs against the group whose button was pressed", async () => {
    await renderPage();
    await waitForLoaded();

    await act(async () => {
      checkboxFor(DD_KEY, "Admin User")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await clickSave(DD_KEY);

    expect(mocks.updateNotificationRecipientGroup).toHaveBeenCalledWith(
      DD_KEY,
      expect.arrayContaining(["admin-1", "director-1"])
    );
  });

  it("can assign a rep to the bid due date report", async () => {
    await renderPage();
    await waitForLoaded();

    await act(async () => {
      checkboxFor(BID_KEY, "Rep User")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await clickSave(BID_KEY);

    expect(mocks.updateNotificationRecipientGroup).toHaveBeenCalledWith(BID_KEY, ["rep-1"]);
  });

  it("shows success toast after save", async () => {
    await renderPage();
    await waitForLoaded();

    await clickSave(DD_KEY);

    expect(mocks.toast.success).toHaveBeenCalledWith("Notification recipients updated");
  });

  it("shows error toast when save fails", async () => {
    mocks.updateNotificationRecipientGroup.mockRejectedValueOnce(new Error("Invalid user ID"));
    await renderPage();
    await waitForLoaded();

    await clickSave(DD_KEY);

    expect(mocks.toast.error).toHaveBeenCalledWith("Failed to update recipients: Invalid user ID");
  });

  it("disables the save button while that group is saving", async () => {
    let resolveSave!: (value: unknown) => void;
    mocks.updateNotificationRecipientGroup.mockReturnValueOnce(new Promise((resolve) => {
      resolveSave = resolve;
    }));
    await renderPage();
    await waitForLoaded();

    await act(async () => {
      saveButtonFor(DD_KEY)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(saveButtonFor(DD_KEY)?.disabled).toBe(true);
    // The OTHER groups stay usable — one slow save must not freeze the page.
    expect(saveButtonFor(BID_KEY)?.disabled).toBe(false);

    await act(async () => {
      resolveSave(groupResponseFor(DD_KEY));
    });
  });

  it("sends ONE request for two clicks landing in the same batch", async () => {
    // The `disabled` attribute cannot cover this: both clicks are dispatched before React re-renders, so
    // the button is still enabled for the second. A render-scoped `state.saving` check cannot either —
    // its closure still reads `saving: false`. Only an in-flight ref stops the duplicate write.
    let resolveSave!: (value: unknown) => void;
    mocks.updateNotificationRecipientGroup.mockReturnValueOnce(new Promise((resolve) => {
      resolveSave = resolve;
    }));
    await renderPage();
    await waitForLoaded();

    await act(async () => {
      const button = saveButtonFor(DD_KEY);
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.updateNotificationRecipientGroup).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave(groupResponseFor(DD_KEY));
    });
  });

  it("discards a superseded effect run's response instead of letting it overwrite the current one", async () => {
    // Codex P2: under StrictMode the effect is set up, torn down and set up again. A single shared
    // `cancelled` ref is reset to false by the second setup, so the FIRST run's outstanding request comes
    // back alive and overwrites the newer result — or an edit the admin has already made.
    const resolvers: Array<() => void> = [];
    let call = 0;
    mocks.getNotificationRecipientGroup.mockImplementation((key: string) => {
      const mine = ++call;
      return new Promise((resolve) => {
        resolvers.push(() =>
          resolve(
            groupResponseFor(key, {
              // Run 1 answers with the STALE list; run 2 with the current one.
              assignedUserIds: mine <= NOTIFICATION_RECIPIENT_GROUPS.length ? ["admin-1"] : ["director-1"],
            }),
          ),
        );
      });
    });

    await act(async () => {
      root.render(
        <StrictMode>
          <NotificationRecipientsPage />
        </StrictMode>,
      );
    });

    // Resolve the SECOND run first, then let the superseded first run answer late.
    await act(async () => {
      resolvers.slice(NOTIFICATION_RECIPIENT_GROUPS.length).forEach((resolve) => resolve());
    });
    await act(async () => {
      resolvers.slice(0, NOTIFICATION_RECIPIENT_GROUPS.length).forEach((resolve) => resolve());
    });

    expect(checkboxFor(DD_KEY, "Director User")?.checked).toBe(true);
    expect(checkboxFor(DD_KEY, "Admin User")?.checked).toBe(false);
  });

  it("confirms before saving an empty recipient list, naming what stops arriving", async () => {
    const definition = NOTIFICATION_RECIPIENT_GROUPS.find((group) => group.key === DD_KEY)!;
    await renderPage();
    await waitForLoaded();

    await act(async () => {
      checkboxFor(DD_KEY, "Director User")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await clickSave(DD_KEY);

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Save with no recipients?"));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining(definition.emptyWarning));
    expect(mocks.updateNotificationRecipientGroup).toHaveBeenCalledWith(DD_KEY, []);
  });

  it("does not save an empty recipient list when confirmation is declined", async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await renderPage();
    await waitForLoaded();

    await act(async () => {
      checkboxFor(DD_KEY, "Director User")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await clickSave(DD_KEY);

    expect(mocks.updateNotificationRecipientGroup).not.toHaveBeenCalled();
  });

  it("renders fetch errors instead of an empty user list", async () => {
    mocks.getNotificationRecipientGroup.mockRejectedValue(new Error("network down"));

    await renderPage();
    await vi.waitFor(() => expect(container.textContent).toContain("Failed to load recipients: network down"));

    expect(container.textContent).not.toContain("Admin User");
    expect(container.textContent).not.toContain("Rep User");
    expect(container.textContent).toContain("Retry");
  });

  it("keeps the healthy groups usable when one group's fetch fails", async () => {
    mocks.getNotificationRecipientGroup.mockImplementation(async (key: string) => {
      if (key === DD_KEY) throw new Error("network down");
      return groupResponseFor(key);
    });

    await renderPage();
    await vi.waitFor(() => expect(sectionFor(BID_KEY)).toBeTruthy());

    expect(sectionFor(DD_KEY)?.textContent).toContain("Failed to load recipients: network down");
    expect(checkboxFor(BID_KEY, "Rep User")).toBeTruthy();
  });
});
