import { describe, expect, it } from "vitest";
import { getDefaultDealStageId, getNewDealStages, getSelectedOptionLabel } from "./deal-form.helpers";
import type { PipelineStage } from "@/hooks/use-pipeline-config";

const baseStage: Omit<PipelineStage, "id" | "name" | "slug" | "displayOrder" | "workflowFamily"> = {
  isActivePipeline: true,
  isTerminal: false,
  requiredFields: [],
  requiredDocuments: [],
  requiredApprovals: [],
  staleThresholdDays: null,
  procoreStageMapping: null,
  color: null,
};

describe("deal form stage helpers", () => {
  it("only allows non-terminal standard deal stages for new deals", () => {
    const stages: PipelineStage[] = [
      {
        id: "lead-stage",
        name: "Lead Intake",
        slug: "lead",
        displayOrder: 1,
        workflowFamily: "lead",
        ...baseStage,
      },
      {
        id: "service-stage",
        name: "Service Ready",
        slug: "service-ready",
        displayOrder: 2,
        workflowFamily: "service_deal",
        ...baseStage,
      },
      {
        id: "estimating-stage",
        name: "Estimating",
        slug: "estimating",
        displayOrder: 3,
        workflowFamily: "standard_deal",
        ...baseStage,
      },
      {
        id: "closed-stage",
        name: "Closed Won",
        slug: "closed-won",
        displayOrder: 4,
        workflowFamily: "standard_deal",
        ...baseStage,
        isTerminal: true,
      },
    ];

    expect(getNewDealStages(stages).map((stage) => stage.id)).toEqual(["estimating-stage"]);
    expect(getDefaultDealStageId(stages)).toBe("estimating-stage");
  });

  it("maps selected ids back to user-facing labels", () => {
    expect(
      getSelectedOptionLabel(
        [
          { id: "roof", name: "Roofing" },
          { id: "int", name: "Interiors" },
        ],
        "int",
        "Select type"
      )
    ).toBe("Interiors");

    expect(getSelectedOptionLabel([], "missing", "Select type")).toBe("Select type");
  });
});
