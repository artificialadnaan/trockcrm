import { describe, expect, it } from "vitest";
import { buildWeeklyReportView } from "./report-view.js";

// The live setup row as the loader reads it: weekly_report_projects joined to the PM/super display names.
const LIVE_PROJECT = {
  property_display_name: "4123 Cedar Springs",
  client_name: "Mack Real Estate Group",
  client_doc_name: "Jay Stauble",
  client_pm_name: "Melissa Garcia",
  client_rm_name: null,
  client_cm_name: null,
  trock_pm_user_id: "pm-1",
  trock_pm_name: "Adam Sherwood",
  trock_super_user_id: "super-1",
  trock_super_name: "Steve Sanchez",
  contract_date: "2026-07-08",
  contract_date_note: null,
  project_start_date: null,
  project_start_date_note: "TBD Permit",
  project_completion_date: null,
  project_completion_date_note: "TBD Permit",
  projected_duration_weeks: 19,
};

const SNAPSHOT = {
  propertyDisplayName: "4123 Cedar Springs",
  clientName: "Mack Real Estate Group",
  clientTeam: {
    doc: { name: "Jay Stauble", email: "jay@example.com" },
    pm: { name: "Melissa Garcia", email: "melissa@example.com" },
    rm: { name: null, email: null },
    cm: { name: null, email: null },
  },
  trockTeam: { pmUserId: "pm-1", pmName: "Adam Sherwood", superUserId: "super-1", superName: "Steve Sanchez" },
  schedule: {
    contractDate: "2026-07-08",
    contractDateNote: null,
    projectStartDate: null,
    projectStartDateNote: "TBD Permit",
    projectCompletionDate: null,
    projectCompletionDateNote: "TBD Permit",
    projectedDurationWeeks: 19,
  },
  snapshotVersion: 1,
};

function report(overrides: Record<string, unknown> = {}) {
  return {
    week_of: "2026-08-13",
    version: 1,
    status: "draft",
    work_completed: "- Material delivered for balcony mock up",
    next_week_look_ahead: "- Complete sample balcony coat",
    issues_concerns: "Permit risk",
    completion_percent: "0.00",
    weather_delay_days: 0,
    remaining_weeks: 19,
    projected_duration_weeks: 19,
    snapshot: null,
    sent_at: null,
    superseded_by_id: null,
    ...overrides,
  };
}

describe("buildWeeklyReportView — a draft reads the live setup row", () => {
  it("prints the current client, team and schedule", () => {
    const view = buildWeeklyReportView({ report: report(), project: LIVE_PROJECT, photos: [] });
    expect(view.fromSnapshot).toBe(false);
    expect(view.pdf.propertyName).toBe("4123 Cedar Springs");
    expect(view.pdf.clientName).toBe("Mack Real Estate Group");
    expect(view.pdf.clientTeam).toEqual([
      { label: "DOC", name: "Jay Stauble" },
      { label: "PM", name: "Melissa Garcia" },
      { label: "RM", name: null },
      { label: "CM", name: null },
    ]);
    expect(view.pdf.trockTeam).toEqual([
      { label: "PM", name: "Adam Sherwood" },
      { label: "SUPER", name: "Steve Sanchez" },
    ]);
  });

  it("prints the note where a date is unknown, as the reference report does", () => {
    const view = buildWeeklyReportView({ report: report(), project: LIVE_PROJECT, photos: [] });
    expect(view.pdf.schedule.contractDate).toBe("7/8/26");
    expect(view.pdf.schedule.projectStartDate).toBe("TBD Permit");
    expect(view.pdf.schedule.projectCompletionDate).toBe("TBD Permit");
  });

  it("falls back to the deal name when nobody set a property display name", () => {
    const view = buildWeeklyReportView({
      report: report(),
      project: { ...LIVE_PROJECT, property_display_name: null },
      dealName: "4123 Cedar Springs (Deal)",
      photos: [],
    });
    expect(view.pdf.propertyName).toBe("4123 Cedar Springs (Deal)");
  });
});

describe("buildWeeklyReportView — a SENT report reads its own frozen snapshot", () => {
  const sent = report({ status: "sent", snapshot: SNAPSHOT, sent_at: "2026-08-13T21:00:00.000Z" });

  it("ignores a PM swap made after delivery", () => {
    // The reason the snapshot exists. Reading the live row would silently rewrite the team block on every
    // report already delivered — including inside the PDF the client downloaded and the page behind a link
    // they may have bookmarked.
    const view = buildWeeklyReportView({
      report: sent,
      project: { ...LIVE_PROJECT, trock_pm_name: "Somebody Else", client_name: "New Owner LLC" },
      photos: [],
    });
    expect(view.fromSnapshot).toBe(true);
    expect(view.pdf.clientName).toBe("Mack Real Estate Group");
    expect(view.pdf.trockTeam[0]).toEqual({ label: "PM", name: "Adam Sherwood" });
    expect(view.trockPm).toEqual({ userId: "pm-1", name: "Adam Sherwood" });
  });

  it("ignores a contract date corrected after delivery", () => {
    const view = buildWeeklyReportView({
      report: sent,
      project: { ...LIVE_PROJECT, contract_date: "2026-01-01" },
      photos: [],
    });
    expect(view.pdf.schedule.contractDate).toBe("7/8/26");
  });

  it("renders from the snapshot even if the live setup row has been deleted entirely", () => {
    const view = buildWeeklyReportView({ report: sent, project: null, photos: [] });
    expect(view.pdf.propertyName).toBe("4123 Cedar Springs");
    expect(view.pdf.clientTeam[0]).toEqual({ label: "DOC", name: "Jay Stauble" });
  });
});

describe("value formatting", () => {
  it("prints the week in the reference report's format, without a timezone shift", () => {
    // 2026-08-13 parsed as UTC midnight and read back locally prints 8/12/26 west of Greenwich — on a
    // document whose entire subject is which week it covers.
    expect(buildWeeklyReportView({ report: report(), project: LIVE_PROJECT, photos: [] }).pdf.weekOfLabel).toBe(
      "8/13/26",
    );
  });

  it("turns a numeric(5,2) string into a number a human would write", () => {
    const view = buildWeeklyReportView({
      report: report({ completion_percent: "12.50" }),
      project: LIVE_PROJECT,
      photos: [],
    });
    expect(view.pdf.schedule.completionPercent).toBe("12.5");
  });

  it("shows a dash where a number was never entered, rather than inventing a zero", () => {
    const view = buildWeeklyReportView({
      report: report({ completion_percent: null, weather_delay_days: null }),
      project: LIVE_PROJECT,
      photos: [],
    });
    expect(view.pdf.schedule.completionPercent).toBe("—");
    expect(view.pdf.schedule.weatherDelayDays).toBe("—");
  });

  it("prefers the report's own projected duration over the project's current one", () => {
    // Stored at submit precisely so a later revision of the schedule cannot rewrite the arithmetic a client
    // has already read.
    const view = buildWeeklyReportView({
      report: report({ projected_duration_weeks: 19 }),
      project: { ...LIVE_PROJECT, projected_duration_weeks: 40 },
      photos: [],
    });
    expect(view.pdf.duration.projectedWeeks).toBe(19);
  });

  it("falls back to the project when the report never reached submit", () => {
    const view = buildWeeklyReportView({
      report: report({ projected_duration_weeks: null }),
      project: LIVE_PROJECT,
      photos: [],
    });
    expect(view.pdf.duration.projectedWeeks).toBe(19);
  });

  it("normalises a Date week_of to an ISO day", () => {
    const view = buildWeeklyReportView({
      report: report({ week_of: new Date("2026-08-13T00:00:00.000Z") }),
      project: LIVE_PROJECT,
      photos: [],
    });
    expect(view.weekOf).toBe("2026-08-13");
  });
});
