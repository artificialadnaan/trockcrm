import { describe, expect, it } from "vitest";
import {
  BID_BOARD_MIRRORED_STAGE_SLUGS,
  CRM_OWNED_LEAD_STAGE_SLUGS,
  SALES_WORKFLOW_DISQUALIFICATION_REASONS,
  SALES_WORKFLOW_PIPELINE_TYPES,
} from "./sales-workflow.js";

describe("sales workflow client contract", () => {
  it("exposes the canonical stage, pipeline, reason, and mirror dictionaries", () => {
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
    expect(BID_BOARD_MIRRORED_STAGE_SLUGS).toEqual([
      "estimating",
      "bid_sent",
      "in_production",
      "close_out",
      "closed_won",
      "closed_lost",
    ]);
  });
});
