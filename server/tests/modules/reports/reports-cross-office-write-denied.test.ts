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

const scheduleInput = {
  reportId: "locked-report-office-b",
  userId: "user-1",
  frequency: "weekly" as const,
  cronExpr: "0 7 * * 1",
  recipients: [],
  nextRunAt: "2026-05-11T12:00:00.000Z",
};

describe("report write paths enforce office scope", () => {
  beforeEach(() => {
    state.selectResults = [];
    state.insertedValues = [];
    state.returningRows = [{ id: "created-row" }];
    vi.clearAllMocks();
  });

  it("rejects schedule creation for locked reports scoped to another office", async () => {
    state.selectResults = [[]];

    await expect(createReportSchedule({
      ...scheduleInput,
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
      ...scheduleInput,
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

    const run = await createReportRun({
      reportId: "locked-report-office-b",
      scheduleId: null,
      userId: "user-1",
      officeId: "office-b",
    });

    expect(run).toEqual({ id: "created-row" });
    expect(state.insertedValues[0]).toMatchObject({
      reportId: "locked-report-office-b",
      scheduleId: null,
      status: "queued",
    });
  });
});
