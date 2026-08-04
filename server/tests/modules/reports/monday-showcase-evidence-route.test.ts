import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseShowcaseEvidenceParams,
  assertShowcaseEvidenceAccess,
  parseShowcaseRouteBuckets,
  readShowcaseRouteParam,
} from "../../../src/modules/reports/routes.js";

// The evidence endpoint's query parsing/validation (the HTTP wiring is thin; this locks the contract).
describe("parseShowcaseEvidenceParams", () => {
  it("requires a known metric", () => {
    expect(() => parseShowcaseEvidenceParams({})).toThrow(/metric/);
    expect(() => parseShowcaseEvidenceParams({ metric: "bogus" })).toThrow(/metric/);
  });

  it("defaults mode to to_date and scope to office (repId undefined)", () => {
    const p = parseShowcaseEvidenceParams({ metric: "won" });
    expect(p.metric).toBe("won");
    expect(p.mode).toBe("to_date");
    expect(p.repId).toBeUndefined(); // office-wide
    expect(p.band).toBeUndefined();
  });

  it("accepts completed mode", () => {
    expect(parseShowcaseEvidenceParams({ metric: "sent", mode: "completed" }).mode).toBe("completed");
  });

  it("maps the __unassigned__ sentinel to the null bucket, and a uuid to that rep", () => {
    expect(parseShowcaseEvidenceParams({ metric: "won", repId: "__unassigned__" }).repId).toBeNull();
    const uuid = "11111111-1111-1111-1111-111111111111";
    expect(parseShowcaseEvidenceParams({ metric: "won", repId: uuid }).repId).toBe(uuid);
  });

  it("rejects a malformed repId", () => {
    expect(() => parseShowcaseEvidenceParams({ metric: "won", repId: "not-a-uuid" })).toThrow(/repId/);
  });

  it("accepts a projection band only for the projection metric", () => {
    expect(parseShowcaseEvidenceParams({ metric: "projection", band: "31_60" }).band).toBe("31_60");
    expect(() => parseShowcaseEvidenceParams({ metric: "projection", band: "bogus" })).toThrow(/band/);
    expect(() => parseShowcaseEvidenceParams({ metric: "won", band: "31_60" })).toThrow(/band/);
  });

  it("accepts a leadStage only for the leads metric", () => {
    expect(parseShowcaseEvidenceParams({ metric: "leads", leadStage: "New" }).leadStage).toBe("New");
    expect(() => parseShowcaseEvidenceParams({ metric: "won", leadStage: "New" })).toThrow(/leadStage/);
  });

  it("accepts the pipeline metric, and a stageSlug only for it", () => {
    expect(parseShowcaseEvidenceParams({ metric: "pipeline" }).metric).toBe("pipeline");
    expect(parseShowcaseEvidenceParams({ metric: "pipeline", stageSlug: "estimating" }).stageSlug).toBe("estimating");
    expect(() => parseShowcaseEvidenceParams({ metric: "won", stageSlug: "estimating" })).toThrow(/stageSlug/);
  });

  it("accepts the undated metric office-wide and per-rep, but rejects band/stageSlug/regionName on it", () => {
    // The B4 "No future close date" card: a snapshot complement, scoped like projection (office or one rep).
    expect(parseShowcaseEvidenceParams({ metric: "undated" }).metric).toBe("undated");
    expect(parseShowcaseEvidenceParams({ metric: "undated" }).repId).toBeUndefined(); // office-wide
    const uuid = "11111111-1111-1111-1111-111111111111";
    expect(parseShowcaseEvidenceParams({ metric: "undated", repId: uuid }).repId).toBe(uuid);
    expect(parseShowcaseEvidenceParams({ metric: "undated", repId: "__unassigned__" }).repId).toBeNull();
    // it has no band/stage/region axis (the card is M − N over the open scope, not a region drill)
    expect(() => parseShowcaseEvidenceParams({ metric: "undated", band: "31_60" })).toThrow(/band/);
    expect(() => parseShowcaseEvidenceParams({ metric: "undated", stageSlug: "estimating" })).toThrow(/stageSlug/);
    expect(() => parseShowcaseEvidenceParams({ metric: "undated", regionName: "West Coast" })).toThrow(/regionName/);
  });

  it("undated is NOT a director-gated surface — a rep may open their own / the office undated list", () => {
    // Scoped like projection: not pipeline, no from/to, no regionName → assertShowcaseEvidenceAccess lets reps through.
    expect(() => assertShowcaseEvidenceAccess({ metric: "undated", mode: "to_date" }, false)).not.toThrow();
    expect(() => assertShowcaseEvidenceAccess({ metric: "undated", mode: "to_date", repId: "11111111-1111-1111-1111-111111111111" }, false)).not.toThrow();
  });
});

describe("assertShowcaseEvidenceAccess — the region drill's elevated surface is director-only", () => {
  const opt = (over: Partial<ReturnType<typeof parseShowcaseEvidenceParams>>) =>
    ({ metric: "won" as const, mode: "to_date" as const, ...over });

  it("directors may use pipeline / from-to / regionName", () => {
    expect(() => assertShowcaseEvidenceAccess(opt({ metric: "pipeline" }), true)).not.toThrow();
    expect(() => assertShowcaseEvidenceAccess(opt({ from: "2026-06-01", to: "2026-06-13" }), true)).not.toThrow();
    expect(() => assertShowcaseEvidenceAccess(opt({ regionName: "West Coast" }), true)).not.toThrow();
  });

  it("reps are blocked from the pipeline metric, an explicit window, and the region scope", () => {
    expect(() => assertShowcaseEvidenceAccess(opt({ metric: "pipeline" }), false)).toThrow(/director/);
    expect(() => assertShowcaseEvidenceAccess(opt({ from: "2026-06-01", to: "2026-06-13" }), false)).toThrow(/director/);
    expect(() => assertShowcaseEvidenceAccess(opt({ regionName: "Unassigned" }), false)).toThrow(/director/);
  });

  it("reps keep the ordinary showcase drawer (won/projection, mode-week, no elevated params)", () => {
    expect(() => assertShowcaseEvidenceAccess(opt({ metric: "won" }), false)).not.toThrow();
    expect(() => assertShowcaseEvidenceAccess(opt({ metric: "projection" }), false)).not.toThrow();
    expect(() => assertShowcaseEvidenceAccess(opt({ metric: "won", repId: "11111111-1111-1111-1111-111111111111" }), false)).not.toThrow();
  });

  it("accepts a region NAME (the report's displayed-region key); 'Unassigned' is the bucket; absent = office", () => {
    expect(parseShowcaseEvidenceParams({ metric: "won" }).regionName).toBeUndefined();
    expect(parseShowcaseEvidenceParams({ metric: "won", regionName: "West Coast" }).regionName).toBe("West Coast");
    expect(parseShowcaseEvidenceParams({ metric: "won", regionName: "Unassigned" }).regionName).toBe("Unassigned");
  });

  it("accepts an explicit from/to period window, paired, ISO-validated", () => {
    const p = parseShowcaseEvidenceParams({ metric: "won", from: "2026-06-01", to: "2026-06-13" });
    expect(p.from).toBe("2026-06-01");
    expect(p.to).toBe("2026-06-13");
    expect(() => parseShowcaseEvidenceParams({ metric: "won", from: "2026-06-01" })).toThrow(/together/);
    expect(() => parseShowcaseEvidenceParams({ metric: "won", from: "06/01/2026", to: "06/13/2026" })).toThrow(/ISO date/);
  });

  it("rejects a region scope for the leads metric (no region-scoped lead cohort to reconcile against)", () => {
    expect(() => parseShowcaseEvidenceParams({ metric: "leads", regionName: "West Coast" })).toThrow(/regionName/);
  });

  it("rejects a non-calendar date and an inverted from/to window", () => {
    expect(() => parseShowcaseEvidenceParams({ metric: "won", from: "2026-02-31", to: "2026-03-01" })).toThrow(/calendar date/);
    expect(() => parseShowcaseEvidenceParams({ metric: "won", from: "2026-06-13", to: "2026-06-01" })).toThrow(/on or before/);
  });

  it("allows repId + regionName for the won metric (top-reps-within-region drill) including unassigned", () => {
    const rep = "11111111-1111-1111-1111-111111111111";
    expect(parseShowcaseEvidenceParams({ metric: "won", repId: rep, regionName: "West Coast" })).toMatchObject({
      metric: "won",
      repId: rep,
      regionName: "West Coast",
    });
    // Unassigned rep within a region is a real cohort (won deals with no assigned rep) — also allowed.
    expect(parseShowcaseEvidenceParams({ metric: "won", repId: "__unassigned__", regionName: "Unassigned" })).toMatchObject({
      metric: "won",
      repId: null,
      regionName: "Unassigned",
    });
  });

  it("rejects repId + regionName for any NON-won metric (no rep×region cohort to reconcile)", () => {
    const rep = "11111111-1111-1111-1111-111111111111";
    expect(() => parseShowcaseEvidenceParams({ metric: "pipeline", repId: rep, regionName: "West Coast" })).toThrow(/only be combined for the won metric/);
    expect(() => parseShowcaseEvidenceParams({ metric: "projection", repId: rep, regionName: "Central" })).toThrow(/only be combined for the won metric/);
  });
});

// The Service / Other selection, shared by BOTH showcase endpoints. An unrecognised value must be a 400 --
// never a silently full result under a filtered-looking UI -- and an ABSENT value must stay exactly the
// no-narrowing request the report has always made.
describe("parseShowcaseRouteBuckets", () => {
  it("absent means no narrowing at all (undefined, not an implicit both-list)", () => {
    expect(parseShowcaseRouteBuckets(undefined)).toBeUndefined();
  });

  it("accepts each single bucket and the explicit pair", () => {
    expect(parseShowcaseRouteBuckets("service")).toEqual(["service"]);
    expect(parseShowcaseRouteBuckets("other")).toEqual(["other"]);
    expect(parseShowcaseRouteBuckets("service,other")).toEqual(["service", "other"]);
  });

  it("normalizes order and whitespace so a link cannot mean two different things", () => {
    expect(parseShowcaseRouteBuckets("other,service")).toEqual(["service", "other"]);
    expect(parseShowcaseRouteBuckets(" service , other ")).toEqual(["service", "other"]);
  });

  it("rejects an unknown bucket rather than dropping it and returning a broader set", () => {
    expect(() => parseShowcaseRouteBuckets("banana")).toThrow(/routes/);
    expect(() => parseShowcaseRouteBuckets("service,banana")).toThrow(/routes/);
    // 'normal' is the raw COLUMN value, not a bucket name -- accepting it would quietly mean "other".
    expect(() => parseShowcaseRouteBuckets("normal")).toThrow(/routes/);
  });

  it("rejects a duplicate bucket", () => {
    expect(() => parseShowcaseRouteBuckets("service,service")).toThrow(/duplicate/);
  });

  it("rejects an EMPTY selection -- there is no honest report for 'neither'", () => {
    expect(() => parseShowcaseRouteBuckets("")).toThrow(/at least one/);
    expect(() => parseShowcaseRouteBuckets(",")).toThrow(/at least one/);
    expect(() => parseShowcaseRouteBuckets("  ")).toThrow(/at least one/);
  });

  it("distinguishes PRESENT-but-empty from ABSENT -- only absent means 'both'", () => {
    // The reason this parser takes the RAW query value: pickQueryValue() drops empty and whitespace-only
    // strings, so routing `?routes=` through it would deliver `undefined` and be answered with the FULL
    // unfiltered report -- the silent fallback the contract forbids. Absent is the only "both".
    expect(parseShowcaseRouteBuckets(undefined)).toBeUndefined();
    for (const present of ["", " ", "\t", "   ", ","]) {
      expect(() => parseShowcaseRouteBuckets(present)).toThrow(/at least one/);
    }
  });

  it("rejects a repeated ?routes param instead of guessing which one wins", () => {
    expect(() => parseShowcaseRouteBuckets(["service", "other"])).toThrow(/once/);
    expect(() => parseShowcaseRouteBuckets(["service"])).toThrow(/once/);
  });

  it("rejects a non-string value (e.g. ?routes[a]=b) rather than reading it as absent", () => {
    expect(() => parseShowcaseRouteBuckets({ a: "b" })).toThrow(/routes/);
    expect(() => parseShowcaseRouteBuckets(null)).toThrow(/routes/);
    expect(() => parseShowcaseRouteBuckets(7)).toThrow(/routes/);
  });

  it("is wired into the evidence params, for every metric", () => {
    expect(parseShowcaseEvidenceParams({ metric: "won", routes: "service" }).routes).toEqual(["service"]);
    // Accepted for `leads` too: the service reports applied=false rather than the client having to know
    // which metrics may carry the page's filter.
    expect(parseShowcaseEvidenceParams({ metric: "leads", routes: "other" }).routes).toEqual(["other"]);
    expect(parseShowcaseEvidenceParams({ metric: "won" }).routes).toBeUndefined();
    expect(() => parseShowcaseEvidenceParams({ metric: "won", routes: "nope" })).toThrow(/routes/);
  });

  it("rejects an empty/whitespace ?routes through the evidence params too", () => {
    // Exercised at the params level (not just the parser) because this is where the normalization that
    // swallowed it used to live.
    expect(() => parseShowcaseEvidenceParams({ metric: "won", routes: "" })).toThrow(/at least one/);
    expect(() => parseShowcaseEvidenceParams({ metric: "won", routes: " " })).toThrow(/at least one/);
    // "%20" is what a browser sends for a space; Express decodes it to " " before we see it.
    expect(() => parseShowcaseEvidenceParams({ metric: "won", routes: decodeURIComponent("%20") })).toThrow(
      /at least one/
    );
  });
});

/**
 * The two showcase endpoints must accept and reject the SAME route values. If one rejects what the other
 * accepts, a card and the drill behind it can disagree about whether the page is filtered -- the single
 * property this feature exists to guarantee. Both now read the raw query value through the same parser, so
 * this walks the shared inputs and asserts the verdicts match rather than trusting that by inspection.
 */
describe("the data and evidence endpoints treat ?routes identically", () => {
  // The DATA endpoint's real code path: its handler calls readShowcaseRouteParam(req.query). Calling the
  // same function here (rather than re-implementing the handler's line) is what makes this a symmetry
  // test and not two copies of the same assumption.
  const dataVerdict = (raw: unknown) => {
    try {
      const query: Record<string, unknown> = {};
      if (raw !== undefined) query.routes = raw;
      return { ok: true as const, value: readShowcaseRouteParam(query) };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  };
  // The EVIDENCE endpoint's real code path: parseShowcaseEvidenceParams, which reads routes through the
  // same shared reader. Both sides therefore exercise shipped code, not a test-local paraphrase of it.
  const evidenceVerdict = (raw: unknown) => {
    try {
      const query: Record<string, unknown> = { metric: "won" };
      if (raw !== undefined) query.routes = raw;
      return { ok: true as const, value: parseShowcaseEvidenceParams(query).routes };
    } catch (err) {
      return { ok: false as const, message: (err as Error).message };
    }
  };

  // The symmetry above compares the two REAL parse paths, but it cannot see a handler that stops calling
  // the shared reader altogether -- at that point the test's data side no longer reflects the data
  // endpoint. This source guard closes that hole: it pins both showcase handlers to readShowcaseRouteParam
  // and forbids re-composing the normalization that caused the bug (pickQueryValue drops "" and "  ", so
  // `?routes=` would read as absent and be answered with the full unfiltered report).
  it("keeps BOTH handlers on the shared reader, with no pickQueryValue normalization", () => {
    const source = readFileSync(
      new URL("../../../src/modules/reports/routes.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toContain("parseShowcaseRouteBuckets(pickQueryValue");
    expect(source).toContain("export function readShowcaseRouteParam(");
    // Exactly two CALL SITES (the data endpoint and the evidence params) once the definition itself is
    // removed from the text -- so dropping either handler off the shared reader fails here.
    const callSites =
      source.replace("export function readShowcaseRouteParam(", "").match(/readShowcaseRouteParam\(/g) ?? [];
    expect(callSites).toHaveLength(2);
  });

  it.each([
    ["absent", undefined],
    ["service", "service"],
    ["other", "other"],
    ["both", "service,other"],
    ["reordered", "other,service"],
    ["empty", ""],
    ["whitespace", "   "],
    ["comma only", ","],
    ["unknown bucket", "banana"],
    ["raw column value", "normal"],
    ["duplicate", "service,service"],
    ["repeated param", ["service", "other"]],
  ])("agree on %s", (_label, raw) => {
    expect(evidenceVerdict(raw)).toEqual(dataVerdict(raw));
  });
});
