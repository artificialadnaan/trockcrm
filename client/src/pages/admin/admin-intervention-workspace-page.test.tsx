import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminInterventionWorkspacePage } from "./admin-intervention-workspace-page";

const mocks = vi.hoisted(() => ({
  useAdminInterventions: vi.fn(),
}));

vi.mock("@/hooks/use-admin-interventions", () => ({
  batchAssignInterventions: vi.fn(),
  batchEscalateInterventions: vi.fn(),
  batchResolveInterventions: vi.fn(),
  batchSnoozeInterventions: vi.fn(),
  summarizeInterventionMutationResult: vi.fn(() => ({ tone: "success", message: "Updated" })),
  useAdminInterventions: mocks.useAdminInterventions,
}));

vi.mock("@/components/ai/intervention-summary-strip", () => ({
  InterventionSummaryStrip: () => <div>Intervention summary strip</div>,
}));

vi.mock("@/components/ai/intervention-batch-toolbar", () => ({
  InterventionBatchToolbar: () => <div>Batch toolbar</div>,
}));

vi.mock("@/components/ai/intervention-queue-table", () => ({
  InterventionQueueTable: () => <div>Queue table</div>,
}));

vi.mock("@/components/ai/intervention-detail-panel", () => ({
  InterventionDetailPanel: () => <div>Detail panel</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  buttonVariants: () => "",
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

beforeEach(() => {
  mocks.useAdminInterventions.mockReturnValue({
    data: {
      items: [],
      totalCount: 0,
      page: 1,
      pageSize: 50,
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
});

describe("AdminInterventionWorkspacePage", () => {
  it("keeps the workspace focused on execution and preserves passthrough filters on the disconnect back-link", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={["/admin/interventions?type=missing_next_task&cluster=follow_through_gap&trend=companies"]}
      >
        <AdminInterventionWorkspacePage />
      </MemoryRouter>
    );

    expect(html).toContain("Admin Intervention Workspace");
    expect(html).toContain("View Analytics");
    expect(html).toContain("View Disconnect Dashboard");
    expect(html).toContain(
      'href="/admin/sales-process-disconnects?type=missing_next_task&amp;cluster=follow_through_gap&amp;trend=companies"'
    );
    expect(html).not.toContain("Manager Alerts");
    expect(html).not.toContain("Queue Health");
  });
});
