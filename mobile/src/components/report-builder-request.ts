import type { FieldReportSection, GenerateReportRequest, ReportCover } from "../api/types";

/**
 * Assemble the generate-report payload from the edit-step state. Pure + unit-tested so the "include the
 * executive summary only when non-blank" and section/override mapping rules can't silently drift.
 *
 * The executive summary is trimmed and sent as `null` when blank/whitespace — the server renders no
 * summary page for a null/empty value.
 */
export function buildGenerateReportRequest(args: {
  projectId: string;
  reportTitle: string;
  executiveSummary: string;
  cover: ReportCover;
  sections: FieldReportSection[];
  sectionTitles: Record<string, string>;
  descriptions: Record<string, string>;
}): GenerateReportRequest {
  const summary = args.executiveSummary.trim();
  return {
    projectId: args.projectId,
    reportTitle: args.reportTitle,
    executiveSummary: summary ? summary : null,
    coverData: {
      creatorName: args.cover.creatorName,
      companyName: args.cover.companyName,
      reportDateLabel: args.cover.reportDateLabel,
      projectName: args.cover.projectName,
    },
    sections: args.sections.map((section) => ({
      title: args.sectionTitles[section.id] ?? section.title,
      photoIds: section.photos.map((photo) => photo.id),
      photoOverrides: section.photos.map((photo) => ({
        id: photo.id,
        description: args.descriptions[photo.id] ?? photo.description ?? null,
      })),
    })),
  };
}
