import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

const state = vi.hoisted(() => ({
  selectResults: [] as any[][],
  insertedValues: [] as any[],
  returningRows: [{ id: "created-row" }],
}));

vi.mock("../../../src/db.js", () => {
  const selectChain = {
    from() {
      return this;
    },
    where() {
      return this;
    },
    limit() {
      return this;
    },
    then(resolve: (value: unknown) => void) {
      resolve(state.selectResults.shift() ?? []);
    },
  };

  const insertChain = {
    values(values: any) {
      state.insertedValues.push(values);
      return {
        returning() {
          return Promise.resolve(state.returningRows);
        },
      };
    },
  };

  return {
    db: {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => insertChain),
    },
  };
});

vi.mock("@trock-crm/shared/schema", () => ({
  savedReports: {
    id: "saved_reports.id",
    isLocked: "saved_reports.is_locked",
    officeId: "saved_reports.office_id",
    createdBy: "saved_reports.created_by",
    visibility: "saved_reports.visibility",
  },
  reportSchedules: {
    id: "report_schedules.id",
    reportId: "report_schedules.report_id",
    frequency: "report_schedules.frequency",
    cronExpr: "report_schedules.cron_expr",
    recipients: "report_schedules.recipients",
    nextRunAt: "report_schedules.next_run_at",
    ownerId: "report_schedules.owner_id",
  },
  reportRuns: {
    reportId: "report_runs.report_id",
    scheduleId: "report_runs.schedule_id",
    status: "report_runs.status",
  },
}));

import {
  createReportRun,
  createReportSchedule,
} from "../../../src/modules/reports/saved-reports-service.js";

const officeBLockedReport = {
  id: "locked-report-office-b",
  isLocked: true,
  visibility: "company",
  createdBy: null,
  officeId: "office-b",
};

const companySharedReport = {
  id: "company-report",
  isLocked: false,
  visibility: "company",
  createdBy: "admin-1",
  officeId: "office-b",
};

const globalLockedReport = {
  id: "global-locked-report",
  isLocked: true,
  visibility: "company",
  createdBy: null,
  officeId: null,
};

function scheduleInput(reportId: string) {
  return {
    reportId,
    userId: "user-1",
    frequency: "weekly" as const,
    cronExpr: "0 7 * * 1",
    recipients: [],
    nextRunAt: "2026-05-11T12:00:00.000Z",
  };
}

function runInput(reportId: string, officeId: string) {
  return {
    reportId,
    scheduleId: null,
    userId: "user-1",
    officeId,
  };
}

const officeBReportScheduleInput = {
  ...scheduleInput("locked-report-office-b"),
  userId: "user-1",
};

describe("report write paths follow saved report visibility", () => {
  beforeEach(() => {
    state.selectResults = [];
    state.insertedValues = [];
    state.returningRows = [{ id: "created-row" }];
    vi.clearAllMocks();
  });

  it("rejects schedule creation for locked reports scoped to another office", async () => {
    state.selectResults = [[]];

    await expect(createReportSchedule({
      ...officeBReportScheduleInput,
      officeId: "office-a",
    })).rejects.toMatchObject<AppError>({
      statusCode: 404,
      message: "Report not found",
    });

    expect(state.insertedValues).toHaveLength(0);
  });

  it("allows schedule creation for locked reports scoped to the user's office", async () => {
    state.selectResults = [[officeBLockedReport]];

    const schedule = await createReportSchedule({
      ...officeBReportScheduleInput,
      officeId: "office-b",
    });

    expect(schedule).toEqual({ id: "created-row" });
    expect(state.insertedValues[0]).toMatchObject({
      reportId: "locked-report-office-b",
      frequency: "weekly",
      ownerId: "user-1",
    });
  });

  it("rejects run creation for locked reports scoped to another office", async () => {
    state.selectResults = [[]];

    await expect(createReportRun({
      reportId: "locked-report-office-b",
      scheduleId: null,
      userId: "user-1",
      officeId: "office-a",
    })).rejects.toMatchObject<AppError>({
      statusCode: 404,
      message: "Report not found",
    });

    expect(state.insertedValues).toHaveLength(0);
  });

  it("allows run creation for locked reports scoped to the user's office", async () => {
    state.selectResults = [[officeBLockedReport]];

    const run = await createReportRun(runInput("locked-report-office-b", "office-b"));

    expect(run).toEqual({ id: "created-row" });
    expect(state.insertedValues[0]).toMatchObject({
      reportId: "locked-report-office-b",
      scheduleId: null,
      status: "queued",
    });
  });

  it("allows schedule creation for company-shared reports visible across offices", async () => {
    state.selectResults = [[companySharedReport]];

    const schedule = await createReportSchedule({
      ...scheduleInput("company-report"),
      officeId: "office-a",
    });

    expect(schedule).toEqual({ id: "created-row" });
    expect(state.insertedValues[0]).toMatchObject({
      reportId: "company-report",
      frequency: "weekly",
      ownerId: "user-1",
    });
  });

  it("allows run creation for company-shared reports visible across offices", async () => {
    state.selectResults = [[companySharedReport]];

    const run = await createReportRun(runInput("company-report", "office-a"));

    expect(run).toEqual({ id: "created-row" });
    expect(state.insertedValues[0]).toMatchObject({
      reportId: "company-report",
      scheduleId: null,
      status: "queued",
    });
  });

  it("allows schedule creation for globally locked reports", async () => {
    state.selectResults = [[globalLockedReport]];

    const schedule = await createReportSchedule({
      ...scheduleInput("global-locked-report"),
      officeId: "office-a",
    });

    expect(schedule).toEqual({ id: "created-row" });
    expect(state.insertedValues[0]).toMatchObject({
      reportId: "global-locked-report",
      frequency: "weekly",
      ownerId: "user-1",
    });
  });

  it("allows run creation for globally locked reports", async () => {
    state.selectResults = [[globalLockedReport]];

    const run = await createReportRun(runInput("global-locked-report", "office-a"));

    expect(run).toEqual({ id: "created-row" });
    expect(state.insertedValues[0]).toMatchObject({
      reportId: "global-locked-report",
      scheduleId: null,
      status: "queued",
    });
  });
});
