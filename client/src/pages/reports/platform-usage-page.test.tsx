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

import { PlatformUsagePage } from "./platform-usage-page";

describe("PlatformUsagePage", () => {
  it("renders the team summary and a rep leaderboard", () => {
    const html = renderToStaticMarkup(<MemoryRouter><PlatformUsagePage /></MemoryRouter>).replace(/\s+/g, " ");
    expect(html).toContain("Platform Usage");
    expect(html).toContain("Kaleb");
    expect(html).toContain("Adnaan");
  });
});
