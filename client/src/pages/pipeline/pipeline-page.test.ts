import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDealStageWorkspacePath,
  buildPipelineRequestPath,
  clampDateToToday,
  getTerminalDateFilterLabel,
  readTerminalDateFilter,
  readTerminalDateFiltersFromSearchParams,
  writeTerminalDateFilter,
} from "@/lib/pipeline-terminal-filters";
import {
  MAX_EXPORT_PAGES,
  buildDealListParams,
  buildStageNameById,
  fetchAllFilteredDeals,
  getDealDisplayNumber,
  getPipelineListIsActiveFilter,
  getPipelineListQueryState,
  getVisibleTerminalStageIds,
  summarizeActivePipelineColumns,
  summarizeTerminalStageCounts,
} from "./pipeline-page";
import pipelinePageSource from "./pipeline-page.tsx?raw";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("summarizeTerminalStageCounts", () => {
  it("aggregates canonical and historical terminal outcomes", () => {
    const summary = summarizeTerminalStageCounts([
      {
        stage: { id: "won", name: "Won", slug: "won" },
        count: 7,
        totalValue: 700000,
      },
      {
        stage: { id: "won-normal", name: "Sent to Production", slug: "sent_to_production" },
        count: 2,
        totalValue: 200000,
      },
      {
        stage: {
          id: "won-service",
          name: "Service - Sent to Production",
          slug: "service_sent_to_production",
        },
        count: 3,
        totalValue: 300000,
      },
      {
        stage: { id: "lost-normal", name: "Production Lost", slug: "production_lost" },
        count: 1,
        totalValue: 0,
      },
      {
        stage: { id: "lost-service", name: "Service - Lost", slug: "service_lost" },
        count: 4,
        totalValue: 0,
      },
      {
        stage: { id: "lost", name: "Lost", slug: "lost" },
        count: 6,
        totalValue: 0,
      },
    ]);

    expect(summary).toEqual({ won: 12, lost: 11 });
  });
});

describe("pipeline DD toggle label", () => {
  it("uses a clear Show DD stages label with explanatory switch text", () => {
    expect(pipelinePageSource).toContain("Show DD stages");
    expect(pipelinePageSource).toContain("Show due diligence stages in the pipeline");
    expect(pipelinePageSource).not.toContain(">Show DD<");
  });

  it("does not render the legacy New Deal button", () => {
    expect(pipelinePageSource).not.toContain('navigate("/deals/new")');
    expect(pipelinePageSource).not.toContain("New Deal");
  });

  it("routes drag-drop stage moves through the StageChangeDialog preflight flow", () => {
    expect(pipelinePageSource).toContain("setPendingMove({ deal, targetStageId })");
    expect(pipelinePageSource).toContain("<StageChangeDialog");
    expect(pipelinePageSource).not.toContain("changeDealStage(");
  });
});

describe("summarizeActivePipelineColumns", () => {
  it("keeps terminal history out of active headline totals", () => {
    const summary = summarizeActivePipelineColumns([
      {
        stage: { id: "estimating", name: "Estimating", slug: "estimating" },
        deals: [{ id: "deal-1", stageEnteredAt: "2026-04-20T12:00:00.000Z" }],
        count: 31,
        totalValue: 1200000,
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

    expect(summary.totalDeals).toBe(31);
    expect(summary.totalValue).toBe(1200000);
  });

  it("uses backend aggregates instead of truncated card arrays", () => {
    const summary = summarizeActivePipelineColumns([
      {
        stage: { id: "opportunity", name: "Opportunity", slug: "opportunity" },
        deals: Array.from({ length: 100 }, (_, index) => ({
          id: `opportunity-${index}`,
          stageEnteredAt: "2026-04-20T12:00:00.000Z",
        })),
        count: 150,
        totalValue: 1500000,
      },
      {
        stage: { id: "service", name: "Service Estimating", slug: "service_estimating" },
        deals: [{ id: "service-1", stageEnteredAt: "2026-04-20T12:00:00.000Z" }],
        count: 2,
        totalValue: 50000,
      },
      {
        stage: { id: "lost", name: "Lost", slug: "lost" },
        deals: [{ id: "lost-1", stageEnteredAt: "2026-04-18T12:00:00.000Z" }],
        count: 75,
        totalValue: 750000,
      },
    ] as any);

    expect(summary.totalDeals).toBe(152);
    expect(summary.totalValue).toBe(1550000);
  });
});

describe("getDealDisplayNumber", () => {
  it("prefers canonical project numbers and never exposes the HubSpot ID to users", () => {
    expect(getDealDisplayNumber({ projectNumber: "DFW-1-12826-aa", dealNumber: "HS-321" })).toEqual({
      label: "DFW-1-12826-aa",
      isFallback: false,
      isPending: false,
    });
    expect(getDealDisplayNumber({ projectNumber: null, dealNumber: "HS-321" })).toEqual({
      label: "Pending",
      isFallback: true,
      isPending: true,
    });
  });
});

describe("pipeline list/export filtering", () => {
  it("builds terminal stage ids only from terminal stages visible in the current board", () => {
    const terminalStageIds = getVisibleTerminalStageIds(
      [
        { id: "stage-estimating", slug: "estimating", name: "Estimating", isTerminal: false },
        { id: "stage-won", slug: "won", name: "Won", isTerminal: true },
        { id: "legacy-closed-won", slug: "closed_won", name: "Closed Won", isTerminal: true },
        { id: "legacy-production-lost", slug: "production_lost", name: "Production Lost", isTerminal: true },
      ] as never,
      [
        { id: "stage-estimating", slug: "estimating", name: "Estimating" },
        { id: "stage-won", slug: "won", name: "Won" },
      ]
    );

    expect(terminalStageIds).toEqual(["stage-won"]);
  });

  it("keeps non-terminal list selections enabled while pipeline stage metadata is unresolved", () => {
    expect(
      getPipelineListQueryState({
        selectedStageIds: ["stage-estimating"],
        terminalStageIds: [],
        stagesLoading: true,
        stagesError: null,
        selectedStageStatusKnown: true,
      })
    ).toMatchObject({ enabled: true, isActive: true, inactiveStageIds: [] });

    expect(
      getPipelineListQueryState({
        selectedStageIds: ["stage-won"],
        terminalStageIds: [],
        stagesLoading: true,
        stagesError: null,
        selectedStageStatusKnown: false,
      })
    ).toMatchObject({ enabled: false, isActive: "pipeline", inactiveStageIds: [] });

    expect(
      getPipelineListQueryState({
        selectedStageIds: [],
        terminalStageIds: [],
        stagesLoading: true,
        stagesError: null,
      })
    ).toMatchObject({ enabled: false, inactiveStageIds: [] });

    expect(
      getPipelineListQueryState({
        selectedStageIds: [],
        terminalStageIds: [],
        stagesLoading: false,
        stagesError: "Failed to load stages",
      })
    ).toMatchObject({ enabled: false, inactiveStageIds: [] });
  });

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
  it("defaults terminal requests to all-time windows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T16:00:00Z"));

    expect(
      buildPipelineRequestPath(false, {
        won: { preset: "all" },
        lost: { preset: "all" },
      })
    ).toBe("/deals/pipeline?includeDd=false&won_all_time=true&lost_all_time=true");
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

  it("supports 90-day terminal windows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T16:00:00Z"));

    expect(
      buildPipelineRequestPath(false, {
        won: { preset: "90" },
        lost: { preset: "90" },
      })
    ).toBe("/deals/pipeline?includeDd=false&won_since=2026-01-31&lost_since=2026-01-31");
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
        queryParams: new URLSearchParams("assignedRepId=rep-1&estimate_sent_since=2026-04-01&estimate_sent_until=2026-04-30&search=roof"),
      })
    ).toBe("/deals/stages/stage-estimating?scope=all&assignedRepId=rep-1&estimate_sent_since=2026-04-01&estimate_sent_until=2026-04-30");
  });

  it("clamps future custom dates from URL and API serialization", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T14:00:00Z"));

    expect(clampDateToToday("2999-01-01")).toBe("2026-05-12");
    expect(
      readTerminalDateFiltersFromSearchParams(
        new URLSearchParams("won_since=2999-01-01&lost_since=2026-05-01&lost_until=2999-02-01")
      )
    ).toEqual({
      won: { preset: "custom", customStart: "2026-05-12", customEnd: undefined },
      lost: { preset: "custom", customStart: "2026-05-01", customEnd: "2026-05-12" },
    });
    expect(
      buildPipelineRequestPath(false, {
        won: { preset: "custom", customStart: "2999-01-01" },
        lost: { preset: "custom", customStart: "2026-05-01", customEnd: "2999-02-01" },
      })
    ).toBe("/deals/pipeline?includeDd=false&won_since=2026-05-12&lost_since=2026-05-01&lost_until=2026-05-12");
  });

  it("does not let old localStorage values create hidden page filters", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });

    writeTerminalDateFilter("won", { preset: "30" });
    writeTerminalDateFilter("lost", { preset: "60" });

    expect(readTerminalDateFiltersFromSearchParams(new URLSearchParams())).toEqual({
      won: { preset: "all" },
      lost: { preset: "all" },
    });
    expect(
      readTerminalDateFiltersFromSearchParams(new URLSearchParams("won_preset=90&lost_preset=7"))
    ).toEqual({
      won: { preset: "90" },
      lost: { preset: "7" },
    });
  });

  it("persists terminal filters in localStorage", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });

    expect(readTerminalDateFilter("won")).toEqual({ preset: "all" });
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
