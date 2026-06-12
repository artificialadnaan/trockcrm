import { describe, expect, it } from "vitest";
import { normalizeSummary } from "./use-daily-summary";

describe("normalizeSummary — tolerate legacy snapshots", () => {
  it("coerces a pre-redesign payload (majorMoves, no wonToday/hourly) to safe defaults — no crash", () => {
    // Shape stored by #686 before the redesign; still valid until its 30-day expiry.
    const legacy = {
      date: "2026-06-10", office: "dallas", asOfLabel: "as of 5:00 PM CT",
      headline: { activeReps: 2, totalReps: 3, totalActions: 40, biggestMover: { name: "Kaleb", actions: 22 } },
      leaderboard: [{ rank: 1, name: "Kaleb", actions: 22 }],
      majorMoves: [{ kind: "won", label: "X: A → Won" }],
      teamHealth: { active: 2, quiet: 1, quietNames: ["Zoe"] },
    } as unknown as Parameters<typeof normalizeSummary>[0];

    const n = normalizeSummary(legacy);
    expect(n.wonToday).toEqual([]);
    expect(n.advancedToday).toEqual([]);
    expect(n.hourly).toEqual([]);
    expect(n.headline.totalActiveMinutes).toBe(0);
    expect(n.headline.totalSessions).toBe(0);
    // legacy leaderboard rows get safe activeMinutes/breakdown so the page can't throw
    expect(n.leaderboard[0].activeMinutes).toBeNull();
    expect(n.leaderboard[0].breakdown.activities).toEqual({});
    expect(n.leaderboard[0].breakdown.created).toBe(0);
  });

  it("passes a current payload through unchanged in shape", () => {
    const n = normalizeSummary({
      date: "2026-06-12", office: "dallas", asOfLabel: "as of 5:00 PM CT",
      headline: { activeReps: 1, totalReps: 1, totalActions: 5, totalActiveMinutes: 30, totalSessions: 2, biggestMover: null },
      wonToday: [{ dealName: "D", repName: "R", value: 1000 }],
      advancedToday: [],
      leaderboard: [{ rank: 1, name: "R", actions: 5, activeMinutes: 30, breakdown: { created: 5, edits: 0, stageMoves: 0, uploads: 0, reports: 0, activities: { call: 1 } } }],
      hourly: [{ hour: 9, reps: 1 }],
      teamHealth: { active: 1, quiet: 0, quietNames: [] },
    });
    expect(n.wonToday).toHaveLength(1);
    expect(n.headline.totalActiveMinutes).toBe(30);
    expect(n.leaderboard[0].breakdown.activities).toEqual({ call: 1 });
  });
});
