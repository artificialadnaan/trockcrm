import { describe, expect, it } from "vitest";
import { fanOutOffices, resolveOffice, type FieldOffice } from "../../../src/modules/field/cross-office.js";

const offices: FieldOffice[] = [
  { id: "id-dallas", slug: "dallas" },
  { id: "id-atlanta", slug: "atlanta" },
  { id: "id-pw", slug: "pwauditoffice" },
];

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

describe("resolveOffice", () => {
  it("returns the single office whose schema reports the id (UUIDs are globally unique)", async () => {
    const office = await resolveOffice(offices, async (o) => o.slug === "dallas");
    expect(office).toEqual({ id: "id-dallas", slug: "dallas" });
  });

  it("returns null when no office owns the id", async () => {
    const office = await resolveOffice(offices, async () => false);
    expect(office).toBeNull();
  });

  it("ignores an office whose hit-check throws and still finds the owning office", async () => {
    const office = await resolveOffice(offices, async (o) => {
      if (o.slug === "atlanta") throw new Error("down");
      return o.slug === "pwauditoffice";
    });
    expect(office).toEqual({ id: "id-pw", slug: "pwauditoffice" });
  });
});
