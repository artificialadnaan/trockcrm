import { describe, expect, it } from "vitest";
import type { PipelineStage } from "@/hooks/use-pipeline-config";
import {
  getLeadCreationStages,
  getNormalizedLeadCreationStageId,
  getSelectedOptionLabel,
} from "./lead-new-page.helpers";

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
        id: "new-lead",
        name: "New Lead",
        slug: "new_lead",
        displayOrder: 1,
        workflowFamily: "lead",
        ...baseStage,
      },
      {
        id: "qualified-lead",
        name: "Qualified Lead",
        slug: "qualified_lead",
        displayOrder: 2,
        workflowFamily: "lead",
        ...baseStage,
      },
      {
        id: "sales-validation",
        name: "Sales Validation Stage",
        slug: "sales_validation_stage",
        displayOrder: 3,
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
        id: "legacy-prequal",
        name: "Company Pre-Qualified",
        slug: "company_pre_qualified",
        displayOrder: 2,
        workflowFamily: "lead",
        ...baseStage,
      },
      {
        id: "estimating",
        name: "Estimating",
        slug: "estimating",
        displayOrder: 1,
        workflowFamily: "standard_deal",
        ...baseStage,
      },
      {
        id: "disqualified",
        name: "Disqualified",
        slug: "disqualified",
        displayOrder: 99,
        workflowFamily: "lead",
        ...baseStage,
        isTerminal: true,
      },
    ];

    expect(getLeadCreationStages(stages).map((stage) => stage.id)).toEqual([
      "new-lead",
      "qualified-lead",
      "sales-validation",
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

  it("keeps a selected stage when it is still valid for lead creation", () => {
    const stages: PipelineStage[] = [
      {
        id: "new-lead",
        name: "New Lead",
        slug: "new_lead",
        displayOrder: 1,
        workflowFamily: "lead",
        ...baseStage,
      },
      {
        id: "qualified-lead",
        name: "Qualified Lead",
        slug: "qualified_lead",
        displayOrder: 2,
        workflowFamily: "lead",
        ...baseStage,
      },
    ];

    expect(getNormalizedLeadCreationStageId(stages, "qualified-lead")).toBe("qualified-lead");
  });

  it("falls back to the first canonical stage when the selected stage id is stale", () => {
    const stages: PipelineStage[] = [
      {
        id: "new-lead",
        name: "New Lead",
        slug: "new_lead",
        displayOrder: 1,
        workflowFamily: "lead",
        ...baseStage,
      },
      {
        id: "qualified-lead",
        name: "Qualified Lead",
        slug: "qualified_lead",
        displayOrder: 2,
        workflowFamily: "lead",
        ...baseStage,
      },
    ];

    expect(getNormalizedLeadCreationStageId(stages, "legacy-contacted")).toBe("new-lead");
    expect(getNormalizedLeadCreationStageId(stages, "")).toBe("new-lead");
  });
});
