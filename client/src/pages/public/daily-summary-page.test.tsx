import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const hook = vi.hoisted(() => ({ ret: { data: null as unknown, loading: false, error: null as string | null } }));
vi.mock("@/hooks/use-daily-summary", () => ({ useDailySummary: () => hook.ret }));

import { DailySummaryPage } from "./daily-summary-page";

const ZERO = { created: 0, edits: 0, stageMoves: 0, uploads: 0, reports: 0, activities: {} as Record<string, number> };
const ACTIVE = {
  date: "2026-06-12", office: "dallas", asOfLabel: "as of 5:00 PM CT",
  headline: { activeReps: 2, totalReps: 3, totalActions: 500, totalActiveMinutes: 150, totalSessions: 8, biggestMover: { name: "Kaleb", actions: 312 } },
  wonToday: [{ dealName: "Anthem on Ashley", repName: "Kaleb Marshall", value: 186000 }],
  advancedToday: [{ dealName: "The Hayward", repName: "Adnaan", fromStage: "Opportunity", toStage: "Estimating" }],
  leaderboard: [
    { rank: 1, name: "Kaleb", actions: 312, activeMinutes: 56, breakdown: { ...ZERO, created: 50, edits: 15, stageMoves: 2, activities: { email: 22 } } },
    // A worker with actions but NO browser session — must show "—", NEVER "0m".
    { rank: 2, name: "Adnaan", actions: 188, activeMinutes: null, breakdown: { ...ZERO, created: 21, reports: 26 } },
    { rank: 3, name: "Zoe", actions: 0, activeMinutes: null, breakdown: { ...ZERO } },
  ],
  hourly: [{ hour: 8, reps: 4 }, { hour: 12, reps: 7 }],
  teamHealth: { active: 2, quiet: 1, quietNames: ["Zoe"] },
};
const QUIET = {
  date: "2026-06-13", office: "dallas", asOfLabel: "as of 5:00 PM CT",
  headline: { activeReps: 0, totalReps: 3, totalActions: 0, totalActiveMinutes: 0, totalSessions: 0, biggestMover: null },
  wonToday: [],
  advancedToday: [],
  leaderboard: [{ rank: 1, name: "Kaleb", actions: 0, activeMinutes: null, breakdown: { ...ZERO } }],
  hourly: [],
  teamHealth: { active: 0, quiet: 3, quietNames: ["Kaleb", "Adnaan", "Zoe"] },
};

beforeEach(() => { hook.ret = { data: null, loading: false, error: null }; });

function render() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/daily-summary/2026-06-12?token=abc"]}>
      <Routes><Route path="/daily-summary/:date" element={<DailySummaryPage />} /></Routes>
    </MemoryRouter>,
  ).replace(/\s+/g, " ");
}

describe("DailySummaryPage", () => {
  it("renders the snapshot with the 'as of 5:00 PM CT' framing", () => {
    hook.ret = { data: ACTIVE, loading: false, error: null };
    const html = render();
    expect(html).toContain("Daily Pulse");
    expect(html).toContain("as of 5:00 PM CT");
    expect(html).toContain("Snapshot as of 5:00 PM CT"); // footer framing — not a complete daily total
  });

  it("renders named Won today, Advanced today, and the per-rep breakdown", () => {
    hook.ret = { data: ACTIVE, loading: false, error: null };
    const html = render();
    expect(html).toContain("2/3"); // active / total
    expect(html).toContain("Won today");
    expect(html).toContain("Anthem on Ashley");
    expect(html).toContain("$186,000"); // full value
    expect(html).toContain("The Hayward");
    expect(html).toContain("Opportunity"); // from-stage of the advance
    expect(html).toContain("50 created"); // breakdown is the value, not a bar
    expect(html).toContain("Activity by hour");
    expect(html).toContain("2.5h"); // team time spent (150 min) surfaced in the headline
    expect(html).toContain("Time"); // the Time stat label
  });

  it("enforces the time rule: present -> minutes, absent -> '—', NEVER '0m'", () => {
    hook.ret = { data: ACTIVE, loading: false, error: null };
    const html = render();
    expect(html).toContain("56m"); // Kaleb has a real session
    expect(html).not.toContain("0m"); // Adnaan (188 actions, no session) must be "—", never "0m idle"
  });

  it("renders quiet-day + zero-mover states cleanly (no NaN/undefined, no empty section)", () => {
    hook.ret = { data: QUIET, loading: false, error: null };
    const html = render();
    expect(html).toContain("No deals won today.");
    expect(html).toContain("No stage advances today.");
    expect(html).toContain("Quiet day — no rep activity yet");
    expect(html).toContain("—"); // biggest-mover zero-guard
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });

  it("shows a friendly error for a bad/expired token", () => {
    hook.ret = { data: null, loading: false, error: "This summary link is invalid or has expired." };
    const html = render();
    expect(html).toContain("This summary link is invalid or has expired.");
  });
});
