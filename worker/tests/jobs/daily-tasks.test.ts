import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const evaluateTaskRulesMock = vi.fn();
const createTenantTaskRulePersistenceMock = vi.fn();
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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
  TASK_RULES: [
    { id: "daily_close_date_follow_up" },
    { id: "daily_first_outreach_touchpoint" },
    { id: "daily_cadence_overdue_follow_up" },
  ],
}));

vi.mock("../../../server/src/modules/tasks/rules/persistence.js", () => ({
  createTenantTaskRulePersistence: createTenantTaskRulePersistenceMock,
}));

const { runDailyTaskGeneration } = await import("../../src/jobs/daily-tasks.js");

describe("daily task generation worker", () => {
  beforeEach(() => {
    queryMock.mockReset();
    evaluateTaskRulesMock.mockReset();
    createTenantTaskRulePersistenceMock.mockReset();
    consoleErrorSpy.mockClear();
  });

  it("routes the remaining direct daily task creation paths through the shared evaluator", async () => {
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ ruleId: "daily_close_date_follow_up", action: "created" }]);

    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "beta" }] };
      }

      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }

      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }

      if (sql.includes("UPDATE office_beta.tasks")) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("FROM office_beta.deals d") && sql.includes("expected_close_date BETWEEN")) {
        return {
          rows: [
            {
              deal_id: "deal-1",
              deal_name: "Alpha Roof",
              deal_number: "D-1001",
              assigned_rep_id: "user-1",
              expected_close_date: "2026-04-11",
            },
          ],
        };
      }

      if (sql.includes("FROM office_beta.contacts c") && sql.includes("first_outreach_completed = false")) {
        return {
          rows: [
            {
              contact_id: "contact-1",
              first_name: "Brett",
              last_name: "Smith",
            },
          ],
        };
      }

      if (sql.includes("SELECT cda.deal_id, d.assigned_rep_id")) {
        return {
          rows: [{ deal_id: "deal-1", assigned_rep_id: "user-1" }],
        };
      }

      if (sql.includes("FROM office_beta.contacts c") && sql.includes("touchpoint_cadence_days")) {
        return {
          rows: [
            {
              contact_id: "contact-1",
              first_name: "Brett",
              last_name: "Smith",
              last_contacted_at: "2026-03-20T00:00:00.000Z",
              deal_id: "deal-1",
              deal_number: "D-1001",
              deal_name: "Alpha Roof",
              assigned_rep_id: "user-1",
              touchpoint_cadence_days: 10,
            },
          ],
        };
      }

      if (sql.includes("FROM office_beta.leads l") && sql.includes("psc.stale_threshold_days")) {
        return {
          rows: [
            {
              lead_id: "lead-1",
              lead_name: "Duncanville Opportunity",
              assigned_rep_id: "user-1",
              stage_entered_at: "2026-03-15T00:00:00.000Z",
              stage_name: "Qualified",
              stale_threshold_days: 10,
              days_in_stage: 20,
            },
          ],
        };
      }

      if (sql.includes("FROM office_beta.tasks") && sql.includes("origin_rule = 'stale_lead'")) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.startsWith("INSERT INTO office_beta.notifications")) {
        return { rows: [{ id: "notification-1" }] };
      }

      if (sql.startsWith("INSERT INTO office_beta.tasks")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T15:00:00.000Z"));

    await runDailyTaskGeneration();

    expect(createTenantTaskRulePersistenceMock).toHaveBeenCalledWith(expect.any(Object), "office_beta");
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: "cron.daily_task_generation.close_date_follow_up",
        officeId: "office-1",
        entityId: "deal:deal-1",
        dealId: "deal-1",
        dealName: "Alpha Roof",
        dealNumber: "D-1001",
        dealOwnerId: "user-1",
        taskAssigneeId: "user-1",
        dueAt: "2026-04-11",
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: "cron.daily_task_generation.first_outreach_touchpoint",
        officeId: "office-1",
        entityId: "contact:contact-1",
        contactId: "contact-1",
        contactName: "Brett Smith",
        taskAssigneeId: "user-1",
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: "cron.daily_task_generation.cadence_overdue_follow_up",
        officeId: "office-1",
        entityId: "contact:contact-1",
        contactId: "contact-1",
        contactName: "Brett Smith",
        dealId: "deal-1",
        dealNumber: "D-1001",
        dealOwnerId: "user-1",
        taskAssigneeId: "user-1",
        lastContactedAt: "2026-03-20T00:00:00.000Z",
        touchpointCadenceDays: 10,
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: "cron.daily_task_generation.stale_lead",
        officeId: "office-1",
        entityId: "lead:lead-1",
        leadId: "lead-1",
        leadName: "Duncanville Opportunity",
        stage: "Qualified",
        staleAge: 20,
        taskAssigneeId: "user-1",
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks"))
    ).toBe(false);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
