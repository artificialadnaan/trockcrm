import { describe, it, expect } from "vitest";
import { parseFeedFilterQuery } from "../../../src/modules/files/routes.js";

/**
 * One parser feeds BOTH photo-feed tabs, so whatever it lets through reaches two SQL builders.
 *
 * The date filters land in SQL as `COALESCE(taken_at, created_at) >= ${value}::timestamptz`. An
 * unparseable string therefore raises Postgres 22007 (`invalid input syntax for type timestamp with
 * time zone`), which nothing maps — it surfaces as a 500. That hazard predated this change on
 * `/photos/feed`, but this parser is what routes the same query params into `/photos/project-stats`,
 * which accepted no filters at all before. Validating here is what keeps a stale bookmark degrading to
 * "unfiltered" on both tabs rather than adding a second endpoint that 500s.
 *
 * Same principle the enum dimensions already follow: unknown values from a bookmarked or shared URL are
 * DROPPED, never 400'd, because the user did not type them.
 */
describe("parseFeedFilterQuery", () => {
  it("drops unparseable dates instead of passing them to the ::timestamptz cast", () => {
    const filters = parseFeedFilterQuery({ dateFrom: "garbage", dateTo: "2026-02-30" } as never);

    expect(filters.dateFrom).toBeUndefined();
    // Day-overflow too: Date.parse silently rolls 2026-02-30 over, the SQL cast does not.
    expect(filters.dateTo).toBeUndefined();
  });

  it("drops reduced-precision dates, which parse in JS but not in Postgres", () => {
    expect(parseFeedFilterQuery({ dateFrom: "2026" } as never).dateFrom).toBeUndefined();
    expect(parseFeedFilterQuery({ dateFrom: "2026-07" } as never).dateFrom).toBeUndefined();
  });

  it("keeps the ISO timestamps the feed client actually sends", () => {
    const filters = parseFeedFilterQuery({
      dateFrom: "2026-07-01T00:00:00.000Z",
      dateTo: "2026-07-27T23:59:59.999Z",
    } as never);

    expect(filters.dateFrom).toBe("2026-07-01T00:00:00.000Z");
    expect(filters.dateTo).toBe("2026-07-27T23:59:59.999Z");
  });

  it("drops an unknown source rather than rejecting the page", () => {
    expect(parseFeedFilterQuery({ source: "polaroid" } as never).source).toBeUndefined();
    expect(parseFeedFilterQuery({ source: "companycam" } as never).source).toBe("companycam");
  });

  it("passes photoCategory through untouched — the SQL compares the cast COLUMN, so a stale value filters to nothing", () => {
    expect(parseFeedFilterQuery({ photoCategory: "no_such_phase" } as never).photoCategory).toBe("no_such_phase");
    expect(parseFeedFilterQuery({ photoCategory: "uncategorized" } as never).photoCategory).toBe("uncategorized");
  });

  it("ignores repeated query params rather than handing an array to eq()", () => {
    expect(parseFeedFilterQuery({ dealId: ["a", "b"] } as never).dealId).toBeUndefined();
  });
});
