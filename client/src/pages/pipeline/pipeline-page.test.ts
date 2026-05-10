import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDealStageWorkspacePath,
  buildPipelineRequestPath,
  getTerminalDateFilterLabel,
  readTerminalDateFilter,
  writeTerminalDateFilter,
} from "@/lib/pipeline-terminal-filters";
import {
  MAX_EXPORT_PAGES,
  buildDealListParams,
  buildStageNameById,
  fetchAllFilteredDeals,
  getDealDisplayNumber,
  getPipelineListIsActiveFilter,
  summarizeActivePipelineColumns,
  summarizeTerminalStageCounts,
} from "./pipeline-page";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("summarizeTerminalStageCounts", () => {
  it("aggregates canonical and historical terminal outcomes", () => {
    const summary = summarizeTerminalStageCounts([
      {
        stage: { id: "won", name: "Won", slug: "won" },
        deals: [],
        count: 7,
      },
      {
        stage: { id: "won-normal", name: "Sent to Production", slug: "sent_to_production" },
        deals: [],
        count: 2,
      },
      {
        stage: {
          id: "won-service",
          name: "Service - Sent to Production",
          slug: "service_sent_to_production",
        },
        deals: [],
        count: 3,
      },
      {
        stage: { id: "lost-normal", name: "Production Lost", slug: "production_lost" },
        deals: [],
        count: 1,
      },
      {
        stage: { id: "lost-service", name: "Service - Lost", slug: "service_lost" },
        deals: [],
        count: 4,
      },
      {
        stage: { id: "lost", name: "Lost", slug: "lost" },
        deals: [],
        count: 6,
      },
    ]);

    expect(summary).toEqual({ won: 12, lost: 11 });
  });
});

describe("summarizeActivePipelineColumns", () => {
  it("keeps terminal history out of active headline totals", () => {
    const summary = summarizeActivePipelineColumns([
      {
        stage: { id: "estimating", name: "Estimating", slug: "estimating" },
        deals: [
          { id: "deal-1", stageEnteredAt: "2026-04-20T12:00:00.000Z" },
        ],
        count: 30,
        totalValue: 300000,
      },
      {
        stage: { id: "won", name: "Won", slug: "won" },
        deals: [
          { id: "deal-won", stageEnteredAt: "2026-04-18T12:00:00.000Z" },
        ],
        count: 50,
        totalValue: 500000,
      },
    ] as any);

    expect(summary.totalDeals).toBe(30);
    expect(summary.totalValue).toBe(300000);
  });
});

describe("getDealDisplayNumber", () => {
  it("prefers canonical project numbers and marks deal number fallback", () => {
    expect(getDealDisplayNumber({ projectNumber: "DFW-1-12826-aa", dealNumber: "HS-321" })).toEqual({
      label: "DFW-1-12826-aa",
      isFallback: false,
    });
    expect(getDealDisplayNumber({ projectNumber: null, dealNumber: "HS-321" })).toEqual({
      label: "HS-321",
      isFallback: true,
    });
  });
});

describe("pipeline list/export filtering", () => {
  it("uses active-only filtering for non-terminal selections and mixed pipeline visibility for terminal selections", () => {
    expect(getPipelineListIsActiveFilter(["stage-estimating"], ["stage-won", "stage-lost"])).toBe(true);
    expect(getPipelineListIsActiveFilter(["stage-won"], ["stage-won", "stage-lost"])).toBe("pipeline");
    expect(getPipelineListIsActiveFilter([], ["stage-won", "stage-lost"])).toBe("pipeline");
  });

  it("serializes terminal inactive stage ids for mixed list/export requests", () => {
    const params = buildDealListParams({
      search: "roof",
      stageIds: ["stage-estimating", "stage-won"],
      inactiveStageIds: ["stage-won"],
      dateRange: {},
      isActive: "pipeline",
      sort: { key: "updated_at", dir: "desc" },
      page: 1,
      limit: 25,
    });

    expect(params.get("stageIds")).toBe("stage-estimating,stage-won");
    expect(params.get("inactiveStageIds")).toBe("stage-won");
    expect(params.get("isActive")).toBe("pipeline");
  });

  it("caps CSV export pagination at fifty pages and reports truncation", async () => {
    const calls: string[] = [];
    const apiClient = vi.fn(async (path: string) => {
      calls.push(path);
      return {
        deals: [{ id: `deal-${calls.length}` }],
        pagination: { totalPages: MAX_EXPORT_PAGES + 3 },
      };
    });

    const result = await fetchAllFilteredDeals({
      search: "",
      stageIds: [],
      inactiveStageIds: ["stage-won"],
      dateRange: {},
      isActive: "pipeline",
      sort: { key: "updated_at", dir: "desc" },
      apiClient: apiClient as never,
    });

    expect(apiClient).toHaveBeenCalledTimes(MAX_EXPORT_PAGES);
    expect(calls[calls.length - 1]).toContain(`page=${MAX_EXPORT_PAGES}`);
    expect(calls.some((path) => path.includes(`page=${MAX_EXPORT_PAGES + 1}`))).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.deals).toHaveLength(MAX_EXPORT_PAGES);
  });

  it("builds stage labels from the full stage config, including hidden kanban stages", () => {
    const map = buildStageNameById([
      { id: "stage-estimating", name: "Estimating" },
      { id: "stage-dd", name: "DD" },
    ] as never);

    expect(map.get("stage-dd")).toBe("DD");
  });
});

describe("terminal pipeline date filters", () => {
  it("defaults terminal requests to a 30-day window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T16:00:00Z"));

    expect(
      buildPipelineRequestPath(false, {
        won: { preset: "30" },
        lost: { preset: "30" },
      })
    ).toBe("/deals/pipeline?includeDd=false&won_since=2026-04-01&lost_since=2026-04-01");
  });

  it("serializes preset and custom terminal windows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T16:00:00Z"));

    expect(
      buildPipelineRequestPath(true, {
        won: { preset: "60" },
        lost: { preset: "custom", customStart: "2026-03-15", customEnd: "2026-04-15" },
      })
    ).toBe(
      "/deals/pipeline?includeDd=true&won_since=2026-03-02&lost_since=2026-03-15&lost_until=2026-04-15"
    );
    expect(getTerminalDateFilterLabel({ preset: "custom", customStart: "2026-03-15" })).toBe("Custom");
  });

  it("supports 7-day and all-time terminal windows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T16:00:00Z"));

    expect(
      buildPipelineRequestPath(false, {
        won: { preset: "7" },
        lost: { preset: "all" },
      })
    ).toBe("/deals/pipeline?includeDd=false&won_since=2026-04-24&lost_all_time=true");
  });

  it("carries terminal date filters into stage drill-down links", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T16:00:00Z"));

    expect(
      buildDealStageWorkspacePath({
        stageId: "stage-won",
        stageSlug: "won",
        scope: "all",
        filters: {
          won: { preset: "30" },
          lost: { preset: "60" },
        },
      })
    ).toBe("/deals/stages/stage-won?scope=all&won_since=2026-04-01");

    expect(
      buildDealStageWorkspacePath({
        stageId: "stage-estimating",
        stageSlug: "estimating",
        scope: "all",
        filters: {
          won: { preset: "30" },
          lost: { preset: "60" },
        },
      })
    ).toBe("/deals/stages/stage-estimating?scope=all");
  });

  it("persists terminal filters in localStorage", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });

    expect(readTerminalDateFilter("won")).toEqual({ preset: "30" });
    writeTerminalDateFilter("won", { preset: "60" });
    writeTerminalDateFilter("lost", {
      preset: "custom",
      customStart: "2026-04-01",
      customEnd: "2026-04-30",
    });

    expect(readTerminalDateFilter("won")).toEqual({ preset: "60" });
    expect(readTerminalDateFilter("lost")).toEqual({
      preset: "custom",
      customStart: "2026-04-01",
      customEnd: "2026-04-30",
    });
  });
});
