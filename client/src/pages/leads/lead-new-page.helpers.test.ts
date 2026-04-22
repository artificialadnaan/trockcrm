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
  it("only allows active canonical lead workflow stages for new leads", () => {
    const stages: PipelineStage[] = [
      {
        id: "lead-new",
        name: "New",
        slug: "lead_new",
        displayOrder: 1,
        workflowFamily: "lead",
        ...baseStage,
      },
      {
        id: "lead-prequal",
        name: "Company Pre-Qualified",
        slug: "company_pre_qualified",
        displayOrder: 2,
        workflowFamily: "lead",
        ...baseStage,
      },
      {
        id: "legacy-contacted",
        name: "Contacted",
        slug: "contacted",
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
      {
        id: "inactive-lead-stage",
        name: "Scoping In Progress",
        slug: "scoping_in_progress",
        displayOrder: 3,
        workflowFamily: "lead",
        ...baseStage,
        isActivePipeline: false,
      },
    ];

    expect(getLeadCreationStages(stages).map((stage) => stage.id)).toEqual([
      "lead-new",
      "lead-prequal",
    ]);
  });

  it("returns a user-facing label for selected ids", () => {
    expect(
      getSelectedOptionLabel(
        [
          { id: "a", name: "Prospecting" },
          { id: "b", name: "Qualified" },
        ],
        "b",
        "Select lead stage"
      )
    ).toBe("Qualified");

    expect(getSelectedOptionLabel([], "missing", "Select lead stage")).toBe("Select lead stage");
  });
});
