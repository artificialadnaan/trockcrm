import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_ROUTE_SELECTION,
  ROUTES_NONE,
  isBucketSelected,
  isFetchableSelection,
  parseRouteSelection,
  payloadDescribesSelection,
  routesForRequest,
  serializeRouteSelection,
  toggleRouteBucket,
  type RouteSelection,
} from "./route-filter";

/** Mirrors what the page hands the parser: searchParams.getAll() -> [] when the param is absent. */
const valuesFor = (encoded: string | null): string[] => (encoded === null ? [] : [encoded]);

// The ?routes codec is the single place that decides what a shared showcase link MEANS. Every case below
// is a state a real URL can be in -- including the two that must NOT degrade into "show everything".

describe("parseRouteSelection", () => {
  it("treats an ABSENT param (no occurrences) as both buckets — the pre-filter report", () => {
    expect(parseRouteSelection([])).toEqual({ kind: "selection", buckets: ["service", "other"] });
    expect(parseRouteSelection([])).toEqual(DEFAULT_ROUTE_SELECTION);
  });

  it("parses each single bucket", () => {
    expect(parseRouteSelection(["service"])).toEqual({ kind: "selection", buckets: ["service"] });
    expect(parseRouteSelection(["other"])).toEqual({ kind: "selection", buckets: ["other"] });
  });

  it("normalizes order and whitespace so one slice has one meaning", () => {
    expect(parseRouteSelection(["other,service"])).toEqual({ kind: "selection", buckets: ["service", "other"] });
    expect(parseRouteSelection([" service , other "])).toEqual({ kind: "selection", buckets: ["service", "other"] });
  });

  it("reads the `none` sentinel as the EMPTY selection, not as everything", () => {
    expect(parseRouteSelection([ROUTES_NONE])).toEqual({ kind: "empty" });
  });

  it("marks unknown, duplicate and blank values INVALID rather than falling back to both", () => {
    // The fall-back is the dangerous behaviour: it would render the full office report under a URL that
    // claims a filter, so a viewer reads office-wide numbers as a slice.
    expect(parseRouteSelection(["banana"])).toEqual({ kind: "invalid", raw: "banana" });
    expect(parseRouteSelection(["service,banana"])).toEqual({ kind: "invalid", raw: "service,banana" });
    expect(parseRouteSelection(["service,service"])).toEqual({ kind: "invalid", raw: "service,service" });
    // 'normal' is the raw column value, not a bucket name — accepting it would silently mean "other".
    expect(parseRouteSelection(["normal"])).toEqual({ kind: "invalid", raw: "normal" });
    expect(parseRouteSelection([""])).toEqual({ kind: "invalid", raw: "" });
    expect(parseRouteSelection([","])).toEqual({ kind: "invalid", raw: "," });
  });
});

describe("a REPEATED ?routes param", () => {
  // URLSearchParams.get() would hand back only "service" here, and the page would confidently render a
  // Service-only slice -- one the server rejects outright. Client and server must agree on the same URL.
  it("is invalid, not a silent first-wins guess", () => {
    expect(parseRouteSelection(["service", "other"])).toEqual({
      kind: "invalid",
      raw: "service&routes=other",
    });
    expect(parseRouteSelection(["service", "service"]).kind).toBe("invalid");
    expect(parseRouteSelection(["other", "service"]).kind).toBe("invalid");
  });

  it("still accepts a SINGLE valid occurrence -- the negative case alone would pass on broken parsing", () => {
    expect(parseRouteSelection(["service"])).toEqual({ kind: "selection", buckets: ["service"] });
    expect(parseRouteSelection(["service,other"])).toEqual({
      kind: "selection",
      buckets: ["service", "other"],
    });
    expect(isFetchableSelection(parseRouteSelection(["service"]))).toBe(true);
  });
});

describe("payloadDescribesSelection", () => {
  // Gates the caveat that names which figures are filtered. It must be false the instant the chips move
  // ahead of the payload, or the disclosure contradicts the controls beside it.
  it("is true only when the payload covers exactly the selected buckets", () => {
    const both: RouteSelection = { kind: "selection", buckets: ["service", "other"] };
    const service: RouteSelection = { kind: "selection", buckets: ["service"] };
    expect(payloadDescribesSelection(["service", "other"], both)).toBe(true);
    expect(payloadDescribesSelection(["service"], service)).toBe(true);
    // The stale-refetch shapes: payload and chips disagree.
    expect(payloadDescribesSelection(["service"], both)).toBe(false);
    expect(payloadDescribesSelection(["service", "other"], service)).toBe(false);
  });

  it("ignores bucket ORDER, so it cannot depend on the server's canonical ordering", () => {
    expect(payloadDescribesSelection(["other", "service"], { kind: "selection", buckets: ["service", "other"] })).toBe(true);
  });

  it("is false for the empty and invalid states, which have no payload to describe", () => {
    expect(payloadDescribesSelection(["service"], { kind: "empty" })).toBe(false);
    expect(payloadDescribesSelection(["service"], { kind: "invalid", raw: "x" })).toBe(false);
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
      expect(parseRouteSelection(valuesFor(serializeRouteSelection(selection)))).toEqual(selection);
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

describe("no independent parser of ?routes survives", () => {
  // Both earlier bugs in this feature were two parsers of one param disagreeing. The verdict now comes
  // from ONE shared function; these guards keep it that way, since a fresh re-implementation would look
  // perfectly reasonable in review.
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("the client codec delegates to the shared parser rather than re-deriving one", () => {
    const codec = read("./route-filter.ts");
    expect(codec).toContain("parseShowcaseRouteValues");
    // The give-aways of a re-implementation: bucket membership testing or comma-splitting done locally.
    expect(codec).not.toContain(".split(\",\")");
  });

  it("the page reads ALL occurrences — .get() would silently collapse a repeated param", () => {
    const page = read("../monday-showcase-page.tsx");
    expect(page).toContain("searchParams.getAll(ROUTES_PARAM)");
    expect(page).not.toContain("searchParams.get(ROUTES_PARAM)");
  });
});
