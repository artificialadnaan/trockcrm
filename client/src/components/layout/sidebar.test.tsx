import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import {
  Sidebar,
  getNextExpandedGroups,
  getVisibleAdminGroups,
  getVisibleDirectorItems,
  isAdminGroupActive,
} from "./sidebar";

let mockRole: "admin" | "director" | "rep" = "admin";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      id: "user-1",
      email: `${mockRole}@trock.dev`,
      displayName: mockRole === "admin" ? "Admin User" : mockRole === "director" ? "Director User" : "Sales Rep",
      role: mockRole,
      officeId: "office-1",
    },
    logout: vi.fn(),
  }),
}));

function renderSidebar(initialEntry = "/admin/interventions") {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe("Sidebar admin grouping", () => {
  it("returns grouped admin navigation for admins and hides admin groups for reps", () => {
    const adminGroups = getVisibleAdminGroups("admin");
    const repGroups = getVisibleAdminGroups("rep");

    expect(adminGroups.map((group) => group.label)).toEqual(["Operations", "AI", "System"]);
    expect(repGroups).toEqual([]);
  });

  it("keeps director-only items separate from Merge Queue", () => {
    const directorLabels = getVisibleDirectorItems("director").map((item) => item.label);
    const operationsLabels = getVisibleAdminGroups("director")
      .find((group) => group.id === "operations")
      ?.items.map((item) => item.label);

    expect(directorLabels).toEqual(["Director"]);
    expect(operationsLabels).toContain("Merge Queue");
  });

  it("detects the active admin group from the current pathname", () => {
    const groups = getVisibleAdminGroups("admin");

    expect(isAdminGroupActive(groups[0].items, "/admin/interventions")).toBe(true);
    expect(isAdminGroupActive(groups[1].items, "/admin/ai-ops")).toBe(true);
    expect(isAdminGroupActive(groups[2].items, "/admin/offices")).toBe(true);
  });

  it("toggles a non-active group but forces the active group open", () => {
    const groups = getVisibleAdminGroups("admin");
    const aiGroup = groups.find((group) => group.id === "ai");
    const operationsGroup = groups.find((group) => group.id === "operations");

    expect(aiGroup).toBeTruthy();
    expect(operationsGroup).toBeTruthy();

    const expanded = getNextExpandedGroups({}, groups, "/admin/interventions");
    const toggledOpen = getNextExpandedGroups(expanded, groups, "/admin/interventions", aiGroup!.id);
    const toggledClosed = getNextExpandedGroups(toggledOpen, groups, "/admin/interventions", aiGroup!.id);
    const forcedOpen = getNextExpandedGroups(expanded, groups, "/admin/interventions", operationsGroup!.id);

    expect(toggledOpen.ai).toBe(true);
    expect(toggledClosed.ai).toBe(false);
    expect(forcedOpen.operations).toBe(true);
  });

  it("renders Merge Queue from the sidebar without duplicating it in director-only metadata", () => {
    mockRole = "director";
    const html = renderSidebar("/admin/merge-queue");
    mockRole = "admin";

    expect(html).toContain("Operations");
    expect(html).toContain("Merge Queue");
    expect(html).toContain("Director");
  });
});
