import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PipelineConfigPage } from "./pipeline-config-page";

vi.mock("@/hooks/use-admin-pipeline", () => ({
  useAdminPipeline: vi.fn(() => ({
    stages: [
      {
        id: "stage-lead",
        name: "Lead Go/No-Go",
        slug: "lead_go_no_go",
        workflowFamily: "lead",
        displayOrder: 5,
        isActivePipeline: true,
        isTerminal: false,
        requiredFields: ["estimatedOpportunityValue", "qualification.stakeholderRole"],
        requiredDocuments: [],
        requiredApprovals: [],
        staleThresholdDays: 3,
        procoreStageMapping: null,
        color: "#b45309",
      },
    ],
    loading: false,
    saving: false,
    refetch: vi.fn(),
    updateStage: vi.fn(),
  })),
}));

vi.mock("@/lib/stage-gate-options", () => ({
  filterKnownStageGateValues: vi.fn((values: string[]) => values),
  toggleStageGateValue: vi.fn(),
  STAGE_GATE_APPROVAL_OPTIONS: [],
  STAGE_GATE_DOCUMENT_OPTIONS: [],
  STAGE_GATE_FIELD_OPTIONS: [
    { value: "estimatedOpportunityValue", label: "Estimated Opportunity Value" },
    { value: "qualification.stakeholderRole", label: "Stakeholder Role" },
  ],
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("PipelineConfigPage", () => {
  it("shows workflow family badges and lead gate options", () => {
    const html = renderToStaticMarkup(<PipelineConfigPage />);

    expect(html).toContain("Lead");
    expect(html).toContain("Estimated Opportunity Value");
    expect(html).toContain("Stakeholder Role");
  });
});
