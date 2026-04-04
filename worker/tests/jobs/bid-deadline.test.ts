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
  TASK_RULES: [{ id: "bid_deadline_countdown" }],
}));

vi.mock("../../../server/src/modules/tasks/rules/persistence.js", () => ({
  createTenantTaskRulePersistence: createTenantTaskRulePersistenceMock,
}));

const { runBidDeadlineCountdown } = await import("../../src/jobs/bid-deadline.js");

describe("bid deadline worker", () => {
  beforeEach(() => {
    queryMock.mockReset();
    evaluateTaskRulesMock.mockReset();
    createTenantTaskRulePersistenceMock.mockReset();
  });

  it("delegates countdown task creation to the rule evaluator without issuing raw task inserts", async () => {
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ ruleId: "bid_deadline_countdown", action: "created" }]);

    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "beta" }] };
      }

      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rows: [] };
      }

      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }

      if (sql.includes("UPDATE office_beta.tasks t")) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("FROM office_beta.deals d")) {
        return {
          rows: [
            {
              id: "deal-1",
              name: "Alpha Roof",
              expected_close_date: "2026-04-18",
              assigned_rep_id: "user-1",
            },
          ],
        };
      }

      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T15:00:00.000Z"));

    await runBidDeadlineCountdown();

    expect(createTenantTaskRulePersistenceMock).toHaveBeenCalledWith(expect.any(Object), "office_beta");
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: "cron.bid_deadline",
        officeId: "office-1",
        entityId: "deal:deal-1",
        dealId: "deal-1",
        dealOwnerId: "user-1",
        dealName: "Alpha Roof",
        daysUntil: 14,
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks"))
    ).toBe(false);

    vi.useRealTimers();
  });
});
