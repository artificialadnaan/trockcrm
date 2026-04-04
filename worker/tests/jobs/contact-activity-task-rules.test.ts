import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const evaluateTaskRulesMock = vi.fn();
const createTenantTaskRulePersistenceMock = vi.fn();
const registerJobHandlerMock = vi.fn();
const handlers = new Map<string, (payload: any, officeId: string | null) => Promise<void>>();

vi.mock("../../src/db.js", () => ({
  pool: {
    query: queryMock,
  },
}));

vi.mock("../../src/queue.js", () => ({
  registerJobHandler: registerJobHandlerMock.mockImplementation((jobType: string, handler: any) => {
    handlers.set(jobType, handler);
  }),
}));

vi.mock("../../../server/src/modules/tasks/rules/evaluator.js", () => ({
  evaluateTaskRules: evaluateTaskRulesMock,
}));

vi.mock("../../../server/src/modules/tasks/rules/config.js", () => ({
  TASK_RULES: [
    { id: "contact_onboarding_intro_email" },
    { id: "contact_onboarding_follow_up_call" },
    { id: "contact_onboarding_check_response" },
    { id: "activity_meeting_follow_up" },
  ],
}));

vi.mock("../../../server/src/modules/tasks/rules/persistence.js", () => ({
  createTenantTaskRulePersistence: createTenantTaskRulePersistenceMock,
}));

const { registerAllJobs } = await import("../../src/jobs/index.js");

describe("contact and activity task migration", () => {
  beforeEach(() => {
    queryMock.mockReset();
    evaluateTaskRulesMock.mockReset();
    createTenantTaskRulePersistenceMock.mockReset();
    registerJobHandlerMock.mockClear();
    handlers.clear();

    registerAllJobs();
  });

  it("routes contact.created through the shared evaluator without raw task inserts", async () => {
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ ruleId: "contact_onboarding_intro_email", action: "created" }]);

    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "beta" }] };
      }

      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    const handler = handlers.get("domain_event");
    expect(handler).toBeDefined();

    await handler!(
      {
        eventName: "contact.created",
        contactId: "contact-1",
        firstName: "Brett",
        lastName: "Smith",
        createdBy: "user-1",
      },
      "office-1"
    );

    expect(createTenantTaskRulePersistenceMock).toHaveBeenCalledWith(expect.any(Object), "office_beta");
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: "contact.created",
        officeId: "office-1",
        entityId: "contact:contact-1",
        contactId: "contact-1",
        contactName: "Brett Smith",
        taskAssigneeId: "user-1",
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks"))
    ).toBe(false);
  });

  it("routes activity.created meeting follow-ups through the shared evaluator without raw task inserts", async () => {
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ ruleId: "activity_meeting_follow_up", action: "created" }]);

    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "beta" }] };
      }

      if (sql.includes("FROM office_beta.contacts")) {
        return { rows: [{ first_name: "Brett", last_name: "Smith" }] };
      }

      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    const handler = handlers.get("domain_event");
    expect(handler).toBeDefined();

    await handler!(
      {
        eventName: "activity.created",
        activityId: "activity-1",
        type: "meeting",
        userId: "user-1",
        contactId: "contact-1",
        dealId: "deal-1",
      },
      "office-1"
    );

    expect(createTenantTaskRulePersistenceMock).toHaveBeenCalledWith(expect.any(Object), "office_beta");
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: "activity.created",
        officeId: "office-1",
        entityId: "activity:activity-1",
        contactId: "contact-1",
        contactName: "Brett Smith",
        taskAssigneeId: "user-1",
        dealId: "deal-1",
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks"))
    ).toBe(false);
  });
});
