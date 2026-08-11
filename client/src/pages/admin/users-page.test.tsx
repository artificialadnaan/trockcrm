// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsersPage } from "./users-page";

const useAdminUsersMock = vi.hoisted(() => vi.fn());
const useAdminOfficesMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-admin-users", () => ({ useAdminUsers: useAdminUsersMock }));
vi.mock("@/hooks/use-admin-offices", () => ({ useAdminOffices: useAdminOfficesMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./add-user-dialog", () => ({ AddUserDialog: () => null }));
vi.mock("./user-invite-preview-dialog", () => ({ UserInvitePreviewDialog: () => null }));
vi.mock("./user-local-auth-events-dialog", () => ({ UserLocalAuthEventsDialog: () => null }));

let container: HTMLDivElement;
let root: Root;

const user = {
  id: "user-1",
  email: "adnaan@example.com",
  displayName: "Adnaan Iqbal",
  role: "admin" as const,
  officeId: "office-1",
  reportsTo: null,
  officeName: "Dallas",
  isActive: true,
  generatesSales: true,
  extraOfficeCount: 0,
  commissionStructure: "solo" as const,
  capxRateSolo: 0.03,
  capxRateMixed: 0.02,
  serviceSourceRate: 0.01,
  rollingFloor: 25000,
  overrideRate: 0.01,
  sourceSystems: ["hubspot"] as Array<"hubspot" | "procore">,
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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAdminUsersMock.mockReturnValue({
    users: [user],
    loading: false,
    error: null,
    refetch: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    updateUsersBulk: vi.fn(),
    importExternalUsers: vi.fn(),
    sendInvite: vi.fn(),
    previewInvite: vi.fn(),
    revokeInvite: vi.fn(),
    getLocalAuthEvents: vi.fn(),
  });
  useAdminOfficesMock.mockReturnValue({ offices: [], loading: false, error: null, refetch: vi.fn() });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("UsersPage generates-sales toggle", () => {
  function generatesSalesCheckbox(): HTMLInputElement {
    // Found by ACCESSIBLE NAME, not by position. A checkbox alone in a table cell has no visible label,
    // so if the name regresses this throws rather than quietly testing the wrong control — which is how
    // the first version of this test passed against a checkbox that had no name at all.
    const checkbox = container.querySelector<HTMLInputElement>(
      'input[type=checkbox][aria-label="Adnaan Iqbal generates sales"]'
    );
    if (!checkbox) throw new Error("generates-sales checkbox not rendered with an accessible name");
    return checkbox;
  }

  it("reflects the stored flag rather than the role", () => {
    act(() => root.render(<UsersPage />));
    // The fixture is role='admin' AND generatesSales=true — the combination the old role-based roster
    // could not express. The control must follow the flag, or the two would be the same field again.
    expect(generatesSalesCheckbox().checked).toBe(true);
  });

  it("sends the INVERTED flag, so unticking removes the person from the dashboard", async () => {
    const updateUser = vi.fn().mockResolvedValue(undefined);
    useAdminUsersMock.mockReturnValue({
      users: [user],
      loading: false,
      error: null,
      refetch: vi.fn(),
      createUser: vi.fn(),
      updateUser,
      updateUsersBulk: vi.fn(),
      importExternalUsers: vi.fn(),
      sendInvite: vi.fn(),
      previewInvite: vi.fn(),
      revokeInvite: vi.fn(),
      getLocalAuthEvents: vi.fn(),
    });

    act(() => root.render(<UsersPage />));
    // async act: the handler awaits updateUser and then clears its own busy state, so a sync act()
    // leaves that trailing setState outside the batch and React warns.
    await act(async () => {
      generatesSalesCheckbox().click();
    });

    // A boolean sent uninverted is the classic version of this bug: the click appears to do nothing,
    // because the value written back is the value already stored.
    expect(updateUser).toHaveBeenCalledWith("user-1", { generatesSales: false });
  });
});

describe("UsersPage responsive table", () => {
  it("keeps wide-user data in one labelled horizontal region and stacks rate controls before the small breakpoint", () => {
    act(() => root.render(<UsersPage />));

    const page = container.firstElementChild as HTMLDivElement;
    const scrollBody = container.querySelector<HTMLDivElement>("[data-testid=scrollsync-body]");
    const table = container.querySelector<HTMLTableElement>("table");
    const soloRate = container.querySelector<HTMLInputElement>("#user-user-1-capx-rate-solo");
    const mixedRate = container.querySelector<HTMLInputElement>("#user-user-1-capx-rate-mixed");
    const serviceRate = container.querySelector<HTMLInputElement>("#user-user-1-service-source-rate");
    const roleFilterLabel = [...container.querySelectorAll("label")].find((label) => label.textContent === "Role");
    const filterGrid = roleFilterLabel?.parentElement?.parentElement;

    expect(page.className).toContain("min-w-0");
    expect(scrollBody?.getAttribute("role")).toBe("region");
    expect(scrollBody?.getAttribute("aria-label")).toContain("Scroll horizontally");
    expect(scrollBody?.getAttribute("tabindex")).toBe("0");
    // Widened from 76rem when the Generates Sales column was added. The number is pinned because the
    // horizontal-scroll affordance above depends on the table genuinely overflowing its container —
    // adding a column without widening it silently squeezes the existing ones instead.
    expect(table?.className).toContain("min-w-[84rem]");
    expect(container.querySelector("[data-slot=table-container]")).toBeNull();
    expect(filterGrid?.className).toContain("grid-cols-1");
    expect(filterGrid?.className).toContain("sm:grid-cols-2");
    expect(filterGrid?.className).toContain("xl:grid-cols-4");
    expect(filterGrid?.className).not.toContain("2xl:grid-cols-4");

    expect(soloRate?.inputMode).toBe("decimal");
    expect(mixedRate?.inputMode).toBe("decimal");
    expect(serviceRate?.inputMode).toBe("decimal");
    expect(container.querySelector('label[for="user-user-1-capx-rate-solo"]')?.textContent).toContain("Active");
    expect(container.querySelector('label[for="user-user-1-capx-rate-mixed"]')?.textContent).not.toContain("Active");
    expect(soloRate?.closest("td")?.className).toContain("whitespace-normal");
    expect(soloRate?.parentElement?.parentElement?.className).toContain("grid-cols-1");
    expect(soloRate?.parentElement?.parentElement?.className).toContain("sm:grid-cols-3");
  });
});
