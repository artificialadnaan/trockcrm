/**
 * A change-order child is a real CHILD deal whose stored name is "<Parent> — Change Order N"
 * (server/src/modules/deals/change-order-service.ts). Every T-Rock Cam row is one or two clamped lines,
 * so the suffix is precisely the part a phone never renders — which made a change order look identical
 * to the project it belongs to. This asserts the display-only prefix actually reaches a rendered row.
 *
 * SubmittedScorecardRow is the cheapest honest witness for that wiring: it is pure props, no hooks, and it
 * is the shared row used by both the Scorecards tab and a project's Scorecards list.
 */
import React from "react";
import { render } from "@testing-library/react-native";
import { SubmittedScorecardRow } from "../SubmittedScorecardRow";
import type { FieldScorecardSummary } from "../../api/types";

function summary(overrides: Partial<FieldScorecardSummary> = {}): FieldScorecardSummary {
  return {
    id: "sc-1",
    dealId: "deal-1",
    weekOf: "2026-07-27",
    totalScore: 82,
    rating: "on_standard",
    ratingLabel: "Meets Standard",
    superintendentName: null,
    pmName: null,
    projectName: "Tides Park Lane",
    projectNumber: "DFW-1-09026-af",
    criticalDeficiencyCount: 0,
    submittedByName: "Alice",
    submittedAt: "2026-07-31T12:00:00.000Z",
    ...overrides,
  } as FieldScorecardSummary;
}

describe("SubmittedScorecardRow — change-order display name", () => {
  it("shows the change-order label FIRST for a change-order child", () => {
    const { getByText, queryByText } = render(
      <SubmittedScorecardRow
        scorecard={summary({ projectName: "Tides Park Lane — Change Order 2" })}
        onPress={() => {}}
      />
    );
    expect(getByText("Change Order 2 — Tides Park Lane")).toBeTruthy();
    // The stored, suffix-last form is not what the row shows.
    expect(queryByText("Tides Park Lane — Change Order 2")).toBeNull();
  });

  it("leaves an ordinary project name byte for byte", () => {
    const { getByText } = render(
      <SubmittedScorecardRow scorecard={summary({ projectName: "Tides — Phase 2" })} onPress={() => {}} />
    );
    expect(getByText("Tides — Phase 2")).toBeTruthy();
  });

  it("still falls back to the project number when there is no name", () => {
    const { getByText } = render(
      <SubmittedScorecardRow scorecard={summary({ projectName: null })} onPress={() => {}} />
    );
    expect(getByText("Project DFW-1-09026-af")).toBeTruthy();
  });
});
