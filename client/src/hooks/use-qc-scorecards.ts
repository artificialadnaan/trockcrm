import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
  region?: string;
  superintendent?: string;
  rating?: string;
  flaggedOnly?: boolean;
  search?: string;
}

interface QcScorecardsResponse {
  scorecards: QcScorecardRow[];
  truncated?: boolean;
  regions?: string[];
  superintendents?: string[];
}

/**
 * Office-scoped QC dashboard feed. ALL filters are applied server-side (before the row cap), so a match
 * older than the cap window is never dropped. `regions`/`superintendents` are the window-wide option lists
 * (independent of the active filters) so the dropdowns never empty each other.
 */
export function useQcScorecards(filters: QcScorecardFilters) {
  const [searchParams] = useSearchParams();
  const officeId = searchParams.get("officeId"); // api() routes on this; changing office must refetch

  const [scorecards, setScorecards] = useState<QcScorecardRow[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [superintendents, setSuperintendents] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { from, to, region, superintendent, rating, flaggedOnly, search } = filters;

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      if (region) qs.set("region", region);
      if (superintendent) qs.set("superintendent", superintendent);
      if (rating) qs.set("rating", rating);
      if (flaggedOnly) qs.set("flaggedOnly", "true");
      if (search) qs.set("search", search);
      const res = await api<{ data: QcScorecardsResponse }>(`/reports/qc-scorecards?${qs.toString()}`);
      setScorecards(res.data.scorecards);
      setTruncated(res.data.truncated ?? false);
      setRegions(res.data.regions ?? []);
      setSuperintendents(res.data.superintendents ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load QC reports");
    } finally {
      setLoading(false);
    }
  }, [from, to, region, superintendent, rating, flaggedOnly, search, officeId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { scorecards, regions, superintendents, truncated, loading, error, refetch };
}
