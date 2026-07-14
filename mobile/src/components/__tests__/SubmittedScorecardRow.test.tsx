import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import type { FieldScorecardSummary } from "../../api/types";
import { SubmittedScorecardRow } from "../SubmittedScorecardRow";

const scorecard: FieldScorecardSummary = {
  id: "sc-1",
  dealId: "deal-1",
  projectName: "Maple Street Apartments",
  projectNumber: "DFW-1-17426",
  weekOf: "2026-07-06",
  totalScore: 95,
  rating: "elite",
  ratingLabel: "Elite Execution",
  superintendentName: "Jane Super",
  pmName: "Pat PM",
  criticalDeficiencyCount: 0,
  submittedByName: "Field Rep",
  submittedAt: "2026-07-06T15:00:00.000Z",
};

describe("SubmittedScorecardRow", () => {
  it("makes the job name primary and keeps the project number and week visible", () => {
    const screen = render(<SubmittedScorecardRow scorecard={scorecard} onPress={jest.fn()} />);

    expect(screen.getByText("Maple Street Apartments")).toBeTruthy();
    expect(screen.getByText(/DFW-1-17426 · Week of/)).toBeTruthy();
    expect(
      screen.getByLabelText(
        /Scorecard for Maple Street Apartments, project DFW-1-17426, week of .*, 95\/100, Elite Execution/,
      ),
    ).toBeTruthy();
  });

  it("falls back safely for an older response without a project name and remains pressable", () => {
    const onPress = jest.fn();
    const screen = render(
      <SubmittedScorecardRow scorecard={{ ...scorecard, projectName: undefined }} onPress={onPress} />,
    );

    expect(screen.getByText("Project DFW-1-17426")).toBeTruthy();
    fireEvent.press(screen.getByRole("button"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("uses an untitled fallback only when both project identity fields are absent", () => {
    const screen = render(
      <SubmittedScorecardRow
        scorecard={{ ...scorecard, projectName: undefined, projectNumber: null }}
        onPress={jest.fn()}
      />,
    );
    expect(screen.getByText("Untitled project")).toBeTruthy();
  });
});
