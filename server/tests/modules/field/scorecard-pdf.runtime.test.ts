import { describe, expect, it } from "vitest";
import { buildScorecardPdfData, renderFieldScorecardPdf } from "../../../src/modules/field/scorecard-pdf.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+0ak2hAAAAABJRU5ErkJggg==",
  "base64",
);

describe("field scorecard PDF evidence", () => {
  it("groups section and deficiency photos with their descriptions and renders a PDF", async () => {
    const data = buildScorecardPdfData({
      dealName: "Maple Street Tower",
      projectNumber: "DFW-10432",
      weekOf: "2026-07-06",
      superintendentName: "Sam Super",
      pmName: "Pat Manager",
      submittedByName: "Sam Super",
      submittedAt: "2026-07-10T17:00:00.000Z",
      totalScore: 84,
      formVersion: 2,
      averageScore: 8.4,
      rating: "on_standard",
      items: [{ sectionKey: "quality", points: 8, note: "Reinspect framing." }],
      criticalDeficiencyKeys: ["failed_inspection"],
      criticalDeficiencyNotes: { failed_inspection: "Correct before drywall." },
      actionItems: ["Schedule reinspection"],
      photos: [
        { sectionKey: "quality", deficiencyKey: null, caption: "Framing detail", image: TINY_PNG },
        { sectionKey: "critical_deficiency", deficiencyKey: "failed_inspection", caption: "Inspection tag", image: TINY_PNG },
      ],
    });

    expect(data.sections.find((section) => section.title === "Quality Control")?.photos).toHaveLength(1);
    expect(data.deficiencies).toMatchObject([{ label: "Failed inspection", note: "Correct before drywall.", photos: [{ caption: "Inspection tag" }] }]);

    const pdf = await renderFieldScorecardPdf(data);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1_000);
  });
});
