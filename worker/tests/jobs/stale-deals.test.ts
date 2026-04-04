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

  it("delegates stale deal task generation to the rule evaluator without issuing a raw task insert", async () => {
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ ruleId: "stale_deal", action: "created" }]);

    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "beta" }] };
      }

      if (sql.includes("FROM office_beta.deals")) {
        return {
          rows: [
            {
              deal_id: "deal-1",
              deal_name: "Alpha Roof",
              deal_number: "D-1001",
              assigned_rep_id: "user-1",
              stage_entered_at: new Date("2026-03-01T12:00:00.000Z"),
              stage_name: "Proposal",
              stale_threshold_days: 15,
              stale_escalation_tiers: [],
              days_in_stage: 31,
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
});
