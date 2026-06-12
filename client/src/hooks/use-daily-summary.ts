import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface BiggestMover { name: string; actions: number }
export interface RepBreakdown {
  created: number; edits: number; stageMoves: number; uploads: number; reports: number;
  activities: Record<string, number>;
}
export interface LeaderRow { rank: number; name: string; actions: number; activeMinutes: number | null; breakdown: RepBreakdown }
export interface WonDeal { dealName: string; repName: string; value: number }
export interface AdvancedMove { dealName: string; repName: string; fromStage: string | null; toStage: string | null }
export interface HourCount { hour: number; reps: number }
export interface DailySummaryPayload {
  date: string;
  office: string;
  asOfLabel: string;
  headline: { activeReps: number; totalReps: number; totalActions: number; totalActiveMinutes: number; totalSessions: number; biggestMover: BiggestMover | null };
  wonToday: WonDeal[];
  advancedToday: AdvancedMove[];
  leaderboard: LeaderRow[];
  hourly: HourCount[];
  teamHealth: { active: number; quiet: number; quietNames: string[] };
}

const ZERO_BREAKDOWN: RepBreakdown = { created: 0, edits: 0, stageMoves: 0, uploads: 0, reports: 0, activities: {} };

/**
 * Tolerate legacy snapshots. Pre-redesign snapshots (still valid until their 30-day expiry) were stored
 * with the old shape (majorMoves, no wonToday/advancedToday/hourly, leaderboard rows without
 * activeMinutes/breakdown). Reading the frozen JSONB as-is would crash the new page; coerce missing fields
 * so an old leadership link renders gracefully (its sections just read empty) instead of throwing.
 */
export function normalizeSummary(p: Partial<DailySummaryPayload> | null | undefined): DailySummaryPayload {
  const h = p?.headline ?? ({} as Partial<DailySummaryPayload["headline"]>);
  return {
    date: p?.date ?? "",
    office: p?.office ?? "",
    asOfLabel: p?.asOfLabel ?? "as of 5:00 PM CT",
    headline: {
      activeReps: h.activeReps ?? 0,
      totalReps: h.totalReps ?? 0,
      totalActions: h.totalActions ?? 0,
      totalActiveMinutes: h.totalActiveMinutes ?? 0,
      totalSessions: h.totalSessions ?? 0,
      biggestMover: h.biggestMover ?? null,
    },
    wonToday: Array.isArray(p?.wonToday) ? p!.wonToday : [],
    advancedToday: Array.isArray(p?.advancedToday) ? p!.advancedToday : [],
    leaderboard: Array.isArray(p?.leaderboard)
      ? p!.leaderboard.map((r) => ({ ...r, activeMinutes: r.activeMinutes ?? null, breakdown: { ...ZERO_BREAKDOWN, ...(r.breakdown ?? {}) } }))
      : [],
    hourly: Array.isArray(p?.hourly) ? p!.hourly : [],
    teamHealth: p?.teamHealth ?? { active: 0, quiet: 0, quietNames: [] },
  };
}

/** Fetch the token-guarded daily summary. A bad/missing/expired token yields a friendly error (404). */
export function useDailySummary(token: string) {
  const [data, setData] = useState<DailySummaryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api<{ data: DailySummaryPayload }>(`/public/daily-summary?token=${encodeURIComponent(token)}`)
      .then((res) => { if (live) { setData(normalizeSummary(res.data)); setError(null); } })
      .catch(() => { if (live) setError("This summary link is invalid or has expired."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [token]);

  return { data, loading, error };
}
