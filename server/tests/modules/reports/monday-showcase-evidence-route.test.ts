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
});
