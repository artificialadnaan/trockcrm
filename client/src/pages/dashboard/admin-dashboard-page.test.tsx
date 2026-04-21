import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  useAdminDashboardSummaryMock: vi.fn(),
}));

vi.mock("@/hooks/use-admin-dashboard-summary", () => ({
  useAdminDashboardSummary: mocks.useAdminDashboardSummaryMock,
}));

import { AdminDashboardPage } from "./admin-dashboard-page";

describe("AdminDashboardPage", () => {
  beforeEach(() => {
    mocks.useAdminDashboardSummaryMock.mockReturnValue({
      loading: false,
      error: null,
      data: {
        aiActions: { pendingCount: 4, oldestAgeLabel: "14m" },
        interventions: { openCount: 3, oldestAgeLabel: "22m" },
        disconnects: { totalCount: 2, primaryClusterLabel: "execution_stall" },
        mergeQueue: { openCount: 1, oldestAgeLabel: "9m" },
        migration: { unresolvedCount: 0, oldestAgeLabel: "0m" },
        audit: { changeCount24h: 12, lastActorLabel: "Alice" },
        procore: { conflictCount: 0, healthLabel: "Healthy" },
      },
    });
  });

  it("renders the Operations Console with summary tiles before secondary board entries", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminDashboardPage />
      </MemoryRouter>
    );

    expect(html).toContain("Operations Console");
    expect(html).toContain("AI Actions");
    expect(html).toContain("Healthy");
  });
});
