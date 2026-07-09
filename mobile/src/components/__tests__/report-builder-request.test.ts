import { buildGenerateReportRequest } from "../report-builder-request";
import type { FieldReportSection, ReportCover } from "../../api/types";

const cover: ReportCover = {
  reportTitle: "Site Photo Report",
  creatorName: "Sam Super",
  companyName: "TRock Construction",
  reportDateLabel: "June 30, 2026",
  projectName: "Maple Street Tower",
  photoCount: 2,
};

const sections: FieldReportSection[] = [
  {
    id: "sec-1",
    title: "Progress",
    photos: [
      { id: "p1", displayName: "P1", description: "orig1", takenAt: null, createdAt: "", uploaderName: "S", imageUrl: null, tags: [], projectName: "Maple" },
      { id: "p2", displayName: "P2", description: null, takenAt: null, createdAt: "", uploaderName: "S", imageUrl: null, tags: [], projectName: "Maple" },
    ],
  },
];

function base(overrides: Partial<Parameters<typeof buildGenerateReportRequest>[0]> = {}) {
  return {
    projectId: "deal-1",
    reportTitle: "Site Photo Report",
    executiveSummary: "",
    cover,
    sections,
    sectionTitles: {} as Record<string, string>,
    descriptions: {} as Record<string, string>,
    ...overrides,
  };
}

describe("buildGenerateReportRequest", () => {
  it("includes the trimmed executive summary when provided", () => {
    const req = buildGenerateReportRequest(base({ executiveSummary: "  On time and under budget.  " }));
    expect(req.executiveSummary).toBe("On time and under budget.");
  });

  it("sends null when the summary is blank or whitespace-only", () => {
    expect(buildGenerateReportRequest(base({ executiveSummary: "" })).executiveSummary).toBeNull();
    expect(buildGenerateReportRequest(base({ executiveSummary: "   \n " })).executiveSummary).toBeNull();
  });

  it("prefers edited section titles and per-photo overrides, falling back to originals", () => {
    const req = buildGenerateReportRequest(
      base({ sectionTitles: { "sec-1": "Weekly Progress" }, descriptions: { p1: "edited caption" } }),
    );
    expect(req.sections[0].title).toBe("Weekly Progress");
    expect(req.sections[0].photoIds).toEqual(["p1", "p2"]);
    expect(req.sections[0].photoOverrides).toEqual([
      { id: "p1", description: "edited caption" },
      { id: "p2", description: null },
    ]);
  });

  it("falls back to the original photo description when there is no override", () => {
    const req = buildGenerateReportRequest(base());
    expect(req.sections[0].photoOverrides).toEqual([
      { id: "p1", description: "orig1" },
      { id: "p2", description: null },
    ]);
  });

  it("passes through projectId, reportTitle, and coverData", () => {
    const req = buildGenerateReportRequest(base());
    expect(req.projectId).toBe("deal-1");
    expect(req.reportTitle).toBe("Site Photo Report");
    expect(req.coverData).toEqual({
      creatorName: "Sam Super",
      companyName: "TRock Construction",
      reportDateLabel: "June 30, 2026",
      projectName: "Maple Street Tower",
    });
  });
});
