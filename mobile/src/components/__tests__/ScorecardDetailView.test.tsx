import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { ScorecardDetailView } from "../ScorecardDetailView";
import type { FieldScorecardDetail } from "../../api/types";

const detail: FieldScorecardDetail = {
  id: "sc-1",
  dealId: "deal-1",
  weekOf: "2026-07-06",
  totalScore: 82,
  rating: "needs_improvement",
  ratingLabel: "Needs Immediate Improvement",
  superintendentName: "Jane Super",
  pmName: "Pat PM",
  projectNumber: "DFW-1-17426",
  criticalDeficiencyCount: 1,
  submittedByName: "Field Rep",
  submittedAt: "2026-07-06T15:00:00.000Z",
  items: [{ sectionKey: "quality", points: 15, note: "minor rework" }],
  criticalDeficiencies: ["missed_hold_point"],
  actionItems: ["Schedule re-inspection"],
  photos: [],
};

describe("ScorecardDetailView", () => {
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

  it("renders free-text action items verbatim", () => {
    const screen = render(<ScorecardDetailView scorecard={detail} onDownloadPdf={jest.fn()} downloadingPdf={false} />);
    expect(screen.getByText("Schedule re-inspection")).toBeTruthy();
  });

  it("renders all 7 section rows, 0-filling sections absent from items", () => {
    // Only `quality` is scored; the other six must still render at 0/maxPoints (defensive merge).
    const partial: FieldScorecardDetail = { ...detail, items: [{ sectionKey: "quality", points: 15, note: null }] };
    const screen = render(<ScorecardDetailView scorecard={partial} onDownloadPdf={jest.fn()} downloadingPdf={false} />);
    for (const title of [
      "Planning & Precon",
      "Jobsite Organization / 5S",
      "Schedule Performance",
      "Subcontractor Performance",
      "Quality Control",
      "Communication & Documentation",
      "Financial Control",
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.getByText("15/20")).toBeTruthy(); // the one scored section
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
