// Parameter parsing for the canvassing drill, where ABSENT and INVALID have to stay different answers.
//
// `bucketStart` omitted is a real, offered drill: the person's whole-range total. So falling back to it for
// a malformed value was not a lenient default, it was a silent widening — a stale bookmark or a crafted URL
// asking for one week returned every record in the selected range, under a heading naming the week. A drill
// that quietly answers a different question from the one asked is the single failure the whole feature
// exists to prevent, which is why an unparseable period is refused rather than reinterpreted.
//
// The route wraps this parser in a 400 (server/src/modules/reports/routes.ts), so a throw here is a 400
// there rather than an unhandled 500.
import { describe, expect, it } from "vitest";
import { parseCanvassingEvidenceParams } from "../../../src/modules/reports/canvassing-evidence-service.js";

const USER = "11111111-2222-4333-8444-555555555555";

function parse(overrides: Record<string, unknown> = {}) {
  return parseCanvassingEvidenceParams({ kind: "company", userId: USER, bucket: "week", ...overrides });
}

describe("parseCanvassingEvidenceParams — bucketStart", () => {
  it("accepts a real calendar date", () => {
    expect(parse({ bucketStart: "2026-06-07" }).bucketStart).toBe("2026-06-07");
  });

  it("treats an omitted or blank value as the whole-range drill", () => {
    expect(parse().bucketStart).toBeUndefined();
    expect(parse({ bucketStart: "" }).bucketStart).toBeUndefined();
    expect(parse({ bucketStart: "   " }).bucketStart).toBeUndefined();
  });

  // Each of these previously became `undefined` and widened the drill to the entire selected range.
  it.each(["garbage", "2026-6-7", "07/06/2026", "2026-06-07T00:00:00Z", "yesterday"])(
    "refuses the malformed value %j instead of widening to the whole range",
    (value) => {
      expect(() => parse({ bucketStart: value })).toThrow(/bucketStart/);
    }
  );

  // ISO-SHAPED but not a date. These passed the regex, reached Postgres, and failed at the ::date cast —
  // a 500 where the route means to answer 400.
  it.each(["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31"])(
    "refuses the impossible date %j rather than letting the ::date cast 500",
    (value) => {
      expect(() => parse({ bucketStart: value })).toThrow(/calendar date/);
    }
  );

  it("keeps accepting a genuine leap day", () => {
    expect(parse({ bucketStart: "2028-02-29" }).bucketStart).toBe("2028-02-29");
    expect(() => parse({ bucketStart: "2026-02-29" })).toThrow(/calendar date/);
  });

  // A repeated query param arrives as an array. Taking the first entry must not become a way to smuggle an
  // unvalidated second one past the check.
  it("validates the value it actually uses when the param repeats", () => {
    expect(parse({ bucketStart: ["2026-06-07", "garbage"] }).bucketStart).toBe("2026-06-07");
    expect(() => parse({ bucketStart: ["garbage", "2026-06-07"] })).toThrow(/bucketStart/);
  });
});

describe("parseCanvassingEvidenceParams — the other params", () => {
  it("accepts every drillable kind, including the combined column", () => {
    for (const kind of ["company", "property", "contact", "lead", "all", "notes"]) {
      expect(parse({ kind }).kind).toBe(kind);
    }
  });

  it("refuses an unknown kind rather than defaulting to one", () => {
    expect(() => parse({ kind: "deals" })).toThrow(/kind must be one of/);
    expect(() => parse({ kind: "" })).toThrow(/kind must be one of/);
  });

  it("requires a UUID userId — every drill is one person's cell", () => {
    expect(() => parse({ userId: "not-a-uuid" })).toThrow(/userId/);
    expect(() => parse({ userId: "" })).toThrow(/userId/);
  });

  // Unlike bucketStart, an unrecognised BUCKET is safe to default: it changes how rows are grouped for the
  // period comparison, and week is what the report opens on. It cannot widen a period drill, because an
  // absent/invalid bucketStart is now refused outright.
  it("falls back to week for an unrecognised bucket", () => {
    expect(parse({ bucket: "fortnight" }).bucket).toBe("week");
    expect(parse({ bucket: "MONTH" }).bucket).toBe("month");
  });
});
