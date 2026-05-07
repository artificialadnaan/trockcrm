import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRepPerformance } from "./use-rep-performance";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

function snapshotRow(overrides: Record<string, unknown>) {
  return {
    repId: "rep-1",
    repName: "Rep One",
    periodKind: "mtd",
    periodStart: "2026-05-01",
    periodEnd: "2026-05-31",
    pipelineValue: 100,
    closedValue: 100,
    dealsCount: 3,
    winsCount: 2,
    lossesCount: 1,
    winRate: 66.67,
    avgDaysToClose: 12,
    atRiskCount: 0,
    activityTotal: 10,
    calls: 4,
    emails: 3,
    meetings: 2,
    notes: 1,
    sparkline8w: [],
    region: null,
    computedAt: "2026-05-07T12:00:00.000Z",
    forecast: 100,
    goal: null,
    goalSource: "none",
    percentToGoal: null,
    forecastVsGoal: {
      forecast: 100,
      goal: null,
      goalSource: "none",
      percentToGoal: null,
    },
    previous: null,
    ...overrides,
  };
}

describe("rep performance deltas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("compares current metrics against the real prior-period snapshot", async () => {
    apiMock.mockResolvedValue({
      data: {
        rows: [
          snapshotRow({
            closedValue: 100,
            previous: {
              pipelineValue: 75,
              closedValue: 80,
              dealsCount: 2,
              winsCount: 1,
              lossesCount: 1,
              winRate: 50,
              avgDaysToClose: 10,
              atRiskCount: 0,
              activityTotal: 8,
              calls: 3,
              emails: 2,
              meetings: 2,
              notes: 1,
            },
          }),
        ],
        forecastVsGoal: {
          forecast: 100,
          goal: null,
          goalSource: "none",
          percentToGoal: null,
        },
      },
    });

    const data = await fetchRepPerformance("month");

    expect(data.reps[0]?.previous?.totalWonValue).toBe(80);
    expect(data.reps[0]?.change.totalWonValue).toBe(20);
    expect(data.reps[0]?.percentChange.totalWonValue).toBe(25);
    expect(data.reps[0]?.current.avgDaysToClose).toBe(12);
    expect(data.reps[0]?.previous?.avgDaysToClose).toBe(10);
    expect(data.reps[0]?.change.avgDaysToClose).toBe(2);
  });

  it("returns null comparison fields when no prior-period snapshot exists", async () => {
    apiMock.mockResolvedValue({
      data: {
        rows: [
          snapshotRow({
            repId: "rep-2",
            repName: "Rep Two",
            closedValue: 50,
            previous: null,
          }),
        ],
        forecastVsGoal: {
          forecast: 50,
          goal: null,
          goalSource: "none",
          percentToGoal: null,
        },
      },
    });

    const data = await fetchRepPerformance("month");

    expect(data.reps[0]?.previous).toBeNull();
    expect(data.reps[0]?.change.totalWonValue).toBeNull();
    expect(data.reps[0]?.percentChange.totalWonValue).toBeNull();
  });
});
