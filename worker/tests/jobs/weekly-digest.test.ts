import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const evaluateTaskRulesMock = vi.fn();
const createTenantTaskRulePersistenceMock = vi.fn();

vi.mock("../../src/db.js", () => ({
  pool: {
    connect: async () => ({
      query: queryMock,
      release: vi.fn(),
    }),
  },
}));

vi.mock("../../../server/src/modules/tasks/rules/evaluator.js", () => ({
  evaluateTaskRules: evaluateTaskRulesMock,
}));

vi.mock("../../../server/src/modules/tasks/rules/config.js", () => ({
  TASK_RULES: [{ id: "weekly_pipeline_digest" }],
}));

vi.mock("../../../server/src/modules/tasks/rules/persistence.js", () => ({
  createTenantTaskRulePersistence: createTenantTaskRulePersistenceMock,
}));

const { runWeeklyDigest } = await import("../../src/jobs/weekly-digest.js");

describe("weekly digest worker", () => {
  beforeEach(() => {
    queryMock.mockReset();
    evaluateTaskRulesMock.mockReset();
    createTenantTaskRulePersistenceMock.mockReset();
  });

  it("routes weekly digest task creation through the shared evaluator", async () => {
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ action: "created" }]);

    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices WHERE is_active = true")) {
        return { rows: [{ id: "11111111-1111-1111-1111-111111111111", slug: "beta", name: "Beta" }] };
      }

      if (sql.includes("SELECT pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }

      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rows: [] };
      }

      if (sql.includes("AS stage_slug") && sql.includes("on_hold_accumulated_seconds")) {
        const now = new Date("2026-04-06T12:00:00.000Z");
        return {
          rows: Array.from({ length: 3 }, () => ({
            stage_slug: "estimating",
            workflow_route: "normal",
            stage_entered_at: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000),
            on_hold: false,
            on_hold_started_at: null,
            on_hold_accumulated_seconds: 0,
            on_hold_accumulated_seconds_at_stage_entry: 0,
          })),
        };
      }

      if (sql.includes("COUNT(*) AS count") && sql.includes("expected_close_date")) {
        return { rows: [{ count: "2" }] };
      }

      if (sql.includes("COUNT(*) AS count") && sql.includes("created_at >= NOW() - interval '7 days'")) {
        return { rows: [{ count: "4" }] };
      }

      if (sql.includes("), 0) AS total_value")) {
        return { rows: [{ total_value: "250000" }] };
      }

      if (sql.includes("FROM public.users") && sql.includes("role IN ('director', 'admin')")) {
        return { rows: [{ id: "director-1" }, { id: "director-2" }] };
      }

      if (sql.includes("SELECT pg_advisory_unlock")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:00:00.000Z"));

    await runWeeklyDigest();

    const atRiskSql = queryMock.mock.calls
      .map(([sql]) => sql)
      .find((sql) => typeof sql === "string" && sql.includes("AS stage_slug"));
    expect(atRiskSql).toContain("COALESCE(d.is_test_data, false) = false");
    expect(createTenantTaskRulePersistenceMock).toHaveBeenCalledWith(expect.any(Object), "office_beta");
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: "cron.weekly_digest",
        officeId: "11111111-1111-1111-1111-111111111111",
        officeName: "Beta",
        entityId: "office:11111111-1111-1111-1111-111111111111",
        taskAssigneeId: "director-1",
        staleCount: 3,
        approachingCount: 2,
        newDealsCount: 4,
        pipelineValue: 250000,
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskAssigneeId: "director-2",
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks"))
    ).toBe(false);

    vi.useRealTimers();
  });

  it("counts stale deals with the shared At Risk engine so active on-hold deals are excluded", async () => {
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ action: "created" }]);

    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices WHERE is_active = true")) {
        return { rows: [{ id: "11111111-1111-1111-1111-111111111111", slug: "beta", name: "Beta" }] };
      }

      if (sql.includes("SELECT pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }

      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rows: [] };
      }

      if (sql.includes("AS stage_slug") && sql.includes("on_hold_accumulated_seconds")) {
        const now = new Date("2026-04-06T12:00:00.000Z");
        return {
          rows: [
            {
              stage_slug: "estimating",
              workflow_route: "normal",
              stage_entered_at: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000),
              on_hold: false,
              on_hold_started_at: null,
              on_hold_accumulated_seconds: 0,
              on_hold_accumulated_seconds_at_stage_entry: 0,
            },
            {
              stage_slug: "estimating",
              workflow_route: "normal",
              stage_entered_at: new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000),
              on_hold: true,
              on_hold_started_at: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
              on_hold_accumulated_seconds: 0,
              on_hold_accumulated_seconds_at_stage_entry: 0,
            },
          ],
        };
      }

      if (sql.includes("COUNT(*) AS count") && sql.includes("expected_close_date")) {
        return { rows: [{ count: "2" }] };
      }

      if (sql.includes("COUNT(*) AS count") && sql.includes("created_at >= NOW() - interval '7 days'")) {
        return { rows: [{ count: "4" }] };
      }

      if (sql.includes("), 0) AS total_value")) {
        return { rows: [{ total_value: "250000" }] };
      }

      if (sql.includes("FROM public.users") && sql.includes("role IN ('director', 'admin')")) {
        return { rows: [{ id: "director-1" }] };
      }

      if (sql.includes("SELECT pg_advisory_unlock")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:00:00.000Z"));

    await runWeeklyDigest();

    const atRiskSql = queryMock.mock.calls
      .map(([sql]) => sql)
      .find((sql) => typeof sql === "string" && sql.includes("AS stage_slug"));
    expect(atRiskSql).toContain("COALESCE(d.is_test_data, false) = false");
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        staleCount: 1,
      }),
      taskPersistence,
      expect.any(Array)
    );

    vi.useRealTimers();
  });
});
