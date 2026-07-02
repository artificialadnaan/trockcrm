import { describe, it, expect } from "vitest";
import { buildScorecardPdfData, renderFieldScorecardPdf, type ScorecardPdfInput } from "./scorecard-pdf.js";

function input(overrides: Partial<ScorecardPdfInput> = {}): ScorecardPdfInput {
  return {
    dealName: "Maple Street Tower",
    projectNumber: "DFW-10432",
    weekOf: "2026-06-30",
    superintendentName: "Sam Super",
    pmName: "Pat Manager",
    submittedByName: "Sam Super",
    submittedAt: "2026-06-30T18:00:00.000Z",
    totalScore: 82,
    rating: "needs_improvement",
    items: [
      { sectionKey: "schedule", points: 15, note: "Recovery in progress" },
      { sectionKey: "planning_precon", points: 10, note: null },
      { sectionKey: "jobsite_5s", points: 15, note: null },
      { sectionKey: "subcontractor", points: 10, note: null },
      { sectionKey: "quality", points: 20, note: null },
      { sectionKey: "communication", points: 5, note: null },
      { sectionKey: "financial", points: 7, note: null },
    ],
    criticalDeficiencyKeys: ["failed_inspection", "schedule_slipping"],
    actionItems: ["Re-inspect slab", "Schedule recovery meeting"],
    ...overrides,
  };
}

describe("buildScorecardPdfData", () => {
  it("resolves section titles + maxPoints in canonical form order, carrying points + notes", () => {
    const data = buildScorecardPdfData(input());
    expect(data.sections.map((s) => s.title)).toEqual([
      "Planning & Precon",
      "Jobsite Organization / 5S",
      "Schedule Performance",
      "Subcontractor Performance",
      "Quality Control",
      "Communication & Documentation",
      "Financial Control",
    ]);
    const schedule = data.sections.find((s) => s.title === "Schedule Performance")!;
    expect(schedule.points).toBe(15);
    expect(schedule.maxPoints).toBe(20);
    expect(schedule.note).toBe("Recovery in progress");
  });

  it("resolves critical-deficiency keys to their labels and drops unknown keys", () => {
    const data = buildScorecardPdfData(input({ criticalDeficiencyKeys: ["failed_inspection", "bogus_key"] }));
    expect(data.deficiencies).toEqual(["Failed inspection"]);
  });

  it("derives the rating label from the rating band", () => {
    expect(buildScorecardPdfData(input({ rating: "elite" })).ratingLabel).toBe("Elite Execution");
    expect(buildScorecardPdfData(input()).ratingLabel).toBe("Needs Immediate Improvement");
  });
});

describe("renderFieldScorecardPdf", () => {
  it("renders a non-empty PDF buffer", async () => {
    const buf = await renderFieldScorecardPdf(buildScorecardPdfData(input()));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-"); // valid PDF header
  });

  it("renders even with no deficiencies, notes, or action items", async () => {
    const buf = await renderFieldScorecardPdf(
      buildScorecardPdfData(input({ criticalDeficiencyKeys: [], actionItems: [], rating: "elite", totalScore: 100 })),
    );
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
