import { describe, expect, it } from "vitest";
import { parseScorecardSubmission } from "../../../src/modules/field/scorecard-submission.js";

const DEAL = "11111111-1111-1111-1111-111111111111";
const CSID = "22222222-2222-2222-2222-222222222222";
const MAX: Record<string, number> = {
  planning_precon: 10,
  jobsite_5s: 15,
  schedule: 20,
  subcontractor: 15,
  quality: 20,
  communication: 10,
  financial: 10,
};
function fullItems(): { sectionKey: string; points: number }[] {
  return Object.entries(MAX).map(([sectionKey, points]) => ({ sectionKey, points }));
}
function body(over: Record<string, unknown> = {}) {
  return {
    clientSubmissionId: CSID,
    dealId: DEAL,
    weekOf: "2026-06-30",
    items: fullItems(),
    criticalDeficiencies: [],
    actionItems: [],
    photos: [],
    ...over,
  };
}

describe("parseScorecardSubmission", () => {
  it("parses a valid submission", () => {
    const parsed = parseScorecardSubmission(body());
    expect(parsed.dealId).toBe(DEAL);
    expect(parsed.items).toHaveLength(7);
    expect(parsed.weekOf).toBe("2026-06-30");
  });

  it("rejects a non-uuid clientSubmissionId or dealId", () => {
    expect(() => parseScorecardSubmission(body({ clientSubmissionId: "nope" }))).toThrow();
    expect(() => parseScorecardSubmission(body({ dealId: "nope" }))).toThrow();
  });

  it("rejects a malformed weekOf instead of deferring to a DB cast", () => {
    expect(() => parseScorecardSubmission(body({ weekOf: "not-a-date" }))).toThrow(/weekOf/i);
    expect(() => parseScorecardSubmission(body({ weekOf: "2026-13-40" }))).toThrow(/weekOf/i);
    expect(() => parseScorecardSubmission(body({ weekOf: "" }))).toThrow(/weekOf/i);
  });

  it("rejects null / empty-string / missing points instead of coercing to 0", () => {
    const nullPoints = body({ items: fullItems().map((it, i) => (i === 2 ? { ...it, points: null } : it)) });
    expect(() => parseScorecardSubmission(nullPoints)).toThrow(/points/i);
    const stringPoints = body({ items: fullItems().map((it, i) => (i === 2 ? { ...it, points: "" } : it)) });
    expect(() => parseScorecardSubmission(stringPoints)).toThrow(/points/i);
    const missingPoints = body({ items: fullItems().map((it, i) => (i === 2 ? { sectionKey: it.sectionKey } : it)) });
    expect(() => parseScorecardSubmission(missingPoints)).toThrow(/points/i);
  });

  it("accepts a legal 0-point value (the reason strict validation matters)", () => {
    const withZero = body({ items: fullItems().map((it, i) => (i === 0 ? { ...it, points: 0 } : it)) });
    const parsed = parseScorecardSubmission(withZero);
    expect(parsed.items[0].points).toBe(0);
  });

  it("rejects a boolean points value", () => {
    const withBool = body({ items: fullItems().map((it, i) => (i === 2 ? { ...it, points: false } : it)) });
    expect(() => parseScorecardSubmission(withBool)).toThrow(/points/i);
  });

  it("rejects calendar-invalid weekOf days that Date.parse would silently roll over", () => {
    expect(() => parseScorecardSubmission(body({ weekOf: "2026-02-30" }))).toThrow(/weekOf/i);
    expect(() => parseScorecardSubmission(body({ weekOf: "2026-02-29" }))).toThrow(/weekOf/i); // 2026 isn't a leap year
    expect(() => parseScorecardSubmission(body({ weekOf: "2026-04-31" }))).toThrow(/weekOf/i);
    expect(() => parseScorecardSubmission(body({ weekOf: "0000-01-01" }))).toThrow(/weekOf/i);
    // A real leap day is accepted.
    expect(parseScorecardSubmission(body({ weekOf: "2028-02-29" })).weekOf).toBe("2028-02-29");
  });

  it("requires at least one item", () => {
    expect(() => parseScorecardSubmission(body({ items: [] }))).toThrow(/items/i);
  });

  it("keeps only real action items (drops null / non-string / blank) so bogus entries can't satisfy the gate", () => {
    const parsed = parseScorecardSubmission(body({ actionItems: [null, "   ", "Fix the slab", 42, {}] }));
    expect(parsed.actionItems).toEqual(["Fix the slab"]);
  });

  it("rejects an evidence photo with a blank / missing / non-string clientUploadId", () => {
    expect(() => parseScorecardSubmission(body({ photos: [{ sectionKey: "schedule", clientUploadId: "" }] }))).toThrow(/clientUploadId/i);
    expect(() => parseScorecardSubmission(body({ photos: [{ sectionKey: "schedule" }] }))).toThrow(/clientUploadId/i);
    expect(() => parseScorecardSubmission(body({ photos: [{ sectionKey: "schedule", clientUploadId: null }] }))).toThrow(/clientUploadId/i);
  });

  it("caps oversized arrays", () => {
    const manyPhotos = Array.from({ length: 101 }, (_, i) => ({ sectionKey: "schedule", clientUploadId: `cu-${i}` }));
    expect(() => parseScorecardSubmission(body({ photos: manyPhotos }))).toThrow(/many/i);
    const manyItems = Array.from({ length: 31 }, () => ({ sectionKey: "schedule", points: 20 }));
    expect(() => parseScorecardSubmission(body({ items: manyItems }))).toThrow(/many/i);
  });

  it("trims blank optional fields to null", () => {
    const parsed = parseScorecardSubmission(body({ superintendentName: "   ", pmName: "Dana" }));
    expect(parsed.superintendentName).toBeNull();
    expect(parsed.pmName).toBe("Dana");
  });
});
