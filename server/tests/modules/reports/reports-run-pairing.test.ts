import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

const state = vi.hoisted(() => ({
  selectResults: [] as any[][],
  insertedValues: [] as any[],
  returningRows: [{ id: "run-1", status: "queued" }],
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
  },
  reportRuns: {
    reportId: "report_runs.report_id",
    scheduleId: "report_runs.schedule_id",
    status: "report_runs.status",
  },
}));

import { createReportRun } from "../../../src/modules/reports/saved-reports-service.js";

const reportA = {
  id: "report-a",
  isLocked: false,
  visibility: "private",
  createdBy: "user-1",
  officeId: "office-1",
};

const scheduleA = { id: "schedule-a", reportId: "report-a" };
const scheduleB = { id: "schedule-b", reportId: "report-b" };

describe("createReportRun schedule/report pairing", () => {
  beforeEach(() => {
    state.selectResults = [];
    state.insertedValues = [];
    state.returningRows = [{ id: "run-1", status: "queued" }];
    vi.clearAllMocks();
  });

  it("rejects schedule ids that belong to another report", async () => {
    state.selectResults = [[reportA], [scheduleB]];

    await expect(createReportRun({
      reportId: "report-a",
      scheduleId: "schedule-b",
      userId: "user-1",
      officeId: "office-1",
    })).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message: "scheduleId does not belong to reportId",
    });

    expect(state.insertedValues).toHaveLength(0);
  });

  it("allows schedule ids that belong to the requested report", async () => {
    state.selectResults = [[reportA], [scheduleA]];

    const run = await createReportRun({
      reportId: "report-a",
      scheduleId: "schedule-a",
      userId: "user-1",
      officeId: "office-1",
    });

    expect(run).toEqual({ id: "run-1", status: "queued" });
    expect(state.insertedValues[0]).toMatchObject({
      reportId: "report-a",
      scheduleId: "schedule-a",
      status: "queued",
    });
  });

  it("allows manual report runs without a schedule id", async () => {
    state.selectResults = [[reportA]];

    const run = await createReportRun({
      reportId: "report-a",
      scheduleId: null,
      userId: "user-1",
      officeId: "office-1",
    });

    expect(run).toEqual({ id: "run-1", status: "queued" });
    expect(state.insertedValues[0]).toMatchObject({
      reportId: "report-a",
      scheduleId: null,
      status: "queued",
    });
  });
});
