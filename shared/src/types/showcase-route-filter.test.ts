import { describe, expect, it } from "vitest";
import {
  SHOWCASE_ROUTE_BUCKETS,
  SHOWCASE_ROUTES_NONE,
  parseShowcaseRouteValues,
  showcaseRouteValuesFromQuery,
} from "./showcase-route-filter.js";

/**
 * This is the ONE place `?routes` is interpreted — the report endpoint, the evidence endpoint and the
 * Monday Showcase page all map its verdict onto their own surfaces. The two bugs that led here were both
 * disagreements between parsers of this param (an empty value read as absent; a repeated value collapsed
 * to its first occurrence), so the cases below are the contract those consumers rely on.
 */

describe("parseShowcaseRouteValues", () => {
  it("treats NO occurrences as absent — the only input that means 'both, no narrowing'", () => {
    expect(parseShowcaseRouteValues([])).toEqual({ kind: "absent" });
  });

  it("parses a single bucket and the explicit pair, normalizing order and whitespace", () => {
    expect(parseShowcaseRouteValues(["service"])).toEqual({ kind: "selection", buckets: ["service"] });
    expect(parseShowcaseRouteValues(["other"])).toEqual({ kind: "selection", buckets: ["other"] });
    expect(parseShowcaseRouteValues(["service,other"])).toEqual({
      kind: "selection",
      buckets: ["service", "other"],
    });
    expect(parseShowcaseRouteValues(["other,service"])).toEqual({
      kind: "selection",
      buckets: ["service", "other"],
    });
    expect(parseShowcaseRouteValues([" service , other "])).toEqual({
      kind: "selection",
      buckets: ["service", "other"],
    });
  });

  it("reads the `none` sentinel as an explicit EMPTY selection", () => {
    expect(parseShowcaseRouteValues([SHOWCASE_ROUTES_NONE])).toEqual({ kind: "empty", raw: "none" });
  });

  it("rejects a REPEATED param — which occurrence wins is a guess", () => {
    // The bug this prevents: URLSearchParams.get() hands back only "service", so a page could render a
    // confident Service-only slice from a URL the server rejects outright.
    const parsed = parseShowcaseRouteValues(["service", "other"]);
    expect(parsed.kind).toBe("invalid");
    expect(parsed.kind === "invalid" && parsed.reason).toMatch(/once/);
  });

  it("rejects PRESENT-but-empty, which is NOT the same as absent", () => {
    // Folding these into `absent` is what made `?routes=` silently return the full unfiltered report.
    for (const raw of ["", " ", "\t", "   ", ","]) {
      const parsed = parseShowcaseRouteValues([raw]);
      expect(`${JSON.stringify(raw)} -> ${parsed.kind}`).toBe(`${JSON.stringify(raw)} -> invalid`);
      expect(parsed.kind === "invalid" && parsed.reason).toMatch(/at least one/);
    }
  });

  it("rejects unknown buckets and duplicates", () => {
    expect(parseShowcaseRouteValues(["banana"]).kind).toBe("invalid");
    // 'normal' is the raw workflow_route column value, not a bucket name — accepting it would silently
    // mean "other" and quietly exclude every null-route deal that also belongs there.
    expect(parseShowcaseRouteValues(["normal"]).kind).toBe("invalid");
    expect(parseShowcaseRouteValues(["service,banana"]).kind).toBe("invalid");
    const dup = parseShowcaseRouteValues(["service,service"]);
    expect(dup.kind === "invalid" && dup.reason).toMatch(/duplicate/);
  });

  it("never returns an empty bucket list for a `selection`", () => {
    // Downstream, an empty selection would build a `false` SQL predicate and render zeros that read like
    // measurements. `selection` must always be actionable.
    for (const raw of ["service", "other", "service,other", "other,service"]) {
      const parsed = parseShowcaseRouteValues([raw]);
      expect(parsed.kind === "selection" && parsed.buckets.length > 0).toBe(true);
    }
  });
});

describe("showcaseRouteValuesFromQuery", () => {
  it("maps Express query shapes onto the occurrence list", () => {
    expect(showcaseRouteValuesFromQuery(undefined)).toEqual([]); // absent
    expect(showcaseRouteValuesFromQuery("service")).toEqual(["service"]);
    expect(showcaseRouteValuesFromQuery("")).toEqual([""]); // present-but-empty survives
    expect(showcaseRouteValuesFromQuery(["service", "other"])).toEqual(["service", "other"]);
  });

  it("keeps a non-string present value as one unusable entry, so it is REJECTED not read as absent", () => {
    // `?routes[a]=b` parses to an object. Returning [] here would make it mean "both".
    expect(showcaseRouteValuesFromQuery({ a: "b" })).toHaveLength(1);
    expect(parseShowcaseRouteValues(showcaseRouteValuesFromQuery({ a: "b" })).kind).toBe("invalid");
    expect(parseShowcaseRouteValues(showcaseRouteValuesFromQuery(7)).kind).toBe("invalid");
    expect(parseShowcaseRouteValues(showcaseRouteValuesFromQuery(null)).kind).toBe("invalid");
  });
});

describe("the bucket vocabulary", () => {
  it("is exactly service + other, in canonical order", () => {
    // Every consumer re-exports or mirrors this list; pinning it here is what makes those aliases safe.
    expect(SHOWCASE_ROUTE_BUCKETS).toEqual(["service", "other"]);
  });
});
