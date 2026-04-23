import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("./admin-dashboard-page", () => ({
  AdminDashboardPage: () => <div>Operations Console</div>,
}));

vi.mock("./rep-dashboard-page", () => ({
  RepDashboardPage: () => <div>Rep Dashboard</div>,
}));

vi.mock("@/pages/director/director-dashboard-page", () => ({
  DirectorDashboardPage: () => <div>Director Dashboard</div>,
}));

import { HomeDashboardPage } from "./home-dashboard-page";

describe("HomeDashboardPage", () => {
  beforeEach(() => {
    mocks.useAuthMock.mockReset();
  });

  it("routes admins to the admin dashboard home surface", () => {
    mocks.useAuthMock.mockReturnValue({
      user: { role: "admin" },
      loading: false,
    });

    const html = renderToStaticMarkup(<HomeDashboardPage />);

    expect(html).toContain("Operations Console");
  });
});
