import { describe, expect, it } from "vitest";

import {
  BID_BOARD_OWNED_CANONICAL_DEAL_STAGE_SLUGS,
  CANONICAL_DEAL_STAGE_SLUGS,
  CANONICAL_TERMINAL_DEAL_STAGE_SLUGS,
  getCanonicalEstimatingBoundaryStageSlug,
  isBidBoardOwnedDealStage,
  isCanonicalDealStageSlug,
  isTerminalWorkflowStage,
  toCanonicalDealStageSlug,
} from "@trock-crm/shared/types";

describe("stage-v2 workflow contracts", () => {
  it("exposes the new active canonical deal stage slugs", () => {
    expect(CANONICAL_DEAL_STAGE_SLUGS).toEqual([
      "opportunity",
      "estimating",
      "service_estimating",
      "estimate_under_review",
      "estimate_sent_to_client",
      "contract",
      "won",
      "lost",
    ]);
    expect(BID_BOARD_OWNED_CANONICAL_DEAL_STAGE_SLUGS).toEqual([
      "estimating",
      "service_estimating",
      "estimate_under_review",
      "estimate_sent_to_client",
      "contract",
      "won",
      "lost",
    ]);
    expect(CANONICAL_TERMINAL_DEAL_STAGE_SLUGS).toEqual(["won", "lost"]);
  });

  it("keeps inactive historical aliases resolvable through the legacy resolver", () => {
    expect(toCanonicalDealStageSlug("estimate_in_progress", "normal")).toBe("estimating");
    expect(toCanonicalDealStageSlug("sent_to_production", "normal")).toBe("won");
    expect(toCanonicalDealStageSlug("service_sent_to_production", "service")).toBe("won");
    expect(toCanonicalDealStageSlug("closed_won", "service")).toBe("won");
    expect(toCanonicalDealStageSlug("production_lost", "normal")).toBe("lost");
    expect(toCanonicalDealStageSlug("service_lost", "service")).toBe("lost");
    expect(toCanonicalDealStageSlug("closed_lost", "normal")).toBe("lost");
    expect(toCanonicalDealStageSlug("service_estimate_under_review", "service")).toBe(
      "estimate_under_review"
    );
    expect(toCanonicalDealStageSlug("service_estimate_sent_to_client", "service")).toBe(
      "estimate_sent_to_client"
    );
    expect(toCanonicalDealStageSlug("contract_signed", "normal")).toBe("contract");
    expect(toCanonicalDealStageSlug("service_contract_signed", "service")).toBe("contract");
  });

  it("does not treat inactive historical aliases as active canonical slugs", () => {
    expect(isCanonicalDealStageSlug("estimate_in_progress")).toBe(false);
    expect(isCanonicalDealStageSlug("sent_to_production")).toBe(false);
    expect(isCanonicalDealStageSlug("service_sent_to_production")).toBe(false);
    expect(isCanonicalDealStageSlug("production_lost")).toBe(false);
    expect(isCanonicalDealStageSlug("service_lost")).toBe(false);
    expect(isCanonicalDealStageSlug("closed_won")).toBe(false);
    expect(isCanonicalDealStageSlug("closed_lost")).toBe(false);
  });

  it("uses new canonical route boundaries and terminal semantics", () => {
    expect(getCanonicalEstimatingBoundaryStageSlug("normal")).toBe("estimating");
    expect(getCanonicalEstimatingBoundaryStageSlug("service")).toBe("service_estimating");
    expect(isBidBoardOwnedDealStage("contract", "normal")).toBe(true);
    expect(isTerminalWorkflowStage("won", "normal")).toBe(true);
    expect(isTerminalWorkflowStage("lost", "service")).toBe(true);
    expect(isTerminalWorkflowStage("sent_to_production", "normal")).toBe(true);
    expect(isTerminalWorkflowStage("service_lost", "service")).toBe(true);
  });
});
