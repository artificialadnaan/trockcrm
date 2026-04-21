import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/hooks/use-admin-dashboard-summary", () => ({
  useAdminDashboardSummary: vi.fn(() => ({
    loading: false,
    summary: {
      kpis: [
        { label: "Needs attention", value: "15", detail: "6 AI actions • 4 intervention cases" },
        { label: "System health", value: "2", detail: "procore • migration" },
        { label: "Workspace changes", value: "9", detail: "Audit events in the last 24 hours" },
        { label: "Team snapshot", value: "$240,000", detail: "7 active deals" },
      ],
      workspaceItems: [
        { key: "ai-actions", label: "AI Actions", value: "6", detail: "Open AI queue items", href: "/admin/ai-actions" },
      ],
      recentActivity: [
        { key: "audit", label: "Audit spike", detail: "9 admin-facing changes in the last 24 hours" },
      ],
    },
  })),
}));

import { AdminDashboardPage } from "./admin-dashboard-page";

describe("AdminDashboardPage", () => {
  it("renders the admin KPI band and operations workspace", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/"]}>
        <AdminDashboardPage />
      </MemoryRouter>
    );

    expect(html).toContain("Admin Dashboard");
    expect(html).toContain("Needs attention");
    expect(html).toContain("System health");
    expect(html).toContain("Workspace changes");
    expect(html).toContain("AI Actions");
    expect(html).toContain("Audit spike");
  });
});
