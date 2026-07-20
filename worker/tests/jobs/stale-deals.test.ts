import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  TASK_RULES: [{ id: "stale_deal" }],
}));

vi.mock("../../../server/src/modules/tasks/rules/persistence.js", () => ({
  createTenantTaskRulePersistence: createTenantTaskRulePersistenceMock,
}));

const { runStaleDealScan } = await import("../../src/jobs/stale-deals.js");

describe("stale deal worker", () => {
  beforeEach(() => {
    queryMock.mockReset();
    evaluateTaskRulesMock.mockReset();
    createTenantTaskRulePersistenceMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates stale deal task generation to the rule evaluator without issuing a raw task insert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));

    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ ruleId: "stale_deal", action: "created" }]);

    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "beta" }] };
      }

      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }

      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }

      if (sql.includes("FROM office_beta.deals")) {
        return {
          rows: [
            {
              deal_id: "deal-1",
              deal_name: "Alpha Roof",
              deal_number: "D-1001",
              assigned_rep_id: "user-1",
              stage_slug: "estimating",
              workflow_route: "normal",
              stage_entered_at: new Date("2026-03-01T12:00:00.000Z"),
              on_hold: false,
              on_hold_started_at: null,
              on_hold_accumulated_seconds: 0,
              on_hold_accumulated_seconds_at_stage_entry: 0,
              stage_name: "Proposal",
              stale_escalation_tiers: [],
            },
          ],
        };
      }

      if (sql.includes("FROM office_beta.notifications")) {
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO office_beta.notifications")) {
        return { rows: [{ id: "notification-1" }] };
      }

      if (sql.includes("SELECT pg_notify")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await runStaleDealScan();

    const staleDealSql = queryMock.mock.calls
      .map(([sql]) => sql)
      .find((sql) => typeof sql === "string" && sql.includes("FROM office_beta.deals"));
    expect(staleDealSql).toContain("COALESCE(d.is_test_data, false) = false");
    expect(createTenantTaskRulePersistenceMock).toHaveBeenCalledWith(expect.any(Object), "office_beta");
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        officeId: "office-1",
        entityId: "deal:deal-1",
        sourceEvent: "deal.updated",
        dealId: "deal-1",
        dealOwnerId: "user-1",
        stage: "Proposal",
        staleAge: 31,
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks"))
    ).toBe(false);
  });

  it("uses the shared At Risk engine so active on-hold deals do not generate stale deal tasks", async () => {
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ ruleId: "stale_deal", action: "created" }]);

    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "beta" }] };
      }

      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }

      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }

      if (sql.includes("FROM office_beta.deals")) {
        return {
          rows: [
            {
              deal_id: "deal-held",
              deal_name: "Held Roof",
              deal_number: "D-HELD",
              assigned_rep_id: "user-1",
              stage_slug: "estimating",
              workflow_route: "normal",
              stage_entered_at: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
              on_hold: true,
              on_hold_started_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
              on_hold_accumulated_seconds: 0,
              on_hold_accumulated_seconds_at_stage_entry: 0,
              stage_name: "Estimating",
              stale_escalation_tiers: [],
            },
            {
              deal_id: "deal-active",
              deal_name: "Active Roof",
              deal_number: "D-ACTIVE",
              assigned_rep_id: "user-1",
              stage_slug: "estimating",
              workflow_route: "normal",
              stage_entered_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
              on_hold: false,
              on_hold_started_at: null,
              on_hold_accumulated_seconds: 0,
              on_hold_accumulated_seconds_at_stage_entry: 0,
              stage_name: "Estimating",
              stale_escalation_tiers: [],
            },
          ],
        };
      }

      if (sql.includes("FROM office_beta.notifications")) {
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO office_beta.notifications")) {
        return { rows: [{ id: "notification-1" }] };
      }

      if (sql.includes("SELECT pg_notify")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await runStaleDealScan();

    const staleDealSql = queryMock.mock.calls
      .map(([sql]) => sql)
      .find((sql) => typeof sql === "string" && sql.includes("FROM office_beta.deals"));
    expect(staleDealSql).toContain("COALESCE(d.is_test_data, false) = false");
    expect(evaluateTaskRulesMock).toHaveBeenCalledTimes(1);
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-active",
        staleAge: 15,
      }),
      taskPersistence,
      expect.any(Array)
    );
  });

  it("does not generate a stale deal task for a near-postponed (future close target) over-SLA deal", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ ruleId: "stale_deal", action: "created" }]);

    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "beta" }] };
      }

      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }

      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }

      if (sql.includes("FROM office_beta.deals")) {
        return {
          rows: [
            {
              // Over-SLA but POSTPONED to a near (11-day) target via "Move Close Date". The nightly stale
              // scan must honor that postponement (applyCloseTargetSuppression:true) — no task/notification.
              deal_id: "deal-postponed",
              deal_name: "Postponed Roof",
              deal_number: "D-POSTP",
              assigned_rep_id: "user-1",
              stage_slug: "estimating",
              workflow_route: "normal",
              stage_entered_at: new Date(Date.now() - 45 * dayMs),
              expected_close_date: new Date(Date.now() + 11 * dayMs).toISOString().slice(0, 10),
              on_hold: false,
              on_hold_started_at: null,
              on_hold_accumulated_seconds: 0,
              on_hold_accumulated_seconds_at_stage_entry: 0,
              stage_name: "Estimating",
              stale_escalation_tiers: [],
            },
            {
              deal_id: "deal-active",
              deal_name: "Active Roof",
              deal_number: "D-ACTIVE",
              assigned_rep_id: "user-1",
              stage_slug: "estimating",
              workflow_route: "normal",
              stage_entered_at: new Date(Date.now() - 15 * dayMs),
              expected_close_date: null,
              on_hold: false,
              on_hold_started_at: null,
              on_hold_accumulated_seconds: 0,
              on_hold_accumulated_seconds_at_stage_entry: 0,
              stage_name: "Estimating",
              stale_escalation_tiers: [],
            },
          ],
        };
      }

      if (sql.includes("FROM office_beta.notifications")) {
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO office_beta.notifications")) {
        return { rows: [{ id: "notification-1" }] };
      }

      if (sql.includes("SELECT pg_notify")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await runStaleDealScan();

    // Only the non-postponed active over-SLA deal reaches the rule evaluator.
    expect(evaluateTaskRulesMock).toHaveBeenCalledTimes(1);
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: "deal-active" }),
      taskPersistence,
      expect.any(Array)
    );
  });

  it("rolls back the office transaction when notification fan-out fails mid-deal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));

    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "beta" }] };
      }

      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }

      if (sql.includes("FROM office_beta.deals")) {
        return {
          rows: [
            {
              deal_id: "deal-1",
              deal_name: "Alpha Roof",
              deal_number: "D-1001",
              assigned_rep_id: "user-1",
              stage_slug: "estimating",
              workflow_route: "normal",
              stage_entered_at: new Date("2026-03-01T12:00:00.000Z"),
              on_hold: false,
              on_hold_started_at: null,
              on_hold_accumulated_seconds: 0,
              on_hold_accumulated_seconds_at_stage_entry: 0,
              stage_name: "Proposal",
              stale_escalation_tiers: [{ days: 20, severity: "critical" }],
            },
          ],
        };
      }

      if (sql.includes("FROM office_beta.notifications")) {
        return { rows: [] };
      }

      if (sql.includes("reports_to")) {
        return { rows: [{ reports_to: "manager-1" }] };
      }

      if (sql.includes("role IN ('director', 'admin')")) {
        return { rows: [{ id: "admin-1" }] };
      }

      if (sql.includes("INSERT INTO office_beta.notifications")) {
        if (params?.[0] === "admin-1") {
          throw new Error("notify-failed");
        }
        return { rows: [{ id: "notification-1" }] };
      }

      if (sql.includes("SELECT pg_notify")) {
        return { rows: [] };
      }

      return { rows: [] };
    });

    await expect(runStaleDealScan()).rejects.toThrow("notify-failed");

    expect(queryMock).toHaveBeenCalledWith("ROLLBACK");
    expect(evaluateTaskRulesMock).not.toHaveBeenCalled();
  });
});
