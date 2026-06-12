import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const hook = vi.hoisted(() => ({ ret: { data: null as unknown, loading: false, error: null as string | null } }));
vi.mock("@/hooks/use-daily-summary", () => ({ useDailySummary: () => hook.ret }));

import { DailySummaryPage } from "./daily-summary-page";

const ACTIVE = {
  date: "2026-06-12", office: "dallas", asOfLabel: "as of 5:00 PM CT",
  headline: { activeReps: 2, totalReps: 3, totalActions: 500, biggestMover: { name: "Kaleb", actions: 312 } },
  leaderboard: [{ rank: 1, name: "Kaleb", actions: 312 }, { rank: 2, name: "Adnaan", actions: 188 }, { rank: 3, name: "Zoe", actions: 0 }],
  majorMoves: [{ kind: "won", label: "Anthem on Ashley: Estimating → Won" }, { kind: "advanced", label: "The hayward: Opportunity → Estimating" }],
  teamHealth: { active: 2, quiet: 1, quietNames: ["Zoe"] },
};
const QUIET = {
  date: "2026-06-13", office: "dallas", asOfLabel: "as of 5:00 PM CT",
  headline: { activeReps: 0, totalReps: 3, totalActions: 0, biggestMover: null },
  leaderboard: [{ rank: 1, name: "Kaleb", actions: 0 }],
  majorMoves: [],
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

  it("renders headline, leaderboard, major moves, team health", () => {
    hook.ret = { data: ACTIVE, loading: false, error: null };
    const html = render();
    expect(html).toContain("2/3"); // active / total
    expect(html).toContain("500"); // total actions
    expect(html).toContain("Kaleb");
    expect(html).toContain("Anthem on Ashley: Estimating → Won");
    expect(html).toContain("active");
  });

  it("renders quiet-day + zero-mover states cleanly (no NaN/undefined, no empty section)", () => {
    hook.ret = { data: QUIET, loading: false, error: null };
    const html = render();
    expect(html).toContain("Quiet day — no major moves");
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
