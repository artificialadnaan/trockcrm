import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

type Predicate = (row: Record<string, unknown>) => boolean;

const state = vi.hoisted(() => ({
  reports: [] as Array<Record<string, unknown>>,
  insertedValues: [] as any[],
  returningRows: [{ id: "created-row" }],
}));

const fieldName = (field: string) => field.split(".").at(-1) ?? field;

vi.mock("drizzle-orm", () => ({
  eq: (field: string, value: unknown): Predicate => {
    const key = fieldName(field);
    return (row) => row[key] === value;
  },
  and: (...predicates: Predicate[]): Predicate => (row) => predicates.every((predicate) => predicate(row)),
  or: (...predicates: Predicate[]): Predicate => (row) => predicates.some((predicate) => predicate(row)),
  isNull: (field: string): Predicate => {
    const key = fieldName(field);
    return (row) => row[key] === null;
  },
  desc: (field: string) => field,
  sql: vi.fn(),
}));

vi.mock("../../../src/db.js", () => {
  const createSelectChain = () => {
    let predicate: Predicate = () => true;
    let limitCount: number | null = null;

    const chain = {
      from() {
        return this;
      },
      where(nextPredicate: Predicate) {
        predicate = nextPredicate;
        return this;
      },
      limit(count: number) {
        limitCount = count;
        return this;
      },
      then(resolve: (value: unknown) => void) {
        const rows = state.reports.filter(predicate);
        resolve(limitCount === null ? rows : rows.slice(0, limitCount));
      },
    };

    return chain;
  };

  return {
    db: {
      select: vi.fn(createSelectChain),
      insert: vi.fn(() => ({
        values(values: any) {
          state.insertedValues.push(values);
          return {
            returning() {
              return Promise.resolve(state.returningRows);
            },
          };
        },
      })),
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
    anchorDay: "report_schedules.anchor_day",
    nextRunAt: "report_schedules.next_run_at",
    ownerId: "report_schedules.owner_id",
  },
  reportRuns: {
    reportId: "report_runs.report_id",
    scheduleId: "report_runs.schedule_id",
    status: "report_runs.status",
  },
}));

import { createReportSchedule } from "../../../src/modules/reports/saved-reports-service.js";

const OFFICE_B_LOCKED_REPORT_ID = "33333333-3333-4333-8333-333333333333";
const COMPANY_REPORT_ID = "44444444-4444-4444-8444-444444444444";
const GLOBAL_LOCKED_REPORT_ID = "55555555-5555-4555-8555-555555555555";

function scheduleInput(reportId: string, officeId: string) {
  return {
    reportId,
    userId: "user-1",
    officeId,
    frequency: "weekly" as const,
    cronExpr: "0 7 * * 1",
    recipients: [],
    nextRunAt: "2026-05-11T12:00:00.000Z",
  };
}

describe("locked report company visibility scoping", () => {
  beforeEach(() => {
    state.reports = [
      {
        id: OFFICE_B_LOCKED_REPORT_ID,
        is_locked: true,
        visibility: "company",
        created_by: null,
        office_id: "office-b",
      },
      {
        id: GLOBAL_LOCKED_REPORT_ID,
        is_locked: true,
        visibility: "company",
        created_by: null,
        office_id: null,
      },
      {
        id: COMPANY_REPORT_ID,
        is_locked: false,
        visibility: "company",
        created_by: "admin-1",
        office_id: "office-b",
      },
    ];
    state.insertedValues = [];
    state.returningRows = [{ id: "created-row" }];
    vi.clearAllMocks();
  });

  it("rejects locked company-visible reports scoped to another office", async () => {
    await expect(createReportSchedule(
      scheduleInput(OFFICE_B_LOCKED_REPORT_ID, "office-a")
    )).rejects.toMatchObject<AppError>({
      statusCode: 404,
      message: "Report not found",
    });

    expect(state.insertedValues).toHaveLength(0);
  });

  it("allows locked company-visible reports scoped to the user's office", async () => {
    const schedule = await createReportSchedule(scheduleInput(OFFICE_B_LOCKED_REPORT_ID, "office-b"));

    expect(schedule).toEqual({ id: "created-row" });
    expect(state.insertedValues[0]).toMatchObject({ reportId: OFFICE_B_LOCKED_REPORT_ID });
  });

  it("allows globally locked company-visible reports from any office", async () => {
    const schedule = await createReportSchedule(scheduleInput(GLOBAL_LOCKED_REPORT_ID, "office-a"));

    expect(schedule).toEqual({ id: "created-row" });
    expect(state.insertedValues[0]).toMatchObject({ reportId: GLOBAL_LOCKED_REPORT_ID });
  });

  it("allows non-locked company-visible reports across offices", async () => {
    const schedule = await createReportSchedule(scheduleInput(COMPANY_REPORT_ID, "office-a"));

    expect(schedule).toEqual({ id: "created-row" });
    expect(state.insertedValues[0]).toMatchObject({ reportId: COMPANY_REPORT_ID });
  });
});
