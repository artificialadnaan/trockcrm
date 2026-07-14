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

describe("UsersPage responsive table", () => {
  it("keeps wide-user data in one labelled horizontal region and stacks rate controls before the small breakpoint", () => {
    act(() => root.render(<UsersPage />));

    const page = container.firstElementChild as HTMLDivElement;
    const scrollBody = container.querySelector<HTMLDivElement>("[data-testid=scrollsync-body]");
    const table = container.querySelector<HTMLTableElement>("table");
    const soloRate = container.querySelector<HTMLInputElement>("#user-user-1-capx-rate-solo");
    const mixedRate = container.querySelector<HTMLInputElement>("#user-user-1-capx-rate-mixed");
    const serviceRate = container.querySelector<HTMLInputElement>("#user-user-1-service-source-rate");

    expect(page.className).toContain("min-w-0");
    expect(scrollBody?.getAttribute("role")).toBe("region");
    expect(scrollBody?.getAttribute("aria-label")).toContain("Scroll horizontally");
    expect(scrollBody?.getAttribute("tabindex")).toBe("0");
    expect(table?.className).toContain("min-w-[76rem]");
    expect(container.querySelector("[data-slot=table-container]")).toBeNull();

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
