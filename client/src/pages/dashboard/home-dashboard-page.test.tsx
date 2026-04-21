import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const authState = {
  user: { role: "admin" as "admin" | "director" | "rep" },
};

vi.mock("@/lib/auth", () => ({
  useAuth: vi.fn(() => authState),
}));

vi.mock("@/pages/dashboard/admin-dashboard-page", () => ({
  AdminDashboardPage: () => <div>Admin Home Surface</div>,
}));

vi.mock("@/pages/director/director-dashboard-page", () => ({
  DirectorDashboardPage: () => <div>Director Home Surface</div>,
}));

vi.mock("@/pages/dashboard/rep-dashboard-page", () => ({
  RepDashboardPage: () => <div>Rep Home Surface</div>,
}));

import { HomeDashboardPage } from "./home-dashboard-page";

describe("HomeDashboardPage", () => {
  it("routes admins to the admin home dashboard", () => {
    authState.user.role = "admin";
    const html = renderToStaticMarkup(<HomeDashboardPage />);
    expect(html).toContain("Admin Home Surface");
  });

  it("routes directors to the director home dashboard", () => {
    authState.user.role = "director";
    const html = renderToStaticMarkup(<HomeDashboardPage />);
    expect(html).toContain("Director Home Surface");
  });

  it("routes reps to the rep home dashboard", () => {
    authState.user.role = "rep";
    const html = renderToStaticMarkup(<HomeDashboardPage />);
    expect(html).toContain("Rep Home Surface");
  });
});
