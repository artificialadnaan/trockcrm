import { describe, expect, it } from "vitest";
import {
  assertFanOutNotFullyDegraded,
  excludeNonFieldOffices,
  fanOutOffices,
  pickResolvedOffice,
  type FieldOffice,
} from "../../../src/modules/field/cross-office.js";

const offices: FieldOffice[] = [
  { id: "id-dallas", slug: "dallas" },
  { id: "id-atlanta", slug: "atlanta" },
  { id: "id-pw", slug: "pwauditoffice" },
];

describe("excludeNonFieldOffices", () => {
  it("drops pwauditoffice (a non-production schema that only degrades the fan-out) and keeps real offices", () => {
    expect(excludeNonFieldOffices(offices).map((o) => o.slug)).toEqual(["dallas", "atlanta"]);
  });
  it("is a no-op when there are no excluded offices", () => {
    const real: FieldOffice[] = [{ id: "id-dallas", slug: "dallas" }];
    expect(excludeNonFieldOffices(real)).toEqual(real);
  });
});

describe("fanOutOffices", () => {
  it("runs the callback for EVERY office and returns each result paired with its office", async () => {
    const out = await fanOutOffices(offices, async (office) => `ran:${office.slug}`);
    expect(out.failures).toEqual([]);
    expect(out.results.map((r) => ({ slug: r.office.slug, value: r.value }))).toEqual([
      { slug: "dallas", value: "ran:dallas" },
      { slug: "atlanta", value: "ran:atlanta" },
      { slug: "pwauditoffice", value: "ran:pwauditoffice" },
    ]);
  });

  it("degrades gracefully: one office throwing is captured in failures while the others still return", async () => {
    const out = await fanOutOffices(offices, async (office) => {
      if (office.slug === "atlanta") throw new Error("atlanta schema is down");
      return office.slug.toUpperCase();
    });
    expect(out.results.map((r) => r.office.slug)).toEqual(["dallas", "pwauditoffice"]);
    expect(out.results.map((r) => r.value)).toEqual(["DALLAS", "PWAUDITOFFICE"]);
    expect(out.failures).toEqual([{ office: { id: "id-atlanta", slug: "atlanta" }, error: "atlanta schema is down" }]);
  });

  it("returns empty results (no throw) when there are no offices", async () => {
    const out = await fanOutOffices([], async () => "x");
    expect(out.results).toEqual([]);
    expect(out.failures).toEqual([]);
  });
});

describe("pickResolvedOffice", () => {
  it("returns the office that reported ownership (UUIDs are globally unique → at most one)", () => {
    const office = pickResolvedOffice({
      results: [
        { office: offices[0]!, value: false },
        { office: offices[2]!, value: true },
      ],
      failures: [],
    });
    expect(office).toEqual({ id: "id-pw", slug: "pwauditoffice" });
  });

  it("returns null when every office cleanly reported NOT-mine (genuine not-found → 404)", () => {
    const office = pickResolvedOffice({
      results: offices.map((o) => ({ office: o, value: false })),
      failures: [],
    });
    expect(office).toBeNull();
  });

  it("THROWS 503 (not null) when no office claimed it but one FAILED — the owner may be the failed office", () => {
    expect(() =>
      pickResolvedOffice({
        results: [{ office: offices[0]!, value: false }],
        failures: [{ office: offices[1]!, error: "schema down" }],
      }),
    ).toThrowError(/temporarily unavailable/i);
  });
});

describe("assertFanOutNotFullyDegraded", () => {
  it("passes the outcome through when at least one office succeeded", () => {
    const outcome = { results: [{ office: offices[0]!, value: 1 }], failures: [{ office: offices[1]!, error: "x" }] };
    expect(assertFanOutNotFullyDegraded(outcome)).toBe(outcome);
  });

  it("THROWS 503 when there were active offices but EVERY one failed (not an empty 200)", () => {
    expect(() =>
      assertFanOutNotFullyDegraded({ results: [], failures: offices.map((o) => ({ office: o, error: "down" })) }),
    ).toThrowError(/temporarily unavailable/i);
  });

  it("does NOT throw when there were simply no offices/results and no failures", () => {
    const outcome = { results: [], failures: [] };
    expect(assertFanOutNotFullyDegraded(outcome)).toBe(outcome);
  });
});
