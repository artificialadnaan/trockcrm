import { describe, expect, it } from "vitest";
import {
  BID_BOARD_MIRRORED_STAGE_SLUGS,
  CANONICAL_DEAL_STAGE_LABELS,
  CRM_OWNED_LEAD_STAGE_SLUGS,
  NORMAL_DEAL_STAGE_SLUGS,
  SALES_WORKFLOW_DISQUALIFICATION_REASONS,
  SALES_WORKFLOW_PIPELINE_TYPES,
  SERVICE_DEAL_STAGE_SLUGS,
} from "@trock-crm/shared/types";
import * as clientSalesWorkflow from "./sales-workflow.js";

describe("sales workflow client contract", () => {
  it("exposes the canonical stage, pipeline, reason, and mirror dictionaries", () => {
    expect(clientSalesWorkflow.CRM_OWNED_LEAD_STAGE_SLUGS).toEqual(CRM_OWNED_LEAD_STAGE_SLUGS);
    expect(clientSalesWorkflow.SALES_WORKFLOW_PIPELINE_TYPES).toEqual(SALES_WORKFLOW_PIPELINE_TYPES);
    expect(clientSalesWorkflow.SALES_WORKFLOW_DISQUALIFICATION_REASONS).toEqual(
      SALES_WORKFLOW_DISQUALIFICATION_REASONS
    );
    expect(clientSalesWorkflow.BID_BOARD_MIRRORED_STAGE_SLUGS).toEqual(BID_BOARD_MIRRORED_STAGE_SLUGS);
    expect(clientSalesWorkflow.CANONICAL_DEAL_STAGE_LABELS).toEqual(CANONICAL_DEAL_STAGE_LABELS);
    expect(CRM_OWNED_LEAD_STAGE_SLUGS).toEqual([
      "new_lead",
      "qualified_lead",
      "sales_validation_stage",
      "opportunity",
    ]);
    expect(SALES_WORKFLOW_PIPELINE_TYPES).toEqual(["service", "normal"]);
    expect(SALES_WORKFLOW_DISQUALIFICATION_REASONS).toEqual([
      "no_budget",
      "not_a_fit",
      "no_authority",
      "no_timeline",
      "duplicate",
      "unresponsive",
      "customer_declined",
      "other",
    ]);
    expect(NORMAL_DEAL_STAGE_SLUGS).toEqual([
      "opportunity",
      "estimate_in_progress",
      "estimate_under_review",
      "estimate_sent_to_client",
      "sent_to_production",
      "production_lost",
    ]);
    expect(SERVICE_DEAL_STAGE_SLUGS).toEqual([
      "opportunity",
      "service_estimating",
      "estimate_under_review",
      "estimate_sent_to_client",
      "service_sent_to_production",
      "service_lost",
    ]);
    expect(BID_BOARD_MIRRORED_STAGE_SLUGS).toEqual([
      "estimate_in_progress",
      "service_estimating",
      "estimate_under_review",
      "estimate_sent_to_client",
      "sent_to_production",
      "service_sent_to_production",
      "production_lost",
      "service_lost",
    ]);
  });
});
