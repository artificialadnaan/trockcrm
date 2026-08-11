import { describe, expect, it } from "vitest";
import { buildScorecardPdfData, renderFieldScorecardPdf } from "../../../src/modules/field/scorecard-pdf.js";

// A 1x1 PNG — a real, pdfkit-decodable image so evidence tiles embed.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function leadershipInput(over: Record<string, unknown> = {}) {
  return {
    dealName: "Maple Street Tower",
    projectNumber: "DFW-10432",
    weekOf: "2026-07-06",
    superintendentName: "Sam Super",
    pmName: "Pat Manager",
    submittedByName: "Erin Evaluator",
    submittedAt: "2026-07-10T17:00:00.000Z",
    totalScore: 85,
    kind: "leadership" as const,
    averageScore: 8.5,
    rating: "on_standard" as const,
    items: [
      { sectionKey: "quality_control", points: 9, note: "Hold points clean." },
      { sectionKey: "safety", points: 8, note: "One near-miss reviewed." },
      { sectionKey: "schedule_adherence", points: 8, note: null },
      { sectionKey: "site_staff_feedback", points: 9, note: "Crew engaged." },
    ],
    criticalDeficiencyKeys: [] as string[],
    actionItems: [] as string[],
    summary: "Strong leadership week; keep reinforcing daily huddles.",
    ...over,
  };
}

describe("leadership scorecard PDF", () => {
  it("builds a leadership render model: 4 categories, no deficiencies/signatures, a summary", () => {
    const data = buildScorecardPdfData(leadershipInput());
    expect(data.kind).toBe("leadership");
    expect(data.formVersion).toBe(2);
    expect(data.sections.map((s) => s.title)).toEqual([
      "Quality Control",
      "Safety",
      "Schedule Adherence",
      "Site Staff Feedback",
    ]);
    expect(data.deficiencies).toHaveLength(0);
    // Empty because the FIXTURE sends none, not because the kind strips them — see the next test.
    expect(data.actionItems).toHaveLength(0);
    expect(data.superintendentSignature).toBeNull();
    expect(data.pmSignature).toBeNull();
    expect(data.summary).toBe("Strong leadership week; keep reinforcing daily huddles.");
    expect(data.ratingLabel).toBe("Meets Standard");
  });

  it("carries a leadership card's action items into the render model, trimmed and blank-filtered", () => {
    // This used to be hardcoded to `[]` for leadership, so the PDF omitted the Action Items block while the
    // Corrective Actions block beneath it referenced those same items by label — a report that named work
    // with nothing above it to name. The block itself was already kind-agnostic; only the strip was not.
    const data = buildScorecardPdfData(
      leadershipInput({
        actionItems: ["  Rebuild the look-ahead  ", "", "   ", "Close the safety observations"],
      }),
    );
    expect(data.actionItems).toEqual(["Rebuild the look-ahead", "Close the safety observations"]);
  });

  it("renders a below-band leadership PDF carrying action items", async () => {
    const buffer = await renderFieldScorecardPdf(
      buildScorecardPdfData(
        leadershipInput({
          totalScore: 60,
          averageScore: 6,
          rating: "corrective_action" as const,
          actionItems: ["Rebuild the look-ahead", "Close the safety observations"],
        }),
      ),
    );
    // A real PDF, not a stub — the renderer must survive the newly-reachable leadership + action-items combo.
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it("routes category and project_summary photos into their corresponding evidence groups", () => {
    const data = buildScorecardPdfData(
      leadershipInput({
        photos: [
          { sectionKey: "safety", deficiencyKey: null, caption: "PPE station", image: TINY_PNG },
          { sectionKey: "project_summary", deficiencyKey: null, caption: "Site walk", image: null },
          { sectionKey: "project_summary", deficiencyKey: null, caption: "Crew", image: TINY_PNG },
        ],
      }),
    );
    expect(data.summaryPhotos).toHaveLength(2);
    expect(data.sections.find((section) => section.title === "Safety")?.photos).toHaveLength(1);
    expect(data.sections.find((section) => section.title === "Quality Control")?.photos).toHaveLength(0);
  });

  it("renders a leadership PDF with category and summary photos as evidence pages", async () => {
    const data = buildScorecardPdfData(
      leadershipInput({
        summary: "Strong leadership week. ".repeat(200), // long dictation → must be bounded, not overflow
        photos: [
          { sectionKey: "quality_control", deficiencyKey: null, caption: "Clean hold point", image: TINY_PNG },
          { sectionKey: "project_summary", deficiencyKey: null, caption: "Site walk", image: TINY_PNG },
          { sectionKey: "project_summary", deficiencyKey: null, caption: null, image: null },
        ],
      }),
    );
    const pdf = await renderFieldScorecardPdf(data);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1_000);
    expect(pdf.length).toBeLessThan(5_000_000);
  });

  it("renders a leadership PDF with no summary and no photos", async () => {
    const data = buildScorecardPdfData(leadershipInput({ summary: null, photos: [] }));
    expect(data.summaryPhotos).toHaveLength(0);
    const pdf = await renderFieldScorecardPdf(data);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1_000);
  });
});
