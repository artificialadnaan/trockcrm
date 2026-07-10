import {
  deficiencyLabel,
  formatShortDate,
  scorecardDownloadErrorMessage,
  scorecardPhotoSections,
  scorecardSectionRows,
} from "../detail-view";
import type { FieldScorecardItemView, FieldScorecardPhotoView } from "../../api/types";

describe("deficiencyLabel", () => {
  it("maps a known deficiency key to its human label", () => {
    expect(deficiencyLabel("missed_hold_point")).toBe("Missed hold point");
    expect(deficiencyLabel("failed_inspection")).toBe("Failed inspection");
  });
  it("falls back to the raw key when unknown", () => {
    expect(deficiencyLabel("something_new")).toBe("something_new");
  });
});

describe("scorecardSectionRows", () => {
  it("returns all 8 V2 sections in canonical order with points merged from items", () => {
    const items: FieldScorecardItemView[] = [
      { sectionKey: "quality", points: 15, note: "minor rework" },
      { sectionKey: "planning_precon", points: 10, note: null },
    ];
    const rows = scorecardSectionRows(items);
    expect(rows.map((r) => r.key)).toEqual([
      "planning_precon", "jobsite_5s", "safety", "schedule", "subcontractor", "quality", "communication", "financial",
    ]);
    expect(rows[0]).toMatchObject({ key: "planning_precon", points: 10, maxPoints: 10, note: null });
    expect(rows[5]).toMatchObject({ key: "quality", points: 15, maxPoints: 10, note: "minor rework" });
    // A section with no scored item shows 0 / maxPoints and never crashes.
    expect(rows[1]).toMatchObject({ key: "jobsite_5s", points: 0, maxPoints: 10, note: null });
  });
});

describe("scorecardPhotoSections", () => {
  it("groups photos under their section in canonical order and drops empty sections", () => {
    const photos: FieldScorecardPhotoView[] = [
      { id: "p1", sectionKey: "quality", fileId: "f1", url: "u1", caption: null },
      { id: "p2", sectionKey: "planning_precon", fileId: "f2", url: "u2", caption: "cap" },
      { id: "p3", sectionKey: "quality", fileId: "f3", url: "u3", caption: null },
    ];
    const sections = scorecardPhotoSections(photos);
    expect(sections.map((s) => s.key)).toEqual(["planning_precon", "quality"]);
    expect(sections[1].photos.map((p) => p.id)).toEqual(["p1", "p3"]);
  });
  it("returns [] when there are no photos", () => {
    expect(scorecardPhotoSections([])).toEqual([]);
  });
});

describe("scorecardDownloadErrorMessage", () => {
  it("prefers the server's own message when an ApiError carries one (terminal / not-found)", () => {
    // The /download 404 covers THREE server causes; each has a distinct message. Echo it.
    expect(scorecardDownloadErrorMessage({ status: 404, message: "Scorecard not found" })).toBe("Scorecard not found");
    expect(scorecardDownloadErrorMessage({ status: 404, message: "Project not found" })).toBe("Project not found");
    expect(
      scorecardDownloadErrorMessage({
        status: 404,
        message: "The scorecard PDF is still generating — please try again shortly.",
      }),
    ).toMatch(/still generating/i);
  });
  it("uses the still-generating default for a 404 with no usable server message", () => {
    expect(scorecardDownloadErrorMessage({ status: 404 })).toMatch(/still generating/i);
    // The generic transport default ("Request failed (404)") is ignored, not echoed.
    expect(scorecardDownloadErrorMessage({ status: 404, message: "Request failed (404)" })).toMatch(/still generating/i);
  });
  it("returns a generic message for any non-404 / status-less error", () => {
    expect(scorecardDownloadErrorMessage({ status: 500 })).toMatch(/couldn.t open/i);
    expect(scorecardDownloadErrorMessage(new Error("boom"))).toMatch(/couldn.t open/i);
  });
});

describe("formatShortDate", () => {
  it("formats a yyyy-mm-dd week value without UTC drift", () => {
    const out = formatShortDate("2026-07-06");
    expect(out).toMatch(/Jul/);
    expect(out).toContain("6");
  });
  it("formats an ISO timestamp", () => {
    expect(formatShortDate("2026-07-06T15:30:00.000Z")).toMatch(/Jul/);
  });
  it("passes an unparseable value through unchanged", () => {
    expect(formatShortDate("not-a-date")).toBe("not-a-date");
  });
});
