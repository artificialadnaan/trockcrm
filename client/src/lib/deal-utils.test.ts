import { describe, expect, it } from "vitest";
import {
  bestEstimate,
  bestEstimateCaptionLabel,
  formatDealDisplayNumber,
  isHubspotImportedDealNumber,
  isLostBidDeal,
  resolveBestEstimate,
  resolveDealValueKind,
  sanitizeHubspotDealIdentifiers,
} from "./deal-utils";

describe("isHubspotImportedDealNumber", () => {
  it("flags HS- prefixed dealNumbers as HubSpot-imported", () => {
    expect(isHubspotImportedDealNumber("HS-324283495135")).toBe(true);
    expect(isHubspotImportedDealNumber("HS324283495135")).toBe(true);
    expect(isHubspotImportedDealNumber("hs-12345")).toBe(true);
  });

  it("does not flag native deal numbers", () => {
    expect(isHubspotImportedDealNumber("ATL-2-12826-AH")).toBe(false);
    expect(isHubspotImportedDealNumber("DFW-105-aa")).toBe(false);
    expect(isHubspotImportedDealNumber("BB-42")).toBe(false);
  });

  it("handles null and empty values", () => {
    expect(isHubspotImportedDealNumber(null)).toBe(false);
    expect(isHubspotImportedDealNumber(undefined)).toBe(false);
    expect(isHubspotImportedDealNumber("")).toBe(false);
  });
});

describe("formatDealDisplayNumber", () => {
  it("prefers projectNumber over dealNumber", () => {
    const result = formatDealDisplayNumber({
      projectNumber: "ATL-2-12826-AH",
      dealNumber: "HS-324283495135",
    });
    expect(result).toEqual({ label: "ATL-2-12826-AH", isFallback: false, isPending: false });
  });

  it("falls back to native dealNumber when projectNumber is missing", () => {
    const result = formatDealDisplayNumber({
      projectNumber: null,
      dealNumber: "BB-42",
    });
    expect(result).toEqual({ label: "BB-42", isFallback: true, isPending: false });
  });

  it("returns 'Pending' label instead of an HS- prefixed dealNumber", () => {
    const result = formatDealDisplayNumber({
      projectNumber: null,
      dealNumber: "HS-324283495135",
    });
    expect(result).toEqual({ label: "Pending", isFallback: true, isPending: true });
  });

  it("returns 'Pending' label when both projectNumber and dealNumber are missing", () => {
    const result = formatDealDisplayNumber({});
    expect(result).toEqual({ label: "Pending", isFallback: true, isPending: true });
  });

  it("never exposes the HS- HubSpot prefix even when whitespace is present", () => {
    const result = formatDealDisplayNumber({
      projectNumber: "   ",
      dealNumber: "  HS-9999  ",
    });
    expect(result.label).toBe("Pending");
    expect(result.isPending).toBe(true);
  });
});

describe("sanitizeHubspotDealIdentifiers", () => {
  it("replaces HS-prefixed identifiers embedded in generated titles and file names", () => {
    expect(sanitizeHubspotDealIdentifiers("Follow up: HS-323641734879 closes 2026-05-08")).toBe(
      "Follow up: Project pending closes 2026-05-08"
    );
    expect(sanitizeHubspotDealIdentifiers("HS-319925219003 Photo 2026-05-10 001 dad87234.jpg", "Imported deal")).toBe(
      "Imported deal Photo 2026-05-10 001 dad87234.jpg"
    );
  });
});

describe("deal value precedence", () => {
  it("uses the synced Bid Board/bid amount instead of awarded_amount for generic open-deal value", () => {
    const deal = {
      bidBoardTotalSales: "16137.14",
      bidEstimate: "16137.14",
      awardedAmount: "2.97",
      ddEstimate: "3.00",
    };

    expect(bestEstimate(deal)).toBe(16137.14);
    expect(resolveBestEstimate(deal)).toEqual({ value: 16137.14, source: "bid_board" });
    expect(bestEstimateCaptionLabel(resolveBestEstimate(deal).source)).toBe("Bid Board");
  });

  it("falls back to awarded_amount only after current estimate fields are missing", () => {
    expect(bestEstimate({ awardedAmount: "42000", bidEstimate: null, ddEstimate: null })).toBe(42000);
    expect(resolveBestEstimate({ awardedAmount: "42000", bidEstimate: null, ddEstimate: null }).source).toBe(
      "awarded"
    );
  });

  it("skips zero and negative current values before falling through", () => {
    expect(
      resolveBestEstimate({
        bidBoardTotalSales: "-100",
        bidEstimate: "0",
        ddEstimate: "42000",
        awardedAmount: "2.97",
      })
    ).toEqual({ value: 42000, source: "estimate" });
  });

  it("keeps awarded_amount first for won-stage deal value displays", () => {
    const deal = {
      stageSlug: "won",
      awardedAmount: "925000",
      bidEstimate: "875000",
      ddEstimate: "800000",
    };

    expect(bestEstimate(deal)).toBe(925000);
    expect(resolveBestEstimate(deal)).toEqual({ value: 925000, source: "awarded" });
  });

  it("falls back to positive bid value for won-stage deal value when awarded is zero", () => {
    const deal = {
      stageSlug: "service_scheduled",
      awardedAmount: "0",
      bidBoardTotalSales: "-10",
      bidEstimate: "875000",
      ddEstimate: "800000",
    };

    expect(bestEstimate(deal)).toBe(875000);
    expect(resolveBestEstimate(deal)).toEqual({ value: 875000, source: "bid" });
  });

  it("does not use awarded-first precedence for pre-close won-mapped stages", () => {
    expect(
      resolveBestEstimate({
        stageSlug: "in_production",
        workflowRoute: "normal",
        awardedAmount: "925000",
        bidBoardTotalSales: "950000",
        bidEstimate: "875000",
        ddEstimate: "800000",
      })
    ).toEqual({ value: 950000, source: "bid_board" });
    expect(
      resolveBestEstimate({
        stageSlug: "close_out",
        workflowRoute: "normal",
        awardedAmount: "925000",
        bidBoardTotalSales: "0",
        bidEstimate: "875000",
        ddEstimate: "800000",
      })
    ).toEqual({ value: 875000, source: "bid" });
  });

  it("uses current stage before a won-like Bid Board stage when choosing generic deal value", () => {
    const deal = {
      stageSlug: "opportunity",
      bidBoardStageSlug: "sent_to_production",
      bidEstimate: "16137.14",
      awardedAmount: "2.97",
      ddEstimate: "3.00",
    };

    expect(bestEstimate(deal)).toBe(16137.14);
    expect(resolveBestEstimate(deal)).toEqual({ value: 16137.14, source: "bid" });
  });

  it("does not use a won-like Bid Board stage to force awarded value when current stage is unknown", () => {
    const deal = {
      bidBoardStageSlug: "sent_to_production",
      bidEstimate: "16137.14",
      awardedAmount: "2.97",
      ddEstimate: "3.00",
    };

    expect(bestEstimate(deal)).toBe(16137.14);
    expect(resolveBestEstimate(deal)).toEqual({ value: 16137.14, source: "bid" });
  });
});

describe("resolveDealValueKind / isLostBidDeal", () => {
  it("classifies a lost deal as 'lost' while preserving its bid value", () => {
    const lost = { bidEstimate: "65600", stageSlug: "lost", workflowRoute: "normal" };
    expect(resolveDealValueKind(lost)).toBe("lost");
    expect(isLostBidDeal(lost)).toBe(true);
    // Fix C guard: the preserved bid is STILL returned -- the UI greys it, never clears it.
    expect(resolveBestEstimate(lost).value).toBe(65600);
  });

  it("classifies lost-stage aliases (closed_lost / production_lost / service_lost) as lost", () => {
    expect(resolveDealValueKind({ stageSlug: "closed_lost" })).toBe("lost");
    expect(resolveDealValueKind({ stageSlug: "production_lost" })).toBe("lost");
    expect(resolveDealValueKind({ stageSlug: "service_lost", workflowRoute: "service" })).toBe("lost");
  });

  it("classifies won and active/open deals, and treats missing stage as active", () => {
    expect(resolveDealValueKind({ stageSlug: "won", workflowRoute: "normal" })).toBe("won");
    expect(isLostBidDeal({ stageSlug: "won" })).toBe(false);
    expect(resolveDealValueKind({ stageSlug: "estimating" })).toBe("active");
    expect(resolveDealValueKind({})).toBe("active");
    expect(isLostBidDeal({})).toBe(false);
  });

  it("detects the terminal stage via bidBoardStageSlug when the CRM stageSlug is still open", () => {
    // Bid Board-owned/mirrored deals carry their terminal stage on bidBoardStageSlug while
    // the CRM stageSlug can lag on an open stage -- mirror pipeline-terminal-filters precedence.
    expect(resolveDealValueKind({ stageSlug: "estimating", bidBoardStageSlug: "closed_lost" })).toBe("lost");
    expect(isLostBidDeal({ stageSlug: "estimating", bidBoardStageSlug: "closed_lost" })).toBe(true);
    expect(resolveDealValueKind({ stageSlug: "estimating", bidBoardStageSlug: "closed_won" })).toBe("won");
  });
});
