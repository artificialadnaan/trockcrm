import { describe, expect, it } from "vitest";
import {
  getCanonicalDealStageSlugs,
  getDealStageLabelBySlug,
  getDealColumnOwnership,
  getDealStageMetadata,
  getLeadBoardStageLabel,
  getLeadStageMetadata,
  getWorkflowRouteLabel,
  LEAD_BOARD_STAGE_SLUGS,
  normalizeDealStageSlug,
} from "./pipeline-ownership";

const stages = [
  { id: "stage-new", name: "New Lead", slug: "new_lead" },
  { id: "stage-qualified", name: "Qualified Lead", slug: "qualified_lead" },
  { id: "stage-sales-validation", name: "Sales Validation Stage", slug: "sales_validation_stage" },
  { id: "stage-opportunity", name: "Opportunity", slug: "opportunity" },
  { id: "stage-estimating", name: "Estimate in Progress", slug: "estimate_in_progress" },
  { id: "stage-service-estimating", name: "Service - Estimating", slug: "service_estimating" },
  { id: "stage-under-review", name: "Estimate Under Review", slug: "estimate_under_review" },
  { id: "stage-sent", name: "Estimate Sent to Client", slug: "estimate_sent_to_client" },
  { id: "stage-production", name: "Sent to Production", slug: "sent_to_production" },
  { id: "stage-service-production", name: "Service - Sent to Production", slug: "service_sent_to_production" },
  { id: "stage-lost", name: "Production Lost", slug: "production_lost" },
  { id: "stage-service-lost", name: "Service - Lost", slug: "service_lost" },
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

  it("keeps opportunity out of the lead board while recognizing it as CRM-owned", () => {
    const metadata = getLeadStageMetadata("stage-opportunity", stages);

    expect(metadata.isCrmOwnedLeadStage).toBe(true);
    expect(metadata.isBoardStage).toBe(false);
    expect(metadata.isOpportunityStage).toBe(true);
    expect(metadata.label).toBe("Opportunity");
  });

  it("treats opportunity as CRM-owned and estimating as a bid board mirror", () => {
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
        stageId: "stage-service-estimating",
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
    expect(estimating.label).toBe("Service - Estimating");
  });

  it("derives stable column ownership badges from stage semantics", () => {
    expect(getDealColumnOwnership({ slug: "opportunity" })).toEqual({
      label: "CRM editable",
      tone: "crm",
    });
    expect(getDealColumnOwnership({ slug: "estimate_in_progress" })).toEqual({
      label: "Bid Board mirror",
      secondaryLabel: "Read-only in CRM",
      tone: "mirror",
    });
    expect(getWorkflowRouteLabel("normal")).toBe("Normal");
    expect(getWorkflowRouteLabel("service")).toBe("Service");
  });

  it("normalizes legacy stage slugs into the canonical mirrored workflow", () => {
    expect(normalizeDealStageSlug("estimating", "normal")).toBe("estimate_in_progress");
    expect(normalizeDealStageSlug("bid_sent", "normal")).toBe("estimate_sent_to_client");
    expect(normalizeDealStageSlug("closed_lost", "normal")).toBe("production_lost");
    expect(normalizeDealStageSlug("service_complete", "service")).toBe("service_sent_to_production");
    expect(normalizeDealStageSlug("closed_lost", "service")).toBe("service_lost");
  });

  it("exposes the canonical route-specific stage order and labels", () => {
    expect(getCanonicalDealStageSlugs("normal")).toEqual([
      "opportunity",
      "estimate_in_progress",
      "estimate_under_review",
      "estimate_sent_to_client",
      "sent_to_production",
      "production_lost",
    ]);
    expect(getCanonicalDealStageSlugs("service")).toEqual([
      "opportunity",
      "service_estimating",
      "estimate_under_review",
      "estimate_sent_to_client",
      "service_sent_to_production",
      "service_lost",
    ]);
    expect(getDealStageLabelBySlug("estimate_sent_to_client")).toBe("Estimate Sent to Client");
  });
});
