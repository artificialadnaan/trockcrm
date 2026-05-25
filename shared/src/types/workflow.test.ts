import { describe, expect, it } from "vitest";
import {
  GENUINE_LOST_DEAL_STAGE_ALIAS_SLUGS,
  GENUINE_WON_DEAL_STAGE_ALIAS_SLUGS,
  LOST_DEAL_STAGE_SLUGS,
  TRANSITIONAL_WON_MAPPED_DEAL_STAGE_SLUGS,
  WON_DEAL_STAGE_SLUGS,
  isGenuineWonDealStageSlug,
  toCanonicalDealStageSlug,
} from "./workflow.js";

describe("workflow stage canonicalization", () => {
  it("preserves service-route estimating fallback from the bare estimating slug", () => {
    expect(toCanonicalDealStageSlug("estimating", "service")).toBe("service_estimating");
    expect(toCanonicalDealStageSlug("estimating", "normal")).toBe("estimating");
    expect(toCanonicalDealStageSlug("estimate_in_progress", "service")).toBe("service_estimating");
  });

  it("keeps truly shared stage slugs canonical for both workflow routes", () => {
    for (const slug of ["estimate_under_review", "estimate_sent_to_client", "contract", "won", "lost"]) {
      expect(toCanonicalDealStageSlug(slug, "normal")).toBe(slug);
      expect(toCanonicalDealStageSlug(slug, "service")).toBe(slug);
    }
  });

  it("exports the complete won-stage slug set including historical service aliases", () => {
    expect(WON_DEAL_STAGE_SLUGS).toEqual([
      "won",
      "sent_to_production",
      "service_sent_to_production",
      "service_scheduled",
      "service_complete",
      "closed_won",
    ]);
  });

  it("does not classify pre-close production stages as won stages for rollups", () => {
    expect(toCanonicalDealStageSlug("in_production", "normal")).toBe("won");
    expect(toCanonicalDealStageSlug("close_out", "normal")).toBe("won");
    expect(WON_DEAL_STAGE_SLUGS).not.toContain("in_production");
    expect(WON_DEAL_STAGE_SLUGS).not.toContain("close_out");
  });

  it("classifies legacy won-mapped aliases as genuine won or transitional", () => {
    expect(GENUINE_WON_DEAL_STAGE_ALIAS_SLUGS).toEqual([
      "sent_to_production",
      "service_sent_to_production",
      "service_scheduled",
      "service_complete",
      "closed_won",
    ]);
    expect(GENUINE_WON_DEAL_STAGE_ALIAS_SLUGS).not.toContain("in_production");
    expect(GENUINE_WON_DEAL_STAGE_ALIAS_SLUGS).not.toContain("close_out");
    expect(TRANSITIONAL_WON_MAPPED_DEAL_STAGE_SLUGS).toEqual(["in_production", "close_out"]);
    expect(isGenuineWonDealStageSlug("sent_to_production", "normal")).toBe(true);
    expect(isGenuineWonDealStageSlug("in_production", "normal")).toBe(false);
    expect(isGenuineWonDealStageSlug("close_out", "normal")).toBe(false);
  });

  it("keeps lost-stage slug aliases limited to genuine lost terminal states", () => {
    expect(LOST_DEAL_STAGE_SLUGS).toEqual([
      "lost",
      "deal_canceled",
      "production_lost",
      "service_lost",
      "closed_lost",
    ]);
    expect(GENUINE_LOST_DEAL_STAGE_ALIAS_SLUGS).toEqual([
      "deal_canceled",
      "production_lost",
      "service_lost",
      "closed_lost",
    ]);
    expect(LOST_DEAL_STAGE_SLUGS).not.toContain("in_production");
    expect(LOST_DEAL_STAGE_SLUGS).not.toContain("close_out");
  });
});
