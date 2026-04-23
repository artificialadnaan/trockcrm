import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const hookState = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  reset() {
    this.values = [];
    this.index = 0;
  },
  rewind() {
    this.index = 0;
  },
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");

  return {
    ...actual,
    useState: (initialValue: unknown) => {
      const index = hookState.index++;
      if (hookState.values[index] === undefined) {
        hookState.values[index] = initialValue;
      }

      const setState = (value: unknown) => {
        hookState.values[index] =
          typeof value === "function"
            ? (value as (previous: unknown) => unknown)(hookState.values[index])
            : value;
      };

      return [hookState.values[index], setState] as const;
    },
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: (effect: () => void | Promise<void>) => {
      void effect();
    },
  };
});

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

const { useInterventionAnalytics } = await import("./use-ai-ops");

describe("useInterventionAnalytics", () => {
  beforeEach(() => {
    apiMock.mockReset();
    hookState.reset();
  });

  it("fetches intervention analytics dashboard data", async () => {
    apiMock.mockResolvedValueOnce({
      summary: {
        openCases: 1,
        overdueCases: 0,
        escalatedCases: 0,
        snoozeOverdueCases: 0,
        repeatOpenCases: 0,
        openCasesBySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
        overdueCasesBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      },
      outcomes: {
        clearanceRate30d: null,
        reopenRate30d: null,
        averageAgeOfOpenCases: 1,
        medianAgeOfOpenCases: 1,
        averageAgeToResolution: null,
        actionVolume30d: { assign: 0, snooze: 0, resolve: 0, escalate: 0 },
      },
      hotspots: {
        assignees: [],
        disconnectTypes: [],
        reps: [],
        companies: [],
        stages: [],
      },
      breachQueue: {
        items: [],
        totalCount: 0,
        pageSize: 25,
      },
      slaRules: {
        criticalDays: 0,
        highDays: 2,
        mediumDays: 5,
        lowDays: 10,
        timingBasis: "business_days",
      },
    });

    hookState.rewind();
    const initial = useInterventionAnalytics();

    expect(initial.loading).toBe(true);

    await Promise.resolve();

    hookState.rewind();
    const result = useInterventionAnalytics();

    expect(result.data?.summary.openCases).toBe(1);
    expect(apiMock).toHaveBeenCalledWith("/ai/ops/intervention-analytics");
  });
});
