import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface QcScorecardRow {
  scorecardId: string;
  dealId: string;
  projectName: string;
  projectNumber: string | null;
  regionName: string | null;
  superintendentName: string | null;
  totalScore: number;
  rating: string;
  deficiencyCount: number;
  weekOf: string;
  submittedAt: string;
  submittedByName: string | null;
  pdfAvailable: boolean;
}

export interface QcScorecardFilters {
  from?: string;
  to?: string;
  regionId?: string;
  superintendent?: string;
  rating?: string;
  flaggedOnly?: boolean;
  search?: string;
}

/** Office-scoped QC dashboard feed: every Field Scorecard in the window, filtered server-side. */
export function useQcScorecards(filters: QcScorecardFilters) {
  const [scorecards, setScorecards] = useState<QcScorecardRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { from, to, regionId, superintendent, rating, flaggedOnly, search } = filters;

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      if (regionId) qs.set("regionId", regionId);
      if (superintendent) qs.set("superintendent", superintendent);
      if (rating) qs.set("rating", rating);
      if (flaggedOnly) qs.set("flaggedOnly", "true");
      if (search) qs.set("search", search);
      const data = await api<{ data: { scorecards: QcScorecardRow[]; truncated?: boolean } }>(`/reports/qc-scorecards?${qs.toString()}`);
      setScorecards(data.data.scorecards);
      setTruncated(data.data.truncated ?? false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load QC reports");
    } finally {
      setLoading(false);
    }
  }, [from, to, regionId, superintendent, rating, flaggedOnly, search]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { scorecards, truncated, loading, error, refetch };
}
