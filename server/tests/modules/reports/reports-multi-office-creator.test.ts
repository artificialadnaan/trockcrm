import { beforeEach, describe, expect, it, vi } from "vitest";

type Predicate = (row: Record<string, unknown>) => boolean;

const state = vi.hoisted(() => ({
  reports: [] as Array<Record<string, unknown>>,
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
      orderBy() {
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
    },
  };
});

vi.mock("@trock-crm/shared/schema", () => ({
  savedReports: {
    id: "saved_reports.id",
    isLocked: "saved_reports.is_locked",
    isDefault: "saved_reports.is_default",
    officeId: "saved_reports.office_id",
    createdBy: "saved_reports.created_by",
    visibility: "saved_reports.visibility",
    updatedAt: "saved_reports.updated_at",
  },
  reportSchedules: {},
  reportRuns: {},
}));

import {
  getSavedReportById,
  getSavedReports,
} from "../../../src/modules/reports/saved-reports-service.js";

const CREATED_REPORT_ID = "11111111-1111-4111-8111-111111111111";

describe("saved report creator visibility across offices", () => {
  beforeEach(() => {
    state.reports = [
      {
        id: CREATED_REPORT_ID,
        is_locked: false,
        is_default: false,
        office_id: "office-a",
        created_by: "user-1",
        visibility: "private",
        updated_at: new Date("2026-05-07T12:00:00.000Z"),
      },
    ];
    vi.clearAllMocks();
  });

  it("keeps user-created reports visible when the active office changes", async () => {
    const reports = await getSavedReports("user-1", "office-b");

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ id: CREATED_REPORT_ID });
  });

  it("keeps user-created reports addressable by id when the active office changes", async () => {
    const report = await getSavedReportById(CREATED_REPORT_ID, "user-1", "office-b");

    expect(report).toMatchObject({ id: CREATED_REPORT_ID });
  });
});
