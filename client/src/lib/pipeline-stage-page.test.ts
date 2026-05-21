import { describe, expect, it } from "vitest";
import { normalizeStagePageQuery } from "./pipeline-stage-page";

describe("normalizeStagePageQuery", () => {
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
});
