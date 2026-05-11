/**
 * @vitest-environment jsdom
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadTimelineTab } from "./lead-timeline-tab";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useActivities: vi.fn(),
}));

vi.mock("@/hooks/use-activities", () => ({
  useActivities: mocks.useActivities,
}));

describe("LeadTimelineTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.useActivities.mockReset();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
  });

  async function renderTimeline() {
    root = createRoot(container);
    await act(async () => {
      root.render(<LeadTimelineTab leadId="lead-1" />);
    });
  }

  it("renders lead stage-change activities with actor attribution and timestamp", async () => {
    mocks.useActivities.mockReturnValue({
      activities: [
        {
          id: "activity-1",
          type: "note",
          outcome: "lead_stage_changed",
          responsibleUserId: "rep-1",
          performedByUserId: "admin-1",
          performedByUserName: "Morgan Admin",
          performedByUserAvatarUrl: null,
          sourceEntityType: "lead",
          sourceEntityId: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          leadId: "lead-1",
          dealId: null,
          contactId: null,
          emailId: null,
          subject: "Stage changed from New Lead to Qualified Lead",
          body: "Moved this lead from New Lead to Qualified Lead.",
          nextStep: null,
          nextStepDueAt: null,
          durationMinutes: null,
          occurredAt: "2026-04-15T15:00:00.000Z",
          createdAt: "2026-04-15T15:00:00.000Z",
        },
      ],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    await renderTimeline();

    expect(container.textContent).toContain("Morgan Admin moved this lead from New Lead to Qualified Lead");
    expect(container.textContent).toContain("Apr 15, 2026");
    expect(container.textContent).toContain("MA");
  });
});
