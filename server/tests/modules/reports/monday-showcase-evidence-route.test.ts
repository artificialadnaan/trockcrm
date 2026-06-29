import { describe, expect, it } from "vitest";
import { parseShowcaseEvidenceParams, assertShowcaseEvidenceAccess } from "../../../src/modules/reports/routes.js";

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
