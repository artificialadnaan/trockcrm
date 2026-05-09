import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRepPerformance, normalizeRepPerformancePeriod } from "./use-rep-performance";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

describe("use-rep-performance helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps legacy page periods to snapshot period kinds", () => {
    expect(normalizeRepPerformancePeriod("month")).toBe("mtd");
    expect(normalizeRepPerformancePeriod("quarter")).toBe("qtd");
    expect(normalizeRepPerformancePeriod("year")).toBe("ytd");
    expect(normalizeRepPerformancePeriod("last_month")).toBe("last_month");
    expect(normalizeRepPerformancePeriod("last_quarter")).toBe("last_quarter");
    expect(normalizeRepPerformancePeriod("last_year")).toBe("last_year");
  });

  it("fetches historical snapshot period kinds without remapping them to current periods", async () => {
    apiMock.mockResolvedValue({
      data: {
        rows: [],
        forecastVsGoal: {
          forecast: 0,
          goal: null,
          goalSource: "none",
          percentToGoal: null,
        },
      },
    });

    await fetchRepPerformance("last_month");
    await fetchRepPerformance("last_quarter");
    await fetchRepPerformance("last_year");

    expect(apiMock).toHaveBeenNthCalledWith(1, "/dashboard/director/rep-performance?periodKind=last_month");
    expect(apiMock).toHaveBeenNthCalledWith(2, "/dashboard/director/rep-performance?periodKind=last_quarter");
    expect(apiMock).toHaveBeenNthCalledWith(3, "/dashboard/director/rep-performance?periodKind=last_year");
  });

  it("fetches director rep-performance snapshots and preserves no-goal state", async () => {
    apiMock.mockResolvedValue({
      data: {
        rows: [
          {
            repId: "rep-1",
            repName: "Rep One",
            periodKind: "mtd",
            periodStart: "2026-05-01",
            periodEnd: "2026-05-07",
            pipelineValue: 125000,
            closedValue: 50000,
            dealsCount: 3,
            winsCount: 1,
            lossesCount: 0,
            winRate: 100,
            avgDaysToClose: 14,
            atRiskCount: 2,
            activityTotal: 9,
            calls: 3,
            emails: 4,
            meetings: 1,
            notes: 1,
            sparkline8w: [0, 0, 0, 0, 0, 0, 25000, 50000],
            region: "North",
            computedAt: "2026-05-07T12:00:00.000Z",
            forecast: 125000,
            goal: null,
            goalSource: "none",
            percentToGoal: null,
            forecastVsGoal: {
              forecast: 125000,
              goal: null,
              goalSource: "none",
              percentToGoal: null,
            },
            previous: null,
          },
        ],
        forecastVsGoal: {
          forecast: 125000,
          goal: null,
          goalSource: "none",
          percentToGoal: null,
        },
      },
    });

    const data = await fetchRepPerformance("month");

    expect(apiMock).toHaveBeenCalledWith("/dashboard/director/rep-performance?periodKind=mtd");
    expect(data.forecastVsGoal).toEqual({
      forecast: 125000,
      goal: null,
      goalSource: "none",
      percentToGoal: null,
    });
    expect(data.reps[0]?.current).toMatchObject({
      dealsWon: 1,
      totalWonValue: 50000,
      activitiesLogged: 9,
      winRate: 100,
      avgDaysToClose: 14,
    });
  });
});
