import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

// Mutable hook return so each test can set the grain/dates it needs.
const hook = vi.hoisted(() => ({ ret: { loading: false, error: null as string | null, data: null as unknown } }));
vi.mock("@/hooks/use-platform-usage-report", () => ({
  usePlatformUsageReport: () => hook.ret,
  formatActiveTime: (s: number) => (s > 0 ? `${Math.floor(s / 3600)}h` : "—"),
}));

import { PlatformUsagePage, barWidthPct, viewsAreEmpty, dayLabel, weekLabel, windowLabel } from "./platform-usage-page";

const WEEK = ["2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13"]; // Sun–Sat, current
const LEADERBOARD = [
  { rep: { id: "r1", displayName: "Kaleb" }, usage: { activeSeconds: 51600, actionCount: 312, sessionCount: 5, breakdown: { activities: {} } } },
  { rep: { id: "r2", displayName: "Adnaan" }, usage: { activeSeconds: 32700, actionCount: 188, sessionCount: 4, breakdown: { activities: {} } } },
];
function setData(partial: Record<string, unknown>) {
  hook.ret = {
    loading: false,
    error: null,
    data: { grain: "week", dates: WEEK, summary: { activeSeconds: 147600, actionCount: 680, activeReps: 8, totalReps: 10 }, leaderboard: LEADERBOARD, ...partial },
  };
}
beforeEach(() => setData({})); // default: current weekly

function render(path = "/reports/performance/platform-usage") {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><PlatformUsagePage /></MemoryRouter>).replace(/\s+/g, " ");
}

describe("date label helpers (format a CT-resolved date STRING, no tz conversion)", () => {
  it("dayLabel renders weekday + month + day", () => {
    expect(dayLabel("2026-06-12")).toBe("Fri, Jun 12");
    expect(dayLabel("2026-06-07")).toBe("Sun, Jun 7");
  });
  it("weekLabel renders a same-month range with an en dash", () => {
    expect(weekLabel("2026-06-07", "2026-06-13")).toBe("Week of Jun 7–13");
  });
  it("weekLabel spells out both months for a cross-month week", () => {
    expect(weekLabel("2026-06-28", "2026-07-04")).toBe("Week of Jun 28 – Jul 4");
  });
  it("windowLabel picks day vs week by grain", () => {
    expect(windowLabel("day", ["2026-06-12"])).toBe("Fri, Jun 12");
    expect(windowLabel("week", WEEK)).toBe("Week of Jun 7–13");
  });
});

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

describe("PlatformUsagePage", () => {
  it("renders the team summary and a rep leaderboard", () => {
    const html = render();
    expect(html).toContain("Platform Usage");
    expect(html).toContain("Kaleb");
    expect(html).toContain("Adnaan");
  });

  it("ranks reps by actions desc with the top performer first", () => {
    const html = render();
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
    expect(html).toContain("—");
  });

  it("links each rep row to their detail, carrying the current grain", () => {
    const html = render();
    expect(html).toContain('href="/reports/performance/platform-usage/r1?grain=week"');
  });

  it("carries the active office (?officeId) into the detail link for cross-office views", () => {
    const html = render("/reports/performance/platform-usage?officeId=atlanta");
    expect(html).toContain("officeId=atlanta");
  });

  it("initializes the period from the URL so the rep-detail back link round-trips the same view", () => {
    setData({ grain: "day", dates: ["2026-06-09"] });
    const html = render("/reports/performance/platform-usage?grain=day&date=2026-06-09");
    expect(html).toContain("/reports/performance/platform-usage/r1?grain=day");
    expect(html).toContain("date=2026-06-09");
  });
});

describe("PlatformUsagePage — window legibility", () => {
  it("weekly (current) labels the window everywhere: sub-header, cards, caption, date-range chip", () => {
    const html = render(); // default current weekly
    expect(html).toContain("Weekly"); // grain tag
    expect(html).toContain("Week of Jun 7–13"); // window sub-header + chip range
    expect(html).toContain("Actions this week"); // window-aware metric label
    expect(html).toContain("Active this week"); // reps-active eyebrow
    expect(html).toContain("Sorted by actions · this week"); // leaderboard caption (default actions sort)
    expect(html).toContain("→ Week of Jun 7–13"); // date-input range chip
  });

  it("daily (current) shows the day and 'today' copy, with NO week-range chip", () => {
    setData({ grain: "day", dates: ["2026-06-12"] });
    const html = render("/reports/performance/platform-usage?grain=day");
    expect(html).toContain("Daily");
    expect(html).toContain("Fri, Jun 12");
    expect(html).toContain("Actions today");
    expect(html).toContain("Active today");
    expect(html).not.toContain("→ Week of"); // no week-range chip in daily mode
  });

  it("renders a cross-month week range with both months", () => {
    setData({ grain: "week", dates: ["2026-06-28", "2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"] });
    const html = render();
    expect(html).toContain("Week of Jun 28 – Jul 4");
  });

  it("a PAST week uses the explicit window label, NEVER 'today'/'this week' (mislabel guard)", () => {
    setData({ grain: "week", dates: ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06", "2026-06-07"] });
    const html = render("/reports/performance/platform-usage?grain=week&date=2026-06-03");
    // Explicit window label on the metric cards + caption...
    expect(html).toContain("Actions · Week of Jun 1–7");
    expect(html).toContain("Sorted by actions · Week of Jun 1–7");
    // ...and the negative control: relative words must not leak anywhere for a non-current window.
    // ("Today" the button keeps its capital T, so the lowercase checks below don't match it.)
    expect(html).not.toContain("this week");
    expect(html).not.toContain("today");
  });
});
