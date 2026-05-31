import { afterEach, describe, expect, it, vi } from "vitest";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import {
  getStagePageListStageIds,
  isWonStagePageStage,
  mapStageRouteFiltersToDealFilters,
  normalizeStagePageQuery,
} from "./pipeline-stage-page";

describe("normalizeStagePageQuery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the raw stage sort token so each route can normalize its own sort family", () => {
    expect(
      normalizeStagePageQuery({
        sort: "bad",
        page: "wat",
        search: "acme",
        staleOnly: "true",
        workflowRoute: "service",
      })
    ).toEqual({
      page: 1,
      pageSize: 25,
      sort: "bad",
      search: "acme",
        filters: {
          assignedRepId: undefined,
          estimateSentFrom: undefined,
          estimateSentTo: undefined,
          staleOnly: true,
        status: undefined,
        workflowRoute: "service",
        source: undefined,
        regionId: undefined,
        updatedAfter: undefined,
        updatedBefore: undefined,
        minAgeDays: undefined,
        maxAgeDays: undefined,
        wonSince: undefined,
        wonUntil: undefined,
        wonAllTime: false,
        lostSince: undefined,
        lostUntil: undefined,
        lostAllTime: false,
      },
    });
  });

  it("preserves terminal stage date filters for deal drill-down pages", () => {
    expect(
      normalizeStagePageQuery({
        won_since: "2026-04-01",
        won_until: "2026-04-30",
        lost_since: "2026-03-01",
        lost_until: "2026-03-31",
      }).filters
    ).toMatchObject({
      wonSince: "2026-04-01",
      wonUntil: "2026-04-30",
      lostSince: "2026-03-01",
      lostUntil: "2026-03-31",
    });
  });

  it("materializes Estimate Sent presets into concrete stage-page date filters", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T16:00:00Z"));

    expect(
      normalizeStagePageQuery({
        assignedRepId: "rep-1",
        estimate_sent_preset: "30",
      }).filters
    ).toMatchObject({
      assignedRepId: "rep-1",
      estimateSentFrom: "2026-04-22",
      estimateSentTo: undefined,
    });
  });

  it("materializes Estimate Sent MTD, QTD, and YTD presets into concrete stage-page date filters", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T16:00:00Z"));

    expect(normalizeStagePageQuery({ estimate_sent_preset: "mtd" }).filters).toMatchObject({
      estimateSentFrom: "2026-05-01",
      estimateSentTo: "2026-05-22",
    });
    expect(normalizeStagePageQuery({ estimate_sent_preset: "qtd" }).filters).toMatchObject({
      estimateSentFrom: "2026-04-01",
      estimateSentTo: "2026-05-22",
    });
    expect(normalizeStagePageQuery({ estimate_sent_preset: "ytd" }).filters).toMatchObject({
      estimateSentFrom: "2026-01-01",
      estimateSentTo: "2026-05-22",
    });
  });

  it("materializes the WTD Estimate Sent preset into a Sunday-anchored stage-page window", () => {
    vi.useFakeTimers();
    // 2026-05-22 is a Friday; the most recent Sunday is 2026-05-17.
    vi.setSystemTime(new Date("2026-05-22T16:00:00Z"));

    expect(normalizeStagePageQuery({ estimate_sent_preset: "wtd" }).filters).toMatchObject({
      estimateSentFrom: "2026-05-17",
      estimateSentTo: "2026-05-22",
    });
  });
});

describe("getStagePageListStageIds (terminal alias-family broadening — reconciles the list to the header)", () => {
  const allStages = [
    { id: "s-est", slug: "estimating" },
    { id: "s-won", slug: "won" },
    { id: "s-closed-won", slug: "closed_won" }, // a Won alias the legacy summary also counts
    { id: "s-lost", slug: "lost" },
  ];

  it("broadens a Won route stage to every Won-family id present (mirrors the server stage endpoint)", () => {
    const ids = getStagePageListStageIds({ id: "s-won", slug: "won" }, allStages);
    expect(ids).toContain("s-won");
    expect(ids).toContain("s-closed-won");
    expect(ids).not.toContain("s-est");
    expect(ids).not.toContain("s-lost");
  });

  it("uses the SAME shared Won family the server broadens with (no drift)", () => {
    const stages = WON_DEAL_STAGE_SLUGS.map((slug, i) => ({ id: `w-${i}`, slug }));
    const ids = getStagePageListStageIds({ id: "w-0", slug: "won" }, stages);
    expect([...ids].sort()).toEqual(stages.map((stage) => stage.id).sort());
  });

  it("keeps a non-terminal stage as its single route id", () => {
    expect(getStagePageListStageIds({ id: "s-est", slug: "estimating" }, allStages)).toEqual(["s-est"]);
  });

  it("falls back to the route stage id when the stage list is empty (load failure — never unscoped)", () => {
    expect(getStagePageListStageIds({ id: "s-won", slug: "won" }, [])).toEqual(["s-won"]);
  });
});

describe("isWonStagePageStage (Won-only on-hold exclusion)", () => {
  it("is true for Won-family stages, false for Lost + active stages", () => {
    expect(isWonStagePageStage("won")).toBe(true);
    expect(isWonStagePageStage("closed_won")).toBe(true);
    expect(isWonStagePageStage("lost")).toBe(false);
    expect(isWonStagePageStage("estimating")).toBe(false);
  });
});

describe("mapStageRouteFiltersToDealFilters (header filters -> list DealFilters, so the list matches the header)", () => {
  it("maps the population filters the summary applies into getDeals filters", () => {
    expect(
      mapStageRouteFiltersToDealFilters({
        search: "acme",
        filters: {
          staleOnly: false,
          assignedRepId: "rep-1",
          regionId: "region-1",
          status: "on_hold",
          workflowRoute: "service",
          updatedAfter: "2026-05-01",
          updatedBefore: "2026-05-31",
          minAgeDays: "30",
          wonSince: "2026-04-01",
          wonUntil: "2026-04-30",
        },
      })
    ).toEqual({
      search: "acme",
      assignedRepId: "rep-1",
      regionId: "region-1",
      status: "on_hold",
      workflowRoute: "service",
      updatedFrom: "2026-05-01",
      updatedTo: "2026-05-31",
      minAgeDays: 30,
      wonClosedFrom: "2026-04-01",
      wonClosedTo: "2026-04-30",
    });
  });

  it("ignores filters with no getDeals equivalent (staleOnly, Lost date window)", () => {
    expect(
      mapStageRouteFiltersToDealFilters({ search: "", filters: { staleOnly: true, lostSince: "2026-01-01" } })
    ).toEqual({});
  });
});
