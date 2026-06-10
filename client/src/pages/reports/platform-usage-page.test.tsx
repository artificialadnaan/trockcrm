import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/hooks/use-platform-usage-report", () => ({
  usePlatformUsageReport: () => ({
    loading: false,
    error: null,
    data: {
      grain: "week",
      dates: ["2026-06-08"],
      summary: { activeSeconds: 147600, actionCount: 680, activeReps: 8, totalReps: 10 },
      leaderboard: [
        { rep: { id: "r1", displayName: "Kaleb" }, usage: { activeSeconds: 51600, actionCount: 312, sessionCount: 5, breakdown: { activities: {} } } },
        { rep: { id: "r2", displayName: "Adnaan" }, usage: { activeSeconds: 32700, actionCount: 188, sessionCount: 4, breakdown: { activities: {} } } },
      ],
    },
  }),
  formatActiveTime: (s: number) => (s > 0 ? `${Math.floor(s / 3600)}h` : "—"),
}));

import { PlatformUsagePage, barWidthPct, viewsAreEmpty } from "./platform-usage-page";

describe("viewsAreEmpty", () => {
  it("renders muted — only when the rep has no telemetry (no session)", () => {
    expect(viewsAreEmpty(0, 0)).toBe(true); // not-yet-populated
    expect(viewsAreEmpty(undefined, 4)).toBe(true); // field absent
  });
  it("renders a real 0 once the rep has a session (telemetry present)", () => {
    expect(viewsAreEmpty(0, 4)).toBe(false); // genuine 0 views, not "—"
    expect(viewsAreEmpty(12, 4)).toBe(false);
  });
});

describe("barWidthPct", () => {
  it("gives zero-action reps an EMPTY bar (no phantom sliver that contradicts the 0)", () => {
    expect(barWidthPct(0, 312)).toBe(0);
  });
  it("floors positive counts to a visible minimum and tops out at 100", () => {
    expect(barWidthPct(1, 312)).toBe(2);
    expect(barWidthPct(312, 312)).toBe(100);
  });
  it("is 0 when there is no max", () => {
    expect(barWidthPct(5, 0)).toBe(0);
  });
});

function render() {
  return renderToStaticMarkup(<MemoryRouter><PlatformUsagePage /></MemoryRouter>).replace(/\s+/g, " ");
}

describe("PlatformUsagePage", () => {
  it("renders the team summary and a rep leaderboard", () => {
    const html = render();
    expect(html).toContain("Platform Usage");
    expect(html).toContain("Kaleb");
    expect(html).toContain("Adnaan");
  });

  it("ranks reps by actions desc with the top performer first", () => {
    const html = render();
    // Kaleb (312 actions) outranks Adnaan (188) regardless of the data order.
    expect(html.indexOf("Kaleb")).toBeLessThan(html.indexOf("Adnaan"));
    expect(html).toContain("312");
    expect(html).toContain("188");
  });

  it("renders the reps-active card with the healthy treatment when a healthy fraction is active", () => {
    const html = render();
    expect(html).toContain("8/10"); // activeReps/totalReps
    expect(html).toContain("Healthy"); // 8/10 >= 0.5 -> success, not the red alarm
    expect(html).not.toContain("All quiet");
  });

  it("shows real session counts but a muted em-dash for absent view telemetry", () => {
    const html = render();
    expect(html).toContain("—"); // Views are undefined in the fixture -> em-dash, never literal 0
  });

  it("links each rep row to their detail, carrying the current grain", () => {
    const html = render();
    // Default grain is weekly; the row links to the rep detail with the period carried.
    expect(html).toContain('href="/reports/performance/platform-usage/r1?grain=week"');
  });
});
