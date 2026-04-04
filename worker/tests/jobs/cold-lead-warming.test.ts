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
  TASK_RULES: [{ id: "cold_lead_warming" }],
}));

vi.mock("../../../server/src/modules/tasks/rules/persistence.js", () => ({
  createTenantTaskRulePersistence: createTenantTaskRulePersistenceMock,
}));

const { runColdLeadWarming } = await import("../../src/jobs/cold-lead-warming.js");

describe("cold lead warming worker", () => {
  beforeEach(() => {
    queryMock.mockReset();
    evaluateTaskRulesMock.mockReset();
    createTenantTaskRulePersistenceMock.mockReset();
  });

  it("delegates cold lead tasks to the rule evaluator without issuing raw task inserts", async () => {
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ ruleId: "cold_lead_warming", action: "created" }]);

    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "beta", settings: { contactNoTouchDays: 60 } }] };
      }

      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rows: [] };
      }

      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }

      if (sql.includes("FROM office_beta.contacts c")) {
        return {
          rows: [
            {
              contact_id: "contact-1",
              first_name: "Casey",
              last_name: "Customer",
              deal_id: "deal-1",
              assigned_rep_id: "user-1",
            },
          ],
        };
      }

      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    await runColdLeadWarming();

    expect(createTenantTaskRulePersistenceMock).toHaveBeenCalledWith(expect.any(Object), "office_beta");
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: "cron.cold_lead_warming",
        officeId: "office-1",
        entityId: "contact:contact-1",
        dealId: "deal-1",
        contactId: "contact-1",
        dealOwnerId: "user-1",
        contactName: "Casey Customer",
        noTouchDays: 60,
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks"))
    ).toBe(false);
  });
});
