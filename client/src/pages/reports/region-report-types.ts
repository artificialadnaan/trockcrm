// Client mirror of the server RegionReportData payload (server/src/modules/reports/region-report-service.ts).
// Keep in lockstep with the server contract. Region = region_id → region_config.name, else 'Unassigned'.
export interface RegionMetricValue {
  value: number;
  count: number;
}
export interface RegionForecastBands {
  "0_30": RegionMetricValue;
  "31_60": RegionMetricValue;
  "61_90": RegionMetricValue;
  beyond_90: RegionMetricValue;
}
export interface RegionTopRep {
  repId: string | null;
  repName: string;
  wonValue: number;
  wonCount: number;
}
export interface RegionRow {
  region: string;
  isUnassigned: boolean;
  displayOrder: number;
  /** WINDOWED by the period toggle (canonical won_closed_date). */
  won: RegionMetricValue;
  /** CURRENT snapshot — does NOT respond to the period toggle. */
  pipeline: RegionMetricValue;
  winRate: number | null;
  avgDeal: number | null;
  sparkline: number[];
  /** CURRENT snapshot projection + honest N/M coverage. */
  forecast: { bands: RegionForecastBands; coverage: { n: number; m: number } };
  /** WINDOWED — top reps by won value in the period. */
  topReps: RegionTopRep[];
}
export interface RegionStageColumn {
  slug: string;
  name: string;
  displayOrder: number;
}
export interface RegionStageCell {
  region: string;
  stageSlug: string;
  count: number;
  value: number;
}
export interface RegionMover {
  region: string;
  deltaWon: number;
}
export interface RegionMoverDeal {
  id: string;
  dealNumber: string | null;
  name: string;
  value: number;
  region: string;
}
export interface RegionReportData {
  period: { from: string; to: string; label: string };
  summary: {
    totalWon: RegionMetricValue;
    openPipeline: RegionMetricValue;
    winRate: number | null;
    unassignedPct: number | null;
  };
  movers: {
    weekLabel: string;
    biggestRegionMover: RegionMover | null;
    biggestNewDeal: RegionMoverDeal | null;
    biggestWin: RegionMoverDeal | null;
    biggestLoss: RegionMoverDeal | null;
  };
  regions: RegionRow[];
  stageColumns: RegionStageColumn[];
  stageMatrix: RegionStageCell[];
}

export const PROJECTION_BAND_ORDER = ["0_30", "31_60", "61_90", "beyond_90"] as const;
export const PROJECTION_BAND_LABEL: Record<(typeof PROJECTION_BAND_ORDER)[number], string> = {
  "0_30": "0–30d",
  "31_60": "31–60d",
  "61_90": "61–90d",
  beyond_90: "90d+",
};
