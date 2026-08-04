import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTE_SELECTION,
  ROUTES_NONE,
  isBucketSelected,
  isFetchableSelection,
  parseRouteSelection,
  routesForRequest,
  serializeRouteSelection,
  toggleRouteBucket,
  type RouteSelection,
} from "./route-filter";

// The ?routes codec is the single place that decides what a shared showcase link MEANS. Every case below
// is a state a real URL can be in -- including the two that must NOT degrade into "show everything".

describe("parseRouteSelection", () => {
  it("treats an ABSENT param as both buckets — the pre-filter report", () => {
    expect(parseRouteSelection(null)).toEqual({ kind: "selection", buckets: ["service", "other"] });
    expect(parseRouteSelection(null)).toEqual(DEFAULT_ROUTE_SELECTION);
  });

  it("parses each single bucket", () => {
    expect(parseRouteSelection("service")).toEqual({ kind: "selection", buckets: ["service"] });
    expect(parseRouteSelection("other")).toEqual({ kind: "selection", buckets: ["other"] });
  });

  it("normalizes order and whitespace so one slice has one meaning", () => {
    expect(parseRouteSelection("other,service")).toEqual({ kind: "selection", buckets: ["service", "other"] });
    expect(parseRouteSelection(" service , other ")).toEqual({ kind: "selection", buckets: ["service", "other"] });
  });

  it("reads the `none` sentinel as the EMPTY selection, not as everything", () => {
    expect(parseRouteSelection(ROUTES_NONE)).toEqual({ kind: "empty" });
  });

  it("marks unknown, duplicate and blank values INVALID rather than falling back to both", () => {
    // The fall-back is the dangerous behaviour: it would render the full office report under a URL that
    // claims a filter, so a viewer reads office-wide numbers as a slice.
    expect(parseRouteSelection("banana")).toEqual({ kind: "invalid", raw: "banana" });
    expect(parseRouteSelection("service,banana")).toEqual({ kind: "invalid", raw: "service,banana" });
    expect(parseRouteSelection("service,service")).toEqual({ kind: "invalid", raw: "service,service" });
    // 'normal' is the raw column value, not a bucket name — accepting it would silently mean "other".
    expect(parseRouteSelection("normal")).toEqual({ kind: "invalid", raw: "normal" });
    expect(parseRouteSelection("")).toEqual({ kind: "invalid", raw: "" });
    expect(parseRouteSelection(",")).toEqual({ kind: "invalid", raw: "," });
  });
});

describe("serializeRouteSelection", () => {
  it("drops the param entirely for both buckets, keeping the default URL clean", () => {
    expect(serializeRouteSelection({ kind: "selection", buckets: ["service", "other"] })).toBeNull();
  });

  it("writes a single bucket and the empty sentinel", () => {
    expect(serializeRouteSelection({ kind: "selection", buckets: ["service"] })).toBe("service");
    expect(serializeRouteSelection({ kind: "empty" })).toBe(ROUTES_NONE);
  });

  it("round-trips every selection", () => {
    const cases: RouteSelection[] = [
      { kind: "selection", buckets: ["service", "other"] },
      { kind: "selection", buckets: ["service"] },
      { kind: "selection", buckets: ["other"] },
      { kind: "empty" },
    ];
    for (const selection of cases) {
      expect(parseRouteSelection(serializeRouteSelection(selection))).toEqual(selection);
    }
  });
});

describe("toggleRouteBucket", () => {
  it("turns a chip off, leaving the other selected", () => {
    expect(toggleRouteBucket(DEFAULT_ROUTE_SELECTION, "other")).toEqual({ kind: "selection", buckets: ["service"] });
    expect(toggleRouteBucket(DEFAULT_ROUTE_SELECTION, "service")).toEqual({ kind: "selection", buckets: ["other"] });
  });

  it("turns a chip back on, restoring both", () => {
    expect(toggleRouteBucket({ kind: "selection", buckets: ["service"] }, "other")).toEqual({
      kind: "selection",
      buckets: ["service", "other"],
    });
  });

  it("yields EMPTY when the last chip goes off — never a silent snap-back to both", () => {
    expect(toggleRouteBucket({ kind: "selection", buckets: ["service"] }, "service")).toEqual({ kind: "empty" });
  });

  it("starts a fresh single-bucket selection from empty or invalid", () => {
    expect(toggleRouteBucket({ kind: "empty" }, "service")).toEqual({ kind: "selection", buckets: ["service"] });
    expect(toggleRouteBucket({ kind: "invalid", raw: "x" }, "other")).toEqual({ kind: "selection", buckets: ["other"] });
  });
});

describe("what the page sends and renders", () => {
  it("sends NO routes for the default, so the request is the pre-filter one", () => {
    expect(routesForRequest(DEFAULT_ROUTE_SELECTION)).toBeUndefined();
  });

  it("sends the single bucket when narrowed", () => {
    expect(routesForRequest({ kind: "selection", buckets: ["service"] })).toEqual(["service"]);
  });

  it("only a real selection is fetchable — empty and invalid render panels instead of numbers", () => {
    expect(isFetchableSelection(DEFAULT_ROUTE_SELECTION)).toBe(true);
    expect(isFetchableSelection({ kind: "empty" })).toBe(false);
    expect(isFetchableSelection({ kind: "invalid", raw: "x" })).toBe(false);
  });

  it("reports chip pressed-state, with nothing pressed in the empty/invalid states", () => {
    expect(isBucketSelected(DEFAULT_ROUTE_SELECTION, "service")).toBe(true);
    expect(isBucketSelected({ kind: "selection", buckets: ["other"] }, "service")).toBe(false);
    expect(isBucketSelected({ kind: "empty" }, "service")).toBe(false);
    expect(isBucketSelected({ kind: "invalid", raw: "x" }, "other")).toBe(false);
  });
});
