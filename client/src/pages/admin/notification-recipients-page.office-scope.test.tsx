/**
 * @vitest-environment jsdom
 *
 * `effectiveRole` is selected by the `?officeId` tenant scope. This is intentionally a page-level
 * regression rather than a mocked-hook test: an office switch keeps this route mounted, so both the
 * users read and the recipient-group read have to move together or Save can write Office A's ids into
 * Office B.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_RECIPIENT_GROUPS } from "@trock-crm/shared/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: mocks.api }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

const { NotificationRecipientsPage } = await import("./notification-recipients-page");

const DD_KEY = "lead_due_diligence";

const officeAApprover = {
  id: "office-a-approver",
  email: "office-a@example.com",
  displayName: "Office A Approver",
  // Their home role is deliberately not enough for the permission group. The selected-office response
  // lifts them to admin in Office A.
  role: "rep" as const,
  effectiveRole: "admin" as const,
  officeId: "office-a",
  officeName: "Office A",
  isActive: true,
  extraOfficeCount: 0,
  sourceSystems: [] as Array<"hubspot" | "procore">,
  localAuthStatus: "active" as const,
  inviteSentAt: null,
  inviteExpiresAt: null,
  lastLoginAt: null,
  failedLoginAttempts: 0,
  lockedUntil: null,
  passwordChangedAt: null,
  revokedAt: null,
  latestLocalAuthEvent: null,
};

const officeBApprover = {
  ...officeAApprover,
  id: "office-b-approver",
  email: "office-b@example.com",
  displayName: "Office B Approver",
  effectiveRole: "director" as const,
  officeId: "office-b",
  officeName: "Office B",
};

function groupResponseFor(key: string, assignedUserId: string | null, email: string, displayName: string) {
  const definition = NOTIFICATION_RECIPIENT_GROUPS.find((group) => group.key === key)!;
  const assigned = key === DD_KEY && assignedUserId !== null;
  return {
    group: {
      id: `group-${key}`,
      key,
      name: definition.name,
      description: definition.description,
    },
    recipients: assigned ? [{ userId: assignedUserId, email, displayName }] : [],
    assignedUserIds: assigned ? [assignedUserId] : [],
    fallbackApplied: false,
  };
}

let container: HTMLDivElement;
let root: Root;
let navigateTo: (to: string) => void;

function NavigationHandle() {
  navigateTo = useNavigate();
  return null;
}

function sectionFor(key: string) {
  return container.querySelector<HTMLElement>(`[data-group-key="${key}"]`);
}

function checkboxFor(key: string, displayName: string) {
  const labels = Array.from(sectionFor(key)?.querySelectorAll<HTMLLabelElement>("label") ?? []);
  return labels.find((candidate) => candidate.textContent?.includes(displayName))?.querySelector<HTMLInputElement>("input");
}

function saveButtonFor(key: string) {
  return Array.from(sectionFor(key)?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) =>
    button.textContent?.includes("Save recipients") || button.textContent?.includes("Saving")
  );
}

async function renderPage() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/admin/notification-recipients?officeId=office-a"]}>
        <NavigationHandle />
        <NotificationRecipientsPage />
      </MemoryRouter>,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  navigateTo = () => {
    throw new Error("NavigationHandle has not rendered");
  };
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("NotificationRecipientsPage office scope", () => {
  it("reloads effective roles and resets Office A assignments before Office B can save", async () => {
    let userReads = 0;
    const groupReads = new Map<string, number>();
    const officeBGroupResolvers: Array<() => void> = [];

    mocks.api.mockImplementation((path: string, options?: { method?: string; json?: unknown }) => {
      if (path === "/admin/users") {
        userReads += 1;
        return Promise.resolve({ users: userReads === 1 ? [officeAApprover] : [officeBApprover] });
      }

      if (path.endsWith("/assignments")) {
        const pathSegments = path.split("/");
        const key = pathSegments[pathSegments.length - 2]!;
        return Promise.resolve(groupResponseFor(key, officeBApprover.id, officeBApprover.email, officeBApprover.displayName));
      }

      const prefix = "/admin/notification-recipient-groups/";
      if (path.startsWith(prefix)) {
        const key = path.slice(prefix.length);
        const read = (groupReads.get(key) ?? 0) + 1;
        groupReads.set(key, read);
        if (read === 1) {
          return Promise.resolve(groupResponseFor(key, officeAApprover.id, officeAApprover.email, officeAApprover.displayName));
        }
        return new Promise((resolve) => {
          officeBGroupResolvers.push(() =>
            resolve(groupResponseFor(key, officeBApprover.id, officeBApprover.email, officeBApprover.displayName)),
          );
        });
      }

      throw new Error(`Unexpected API call: ${path} ${options?.method ?? "GET"}`);
    });

    await renderPage();
    await vi.waitFor(() => expect(checkboxFor(DD_KEY, "Office A Approver")?.checked).toBe(true));

    // This is an in-place query-only office change, not a remount. The first B group reads are held so
    // the assertion sees the exact unsafe window: there must be no old selection and no enabled Save.
    await act(async () => {
      navigateTo("?officeId=office-b");
    });
    await vi.waitFor(() => {
      expect(userReads).toBe(2);
      expect(officeBGroupResolvers).toHaveLength(NOTIFICATION_RECIPIENT_GROUPS.length);
      expect(sectionFor(DD_KEY)?.textContent).toContain("Loading recipients");
    });
    expect(saveButtonFor(DD_KEY)).toBeUndefined();

    await act(async () => {
      officeBGroupResolvers.forEach((resolve) => resolve());
    });
    await vi.waitFor(() => expect(checkboxFor(DD_KEY, "Office B Approver")?.checked).toBe(true));

    expect(checkboxFor(DD_KEY, "Office A Approver")).toBeUndefined();
    await act(async () => {
      saveButtonFor(DD_KEY)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        `/admin/notification-recipient-groups/${DD_KEY}/assignments`,
        expect.objectContaining({ method: "PUT", json: { userIds: [officeBApprover.id] } }),
      ),
    );
  });

  it("keeps Office B's effective roles when Office A's users reply late", async () => {
    let userReads = 0;
    let resolveOfficeAUsers: (() => void) | undefined;
    const groupReads = new Map<string, number>();

    mocks.api.mockImplementation((path: string) => {
      if (path === "/admin/users") {
        userReads += 1;
        if (userReads === 1) {
          return new Promise((resolve) => {
            resolveOfficeAUsers = () => resolve({ users: [officeAApprover] });
          });
        }
        return Promise.resolve({ users: [officeBApprover] });
      }

      const prefix = "/admin/notification-recipient-groups/";
      if (path.startsWith(prefix)) {
        const key = path.slice(prefix.length);
        const read = (groupReads.get(key) ?? 0) + 1;
        groupReads.set(key, read);
        const approver = read === 1 ? officeAApprover : officeBApprover;
        return Promise.resolve(groupResponseFor(key, approver.id, approver.email, approver.displayName));
      }

      throw new Error(`Unexpected API call: ${path}`);
    });

    await renderPage();
    await vi.waitFor(() => expect(userReads).toBe(1));
    await act(async () => {
      navigateTo("?officeId=office-b");
    });
    await vi.waitFor(() => expect(checkboxFor(DD_KEY, "Office B Approver")?.checked).toBe(true));

    await act(async () => {
      resolveOfficeAUsers?.();
    });
    await vi.waitFor(() => {
      expect(checkboxFor(DD_KEY, "Office B Approver")?.checked).toBe(true);
      expect(checkboxFor(DD_KEY, "Office A Approver")).toBeUndefined();
    });
  });

  it("does not let an Office A save response repaint or lock Office B", async () => {
    let userReads = 0;
    const groupReads = new Map<string, number>();
    let assignmentWrites = 0;
    let resolveOfficeASave: (() => void) | undefined;

    mocks.api.mockImplementation((path: string) => {
      if (path === "/admin/users") {
        userReads += 1;
        return Promise.resolve({ users: userReads === 1 ? [officeAApprover] : [officeBApprover] });
      }

      if (path.endsWith("/assignments")) {
        assignmentWrites += 1;
        const pathSegments = path.split("/");
        const key = pathSegments[pathSegments.length - 2]!;
        if (assignmentWrites === 1) {
          return new Promise((resolve) => {
            resolveOfficeASave = () =>
              resolve(groupResponseFor(key, officeAApprover.id, officeAApprover.email, officeAApprover.displayName));
          });
        }
        return Promise.resolve(groupResponseFor(key, officeBApprover.id, officeBApprover.email, officeBApprover.displayName));
      }

      const prefix = "/admin/notification-recipient-groups/";
      if (path.startsWith(prefix)) {
        const key = path.slice(prefix.length);
        const read = (groupReads.get(key) ?? 0) + 1;
        groupReads.set(key, read);
        const approver = read === 1 ? officeAApprover : officeBApprover;
        return Promise.resolve(groupResponseFor(key, approver.id, approver.email, approver.displayName));
      }

      throw new Error(`Unexpected API call: ${path}`);
    });

    await renderPage();
    await vi.waitFor(() => expect(checkboxFor(DD_KEY, "Office A Approver")?.checked).toBe(true));

    // Leave A's write in flight, then use the same mounted page in B. This is more than a cosmetic race:
    // an old response used to repaint the freshly loaded B group, and a key-only save latch blocked B's
    // own write until A happened to answer.
    await act(async () => {
      saveButtonFor(DD_KEY)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(assignmentWrites).toBe(1));

    await act(async () => {
      navigateTo("?officeId=office-b");
    });
    await vi.waitFor(() => expect(checkboxFor(DD_KEY, "Office B Approver")?.checked).toBe(true));

    await act(async () => {
      saveButtonFor(DD_KEY)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(assignmentWrites).toBe(2));

    await act(async () => {
      resolveOfficeASave?.();
    });
    await vi.waitFor(() => {
      expect(sectionFor(DD_KEY)?.textContent).toContain(officeBApprover.email);
      expect(sectionFor(DD_KEY)?.textContent).not.toContain(officeAApprover.email);
    });
  });
});
