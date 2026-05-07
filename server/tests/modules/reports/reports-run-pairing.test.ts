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

const REPORT_A_ID = "11111111-1111-4111-8111-111111111111";
const REPORT_B_ID = "22222222-2222-4222-8222-222222222222";
const SCHEDULE_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCHEDULE_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const reportA = {
  id: REPORT_A_ID,
  isLocked: false,
  visibility: "private",
  createdBy: "user-1",
  officeId: "office-1",
};

const scheduleA = { id: SCHEDULE_A_ID, reportId: REPORT_A_ID };
const scheduleB = { id: SCHEDULE_B_ID, reportId: REPORT_B_ID };

describe("createReportRun schedule/report pairing", () => {
  beforeEach(() => {
    state.selectResults = [];
    state.insertedValues = [];
    state.returningRows = [{ id: "run-1", status: "queued" }];
    vi.clearAllMocks();
  });

  it("rejects malformed report ids before querying", async () => {
    await expect(createReportRun({
      reportId: "not-a-uuid",
      scheduleId: null,
      userId: "user-1",
      officeId: "office-1",
    })).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message: "reportId must be a valid UUID",
    });

    expect(state.insertedValues).toHaveLength(0);
    expect(state.selectResults).toHaveLength(0);
  });

  it("rejects malformed schedule ids before schedule lookup", async () => {
    await expect(createReportRun({
      reportId: REPORT_A_ID,
      scheduleId: "not-a-uuid",
      userId: "user-1",
      officeId: "office-1",
    })).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message: "scheduleId must be a valid UUID",
    });

    expect(state.insertedValues).toHaveLength(0);
    expect(state.selectResults).toHaveLength(0);
  });

  it("rejects schedule ids that belong to another report", async () => {
    state.selectResults = [[reportA], [scheduleB]];

    await expect(createReportRun({
      reportId: REPORT_A_ID,
      scheduleId: SCHEDULE_B_ID,
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
      reportId: REPORT_A_ID,
      scheduleId: SCHEDULE_A_ID,
      userId: "user-1",
      officeId: "office-1",
    });

    expect(run).toEqual({ id: "run-1", status: "queued" });
    expect(state.insertedValues[0]).toMatchObject({
      reportId: REPORT_A_ID,
      scheduleId: SCHEDULE_A_ID,
      status: "queued",
    });
  });

  it("allows manual report runs without a schedule id", async () => {
    state.selectResults = [[reportA]];

    const run = await createReportRun({
      reportId: REPORT_A_ID,
      scheduleId: null,
      userId: "user-1",
      officeId: "office-1",
    });

    expect(run).toEqual({ id: "run-1", status: "queued" });
    expect(state.insertedValues[0]).toMatchObject({
      reportId: REPORT_A_ID,
      scheduleId: null,
      status: "queued",
    });
  });
});
