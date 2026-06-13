import { describe, expect, it } from "vitest";
import { parseShowcaseEvidenceParams } from "../../../src/modules/reports/routes.js";

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

  it("maps regionId like repId: absent -> undefined, sentinel -> null (Unassigned), uuid -> that region", () => {
    expect(parseShowcaseEvidenceParams({ metric: "won" }).regionId).toBeUndefined();
    expect(parseShowcaseEvidenceParams({ metric: "won", regionId: "__unassigned__" }).regionId).toBeNull();
    const uuid = "22222222-2222-2222-2222-222222222222";
    expect(parseShowcaseEvidenceParams({ metric: "won", regionId: uuid }).regionId).toBe(uuid);
    expect(() => parseShowcaseEvidenceParams({ metric: "won", regionId: "nope" })).toThrow(/regionId/);
  });

  it("accepts an explicit from/to period window, paired, ISO-validated", () => {
    const p = parseShowcaseEvidenceParams({ metric: "won", from: "2026-06-01", to: "2026-06-13" });
    expect(p.from).toBe("2026-06-01");
    expect(p.to).toBe("2026-06-13");
    expect(() => parseShowcaseEvidenceParams({ metric: "won", from: "2026-06-01" })).toThrow(/together/);
    expect(() => parseShowcaseEvidenceParams({ metric: "won", from: "06/01/2026", to: "06/13/2026" })).toThrow(/ISO date/);
  });

  it("rejects a region scope for the leads metric (no region-scoped lead cohort to reconcile against)", () => {
    expect(() => parseShowcaseEvidenceParams({ metric: "leads", regionId: "22222222-2222-2222-2222-222222222222" })).toThrow(/regionId/);
    expect(() => parseShowcaseEvidenceParams({ metric: "leads", regionId: "__unassigned__" })).toThrow(/regionId/);
  });

  it("rejects a non-calendar date and an inverted from/to window", () => {
    expect(() => parseShowcaseEvidenceParams({ metric: "won", from: "2026-02-31", to: "2026-03-01" })).toThrow(/calendar date/);
    expect(() => parseShowcaseEvidenceParams({ metric: "won", from: "2026-06-13", to: "2026-06-01" })).toThrow(/on or before/);
  });
});
