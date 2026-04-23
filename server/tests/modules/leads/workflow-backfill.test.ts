import { describe, expect, it } from "vitest";
import { planLeadWorkflowBackfill } from "../../../src/modules/leads/workflow-backfill.js";

describe("planLeadWorkflowBackfill", () => {
  it("keeps unqualified legacy contacted leads in New Lead while preserving lineage", () => {
    const history = [
      {
        fromStageId: null,
        toStageId: "legacy-contacted",
        changedAt: new Date("2026-04-01T12:00:00.000Z"),
      },
    ];

    const result = planLeadWorkflowBackfill({
      id: "lead-1",
      legacyStageSlug: "contacted",
      source: "referral",
      stageHistory: history,
    });

    expect(result.targetStageSlug).toBe("new_lead");
    expect(result.targetStageLabel).toBe("New Lead");
    expect(result.workflowRoute).toBe("normal");
    expect(result.sourceLinkage).toEqual({
      source: "referral",
      sourceLeadId: null,
      convertedDealId: null,
    });
    expect(result.preservedStageHistory).toBe(history);
  });

  it("maps qualified legacy leads onto Qualified Lead and infers service route from threshold", () => {
    const result = planLeadWorkflowBackfill({
      id: "lead-2",
      legacyStageSlug: "contacted",
      preQualValue: "18000",
      projectTypeId: "project-type-1",
    });

    expect(result.targetStageSlug).toBe("qualified_lead");
    expect(result.targetStageLabel).toBe("Qualified Lead");
    expect(result.workflowRoute).toBe("service");
  });

  it("maps validated legacy leads onto Sales Validation Stage", () => {
    const result = planLeadWorkflowBackfill({
      id: "lead-3",
      legacyStageSlug: "contacted",
      submissionCompletedAt: new Date("2026-04-05T18:30:00.000Z"),
      executiveDecision: "approved",
      preQualValue: "125000",
    });

    expect(result.targetStageSlug).toBe("sales_validation_stage");
    expect(result.targetStageLabel).toBe("Sales Validation Stage");
    expect(result.workflowRoute).toBe("normal");
  });
});
