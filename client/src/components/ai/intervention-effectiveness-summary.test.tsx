import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { InterventionEffectivenessSummary } from "./intervention-effectiveness-summary";

describe("InterventionEffectivenessSummary", () => {
  it("renders richer conclusion-family metrics and subordinate sections", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InterventionEffectivenessSummary
          summaryByConclusionFamily={[
            {
              key: "resolve",
              label: "resolve",
              volume: 4,
              reopenRate: 0.25,
              durableCloseRate: 0.75,
              medianDaysToReopen: 2,
              averageDaysToDurableClose: 3,
              queueLink: "/admin/interventions?view=repeat",
            },
          ]}
          resolveReasonPerformance={[]}
          snoozeReasonPerformance={[]}
          escalationReasonPerformance={[]}
          escalationTargetPerformance={[]}
          disconnectTypeInteractions={[]}
          assigneeEffectiveness={[]}
          warnings={[]}
          reopenRateByConclusionFamily={{ resolve: 0.25, snooze: 0.5, escalate: null }}
          reopenRateByResolveCategory={[]}
          reopenRateBySnoozeReason={[]}
          reopenRateByEscalationReason={[]}
          conclusionMixByDisconnectType={[]}
          conclusionMixByActingUser={[]}
          conclusionMixByAssigneeAtConclusion={[]}
          medianDaysToReopenByConclusionFamily={[]}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Resolution Effectiveness");
    expect(html).toContain("Durable close rate");
    expect(html).toContain("Average days to durable closure");
    expect(html).toContain("Resolve Reason Performance");
    expect(html).toContain("Operational Warnings");
  });
});
