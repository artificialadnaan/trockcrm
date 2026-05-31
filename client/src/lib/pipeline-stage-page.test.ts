import { afterEach, describe, expect, it, vi } from "vitest";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import {
  getStagePageBarRedirectSearch,
  getStagePageListStageIds,
  isWonStagePageStage,
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

describe("getStagePageBarRedirectSearch (translate inherited bare filters -> fb_ namespace so the bar owns them)", () => {
  const parse = (s: string) => new URLSearchParams(s);

  it("returns null when there are no bare filter params (no redirect)", () => {
    expect(getStagePageBarRedirectSearch(parse("scope=team&page=2&fb_search=x"))).toBeNull();
  });

  it("translates bar-mappable bare filters to fb_ and strips ALL bare filter params", () => {
    const result = getStagePageBarRedirectSearch(parse("scope=team&assignedRepId=rep-1&regionId=reg-1&updatedAfter=2026-05-01"));
    const out = parse(result!);
    expect(out.get("fb_assignedRepId")).toBe("rep-1"); // translated -> bar shows it, Clear clears it
    expect(out.get("fb_regionId")).toBe("reg-1");
    expect(out.get("scope")).toBe("team"); // route param preserved
    expect(out.has("assignedRepId")).toBe(false); // bare stripped (no invisible floor)
    expect(out.has("regionId")).toBe(false);
    expect(out.has("updatedAfter")).toBe(false); // un-mappable legacy (updated-axis) stripped, not translated
    expect(out.has("fb_updatedAfter")).toBe(false);
  });

  it("does NOT clobber an fb_ value the user already set (explicit fb_ wins over inherited bare)", () => {
    const out = parse(getStagePageBarRedirectSearch(parse("assignedRepId=rep-1&fb_assignedRepId=rep-9"))!);
    expect(out.get("fb_assignedRepId")).toBe("rep-9");
    expect(out.has("assignedRepId")).toBe(false);
  });
});
