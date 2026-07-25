import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { isScorecardSignatureImage, ScorecardDetailView } from "../ScorecardDetailView";
import type { FieldScorecardDetail } from "../../api/types";

const detail: FieldScorecardDetail = {
  id: "sc-1",
  canEdit: false,
  updatedAt: "2026-07-06T15:00:00.000Z",
  dealId: "deal-1",
  weekOf: "2026-07-06",
  totalScore: 82,
  formVersion: 2,
  averageScore: 8.2,
  rating: "needs_improvement",
  ratingLabel: "Needs Immediate Improvement",
  superintendentName: "Jane Super",
  pmName: "Pat PM",
  projectName: "Maple Street Apartments",
  projectNumber: "DFW-1-17426",
  criticalDeficiencyCount: 1,
  submittedByName: "Field Rep",
  submittedAt: "2026-07-06T15:00:00.000Z",
  items: [{ sectionKey: "quality", points: 8, note: "minor rework" }],
  criticalDeficiencies: ["missed_hold_point"],
  actionItems: ["Schedule re-inspection"],
  photos: [],
};

describe("ScorecardDetailView", () => {
  it("shows the project name and number in the standalone detail", () => {
    const screen = render(<ScorecardDetailView scorecard={detail} onDownloadPdf={jest.fn()} downloadingPdf={false} />);
    expect(screen.getByText("Maple Street Apartments")).toBeTruthy();
    expect(screen.getByText("Project DFW-1-17426")).toBeTruthy();
  });

  it("uses a safe project-name fallback for an older detail response", () => {
    const screen = render(
      <ScorecardDetailView scorecard={{ ...detail, projectName: undefined }} onDownloadPdf={jest.fn()} downloadingPdf={false} />,
    );
    expect(screen.getByText("Project DFW-1-17426")).toBeTruthy();
  });

  it("renders deficiency KEYS as human labels, never raw snake_case", () => {
    const screen = render(<ScorecardDetailView scorecard={detail} onDownloadPdf={jest.fn()} downloadingPdf={false} />);
    expect(screen.getByText("Missed hold point")).toBeTruthy();
    expect(screen.queryByText("missed_hold_point")).toBeNull();
  });

  it("always renders the Download PDF button (no pdfGeneratedAt gate) and fires onDownloadPdf", () => {
    const onDownloadPdf = jest.fn();
    const screen = render(<ScorecardDetailView scorecard={detail} onDownloadPdf={onDownloadPdf} downloadingPdf={false} />);
    fireEvent.press(screen.getByText("Download PDF"));
    expect(onDownloadPdf).toHaveBeenCalledTimes(1);
  });

  it("shows the edit action only when the owner callback is supplied", () => {
    const onEditScorecard = jest.fn();
    const editable = render(
      <ScorecardDetailView
        scorecard={{ ...detail, canEdit: true }}
        onDownloadPdf={jest.fn()}
        downloadingPdf={false}
        onEditScorecard={onEditScorecard}
      />,
    );
    fireEvent.press(editable.getByText("Edit scorecard"));
    expect(onEditScorecard).toHaveBeenCalledTimes(1);

    const readOnly = render(
      <ScorecardDetailView scorecard={detail} onDownloadPdf={jest.fn()} downloadingPdf={false} />,
    );
    expect(readOnly.queryByText("Edit scorecard")).toBeNull();
  });

  it("renders free-text action items verbatim", () => {
    const screen = render(<ScorecardDetailView scorecard={detail} onDownloadPdf={jest.fn()} downloadingPdf={false} />);
    expect(screen.getByText("Schedule re-inspection")).toBeTruthy();
  });

  it("renders handwritten data-URL signatures as images and legacy typed signatures as text", () => {
    const handwritten = "data:image/png;base64,AAAA";
    const screen = render(
      <ScorecardDetailView
        scorecard={{
          ...detail,
          superintendentSignature: handwritten,
          pmSignature: "Pat PM (typed legacy signature)",
        }}
        onDownloadPdf={jest.fn()}
        downloadingPdf={false}
      />,
    );

    expect(isScorecardSignatureImage(handwritten)).toBe(true);
    expect(isScorecardSignatureImage("Pat PM (typed legacy signature)")).toBe(false);
    // expo-image normalizes `source` to an array of sources (core RN <Image> kept the bare object).
    const sig = screen.getByTestId("scorecard-signature-image-superintendent");
    expect(sig.props.source).toEqual([{ uri: handwritten }]);
    // Signatures are personal data — memory-only cache, never persisted to the shared image disk cache.
    expect(sig.props.cachePolicy).toBe("memory");
    expect(screen.queryByText(handwritten)).toBeNull();
    expect(screen.getByText("Pat PM (typed legacy signature)")).toBeTruthy();
    expect(screen.queryByTestId("scorecard-signature-image-project-manager")).toBeNull();
  });

  it("does not trust or dump unsupported signature data URLs", () => {
    const unsupportedImage = "data:image/svg+xml;base64,PHN2Zy8+";
    const unsupportedData = "data:text/plain;base64,U2lnbmF0dXJl";
    const screen = render(
      <ScorecardDetailView
        scorecard={{
          ...detail,
          superintendentSignature: unsupportedImage,
          pmSignature: unsupportedData,
        }}
        onDownloadPdf={jest.fn()}
        downloadingPdf={false}
      />,
    );

    expect(isScorecardSignatureImage(unsupportedImage)).toBe(false);
    expect(screen.queryByText(unsupportedImage)).toBeNull();
    expect(screen.queryByText(unsupportedData)).toBeNull();
    expect(screen.queryByTestId("scorecard-signature-image-superintendent")).toBeNull();
    expect(screen.queryByTestId("scorecard-signature-image-project-manager")).toBeNull();
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("renders all 8 section rows, 0-filling sections absent from items", () => {
    // Only `quality` is scored; the other seven must still render at 0/10 (defensive merge).
    const partial: FieldScorecardDetail = { ...detail, items: [{ sectionKey: "quality", points: 8, note: null }] };
    const screen = render(<ScorecardDetailView scorecard={partial} onDownloadPdf={jest.fn()} downloadingPdf={false} />);
    for (const title of [
      "Planning & Preconstruction",
      "Jobsite Organization / 5S",
      "Safety",
      "Schedule Performance",
      "Subcontractor Performance",
      "Quality Control",
      "Communication & Documentation",
      "Financial Control",
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.getByText("8/10")).toBeTruthy(); // the one scored section
    // planning_precon / communication / financial are all absent → 0/10 rows.
    expect(screen.getAllByText("0/10").length).toBeGreaterThan(0);
  });

  it("shows a placeholder (no broken Image) for a photo whose url is null", () => {
    const withNullPhoto: FieldScorecardDetail = {
      ...detail,
      photos: [{ id: "ph1", sectionKey: "quality", fileId: "f1", url: null, caption: null }],
    };
    const screen = render(<ScorecardDetailView scorecard={withNullPhoto} onDownloadPdf={jest.fn()} downloadingPdf={false} />);
    expect(screen.getByTestId("scorecard-photo-placeholder-ph1")).toBeTruthy();
    expect(screen.queryByTestId("scorecard-photo-image-ph1")).toBeNull();
  });
});
