import type { EstimatingReport } from "./types";

/** Minimal complete A1 payload for fixtures that exercise another Showcase variant. */
export function emptyEstimatingReport(currentAsOf = "2026-06-12T12:00:00.000Z"): EstimatingReport {
  return {
    currentAsOf,
    currentEstimating: { count: 0, ddValue: 0, missingDdCount: 0, projects: [] },
    newRfps: { count: 0, ddValue: 0, missingDdCount: 0, projects: [] },
    rfpBySalesperson: [],
    estimatesSent: {
      count: 0,
      latestBidBoardTotalSales: 0,
      projects: [],
      comparison: {
        dollarComparableCount: 0,
        percentageComparableCount: 0,
        dollarComparableDdValue: 0,
        dollarComparableLatestBidBoardTotalSales: 0,
        varianceAmount: 0,
        percentageComparableDdValue: 0,
        percentageComparableLatestBidBoardTotalSales: 0,
        variancePercent: null,
      },
      margin: { projectCount: 0, latestBidBoardTotalSales: 0, blendedPercent: null },
      missingSentValueCount: 0,
      missingMarginCount: 0,
    },
  };
}
