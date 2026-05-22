import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeStagePageQuery } from "./pipeline-stage-page";

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
});
