import { describe, expect, it } from "vitest";
import {
  getDealColumnOwnership,
  getDealStageMetadata,
  getLeadBoardStageLabel,
  getLeadStageMetadata,
  getWorkflowRouteLabel,
  LEGACY_LEAD_BOARD_STAGE_SLUGS,
  LEAD_BOARD_STAGE_SLUGS,
} from "./pipeline-ownership";

const stages = [
  { id: "stage-new", name: "New Lead", slug: "new_lead" },
  { id: "stage-qualified", name: "Qualified Lead", slug: "qualified_lead" },
  { id: "stage-sales-validation", name: "Sales Validation Stage", slug: "sales_validation_stage" },
  { id: "stage-opportunity", name: "Opportunity", slug: "opportunity" },
  { id: "stage-estimating", name: "Estimate in Progress", slug: "estimate_in_progress" },
];

describe("pipeline ownership helpers", () => {
  it("defines the lead board stages in CRM order", () => {
    expect(LEAD_BOARD_STAGE_SLUGS).toEqual([
      "new_lead",
      "qualified_lead",
      "sales_validation_stage",
    ]);
    expect(LEAD_BOARD_STAGE_SLUGS.map(getLeadBoardStageLabel)).toEqual([
      "New Lead",
      "Qualified Lead",
      "Sales Validation Stage",
    ]);
  });

  it("keeps legacy lead stages renderable during the pipeline migration window", () => {
    expect(LEGACY_LEAD_BOARD_STAGE_SLUGS).toEqual([
      "lead_new",
      "company_pre_qualified",
      "scoping_in_progress",
      "pre_qual_value_assigned",
      "lead_go_no_go",
      "qualified_for_opportunity",
    ]);
    expect(getLeadBoardStageLabel("lead_go_no_go")).toBe("Sales Validation Stage");

    const metadata = getLeadStageMetadata("legacy-validation", [
      ...stages,
      { id: "legacy-validation", name: "Lead Go/No-Go", slug: "lead_go_no_go" },
    ]);

    expect(metadata.isBoardStage).toBe(true);
    expect(metadata.isCrmOwnedLeadStage).toBe(false);
    expect(metadata.label).toBe("Sales Validation Stage");
  });

  it("keeps opportunity out of the lead board while recognizing it as CRM-owned", () => {
    const metadata = getLeadStageMetadata("stage-opportunity", stages);

    expect(metadata.isCrmOwnedLeadStage).toBe(true);
    expect(metadata.isBoardStage).toBe(false);
    expect(metadata.isOpportunityStage).toBe(true);
    expect(metadata.label).toBe("Opportunity");
  });

  it("treats opportunity as CRM-owned and estimate in progress as a bid board mirror", () => {
    const opportunity = getDealStageMetadata(
      {
        stageId: "stage-opportunity",
        workflowRoute: "normal",
        isBidBoardOwned: false,
        bidBoardStageSlug: null,
        readOnlySyncedAt: null,
      },
      stages
    );
    const estimating = getDealStageMetadata(
      {
        stageId: "stage-estimating",
        workflowRoute: "service",
        isBidBoardOwned: false,
        bidBoardStageSlug: null,
        readOnlySyncedAt: null,
      },
      stages
    );

    expect(opportunity.isReadOnlyInCrm).toBe(false);
    expect(opportunity.sourceOfTruth).toBe("crm");
    expect(estimating.isMirroredStage).toBe(true);
    expect(estimating.isReadOnlyInCrm).toBe(true);
    expect(estimating.sourceOfTruth).toBe("bid_board");
    expect(estimating.routeLabel).toBe("Service");
  });

  it("derives stable column ownership badges from stage semantics", () => {
    expect(getDealColumnOwnership({ slug: "opportunity" })).toEqual({
      label: "CRM editable",
      tone: "crm",
    });
    expect(getDealColumnOwnership({ slug: "estimate_in_progress" })).toEqual({
      label: "Bid Board mirror",
      secondaryLabel: "Synced from Bid Board",
      tone: "mirror",
    });
    expect(getWorkflowRouteLabel("normal")).toBe("Standard");
    expect(getWorkflowRouteLabel("service")).toBe("Service");
  });
});
