import { describe, expect, it } from "vitest";
import type { PipelineStage } from "@/hooks/use-pipeline-config";
import { getLeadCreationStages, getSelectedOptionLabel } from "./lead-new-page.helpers";

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

describe("lead new page helpers", () => {
  it("only allows non-terminal lead workflow stages for new leads", () => {
    const stages: PipelineStage[] = [
      {
        id: "lead-qualified",
        name: "Qualified Lead",
        slug: "qualified-lead",
        displayOrder: 1,
        workflowFamily: "lead",
        ...baseStage,
      },
      {
        id: "estimating",
        name: "Estimating",
        slug: "estimating",
        displayOrder: 2,
        workflowFamily: "standard_deal",
        ...baseStage,
      },
      {
        id: "disqualified",
        name: "Disqualified",
        slug: "disqualified",
        displayOrder: 3,
        workflowFamily: "lead",
        ...baseStage,
        isTerminal: true,
      },
    ];

    expect(getLeadCreationStages(stages).map((stage) => stage.id)).toEqual(["lead-qualified"]);
  });

  it("returns a user-facing selected label instead of the raw id", () => {
    expect(
      getSelectedOptionLabel(
        [
          { id: "company-1", name: "Alpha Roofing" },
          { id: "company-2", name: "Birchstone Demo Holdings" },
        ],
        "company-2",
        "Select company"
      )
    ).toBe("Birchstone Demo Holdings");
  });
});
