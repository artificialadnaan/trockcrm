import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface BiggestMover { name: string; actions: number }
export interface RepBreakdown {
  created: number; edits: number; stageMoves: number; uploads: number; emails: number; notes: number; reports: number;
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

/** Fetch the token-guarded daily summary. A bad/missing/expired token yields a friendly error (404). */
export function useDailySummary(token: string) {
  const [data, setData] = useState<DailySummaryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api<{ data: DailySummaryPayload }>(`/public/daily-summary?token=${encodeURIComponent(token)}`)
      .then((res) => { if (live) { setData(res.data); setError(null); } })
      .catch(() => { if (live) setError("This summary link is invalid or has expired."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [token]);

  return { data, loading, error };
}
