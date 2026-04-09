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
    { id: "deal_won_schedule_kickoff" },
    { id: "deal_won_cross_sell_opportunity" },
    { id: "deal_lost_competitor_intel" },
    { id: "scoping_estimating_review_handoff" },
    { id: "scoping_service_review_handoff" },
  ],
}));

vi.mock("../../../server/src/modules/tasks/rules/persistence.js", () => ({
  createTenantTaskRulePersistence: createTenantTaskRulePersistenceMock,
}));

const { registerAllJobs } = await import("../../src/jobs/index.js");

describe("deal lifecycle task migration", () => {
  beforeEach(() => {
    queryMock.mockReset();
    evaluateTaskRulesMock.mockReset();
    createTenantTaskRulePersistenceMock.mockReset();
    registerJobHandlerMock.mockClear();
    handlers.clear();

    registerAllJobs();
  });

  it("routes deal.won handoff and cross-sell generation through the shared evaluator", async () => {
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ action: "created" }]);

    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql === "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true") {
        return { rows: [{ slug: "beta" }] };
      }

      if (sql.includes("FROM office_beta.contacts WHERE id = $1")) {
        return { rows: [{ first_name: "Brett", last_name: "Smith" }] };
      }

      if (sql.includes("FROM office_beta.deals d") && sql.includes("company_name")) {
        return { rows: [{ project_type_id: "pt-1", company_name: "Acme Roofing" }] };
      }

      if (sql.includes("FROM public.project_type_config")) {
        return { rows: [{ id: "pt-2", name: "Gutters", parent_id: null }] };
      }

      if (sql.includes("SELECT DISTINCT d.project_type_id")) {
        return { rows: [{ project_type_id: "pt-1" }] };
      }

      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    const handler = handlers.get("domain_event");
    expect(handler).toBeDefined();

    await handler!(
      {
        eventName: "deal.won",
        dealId: "deal-1",
        dealName: "Alpha Roof",
        dealNumber: "D-1001",
        assignedRepId: "user-1",
        primaryContactId: "contact-1",
      },
      "office-1"
    );

    expect(createTenantTaskRulePersistenceMock).toHaveBeenCalledWith(expect.any(Object), "office_beta");
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: "deal.won.handoff",
        officeId: "office-1",
        entityId: "deal:deal-1",
        dealId: "deal-1",
        dealName: "Alpha Roof",
        dealNumber: "D-1001",
        dealOwnerId: "user-1",
        taskAssigneeId: "user-1",
        primaryContactName: "Brett Smith",
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: "deal.won.cross_sell",
        officeId: "office-1",
        entityId: "deal:deal-1",
        dealId: "deal-1",
        dealName: "Alpha Roof",
        dealNumber: "D-1001",
        dealOwnerId: "user-1",
        taskAssigneeId: "user-1",
        companyName: "Acme Roofing",
        projectTypeId: "pt-2",
        projectTypeName: "Gutters",
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks"))
    ).toBe(false);
  });

  it("routes deal.lost competitor-intelligence generation through the shared evaluator", async () => {
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ action: "created" }]);

    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql === "SELECT slug, settings FROM public.offices WHERE id = $1 AND is_active = true") {
        return { rows: [{ slug: "beta", settings: { largeLossThreshold: 100000 } }] };
      }

      if (sql === "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true") {
        return { rows: [{ slug: "beta" }] };
      }

      if (sql.includes("COALESCE(awarded_amount, bid_estimate, 0)::numeric")) {
        return { rows: [{ deal_value: 50000, lost_notes: null }] };
      }

      if (sql.includes("FROM office_beta.contact_deal_associations cda") && sql.includes("WHERE cda.deal_id = $1")) {
        return {
          rows: [{ contact_id: "contact-1", company_name: "Acme Roofing", first_name: "Brett", last_name: "Smith" }],
        };
      }

      if (sql.includes("WHERE cda.contact_id IN ($2)")) {
        return {
          rows: [{ id: "deal-2", name: "Beta Roof", assigned_rep_id: "user-2", first_name: "Brett", last_name: "Smith" }],
        };
      }

      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    const handler = handlers.get("domain_event");
    expect(handler).toBeDefined();

    await handler!(
      {
        eventName: "deal.lost",
        dealId: "deal-1",
        dealName: "Lost Bid",
        dealNumber: "D-1001",
        assignedRepId: "user-1",
        lostCompetitor: "Acme Exteriors",
      },
      "office-1"
    );

    expect(createTenantTaskRulePersistenceMock).toHaveBeenCalledWith(expect.any(Object), "office_beta");
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: "deal.lost.competitor_intel",
        officeId: "office-1",
        entityId: "deal:deal-2",
        dealId: "deal-2",
        dealName: "Beta Roof",
        dealOwnerId: "user-2",
        taskAssigneeId: "user-2",
        triggerDealId: "deal-1",
        triggerDealName: "Lost Bid",
        triggerDealNumber: "D-1001",
        contactName: "Brett Smith",
        lostCompetitor: "Acme Exteriors",
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks"))
    ).toBe(false);
  });

  it("routes scoping_intake.activated through the shared evaluator using the canonical workflow route", async () => {
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ action: "created" }]);

    queryMock.mockImplementation(async (sql: string) => {
      if (sql === "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true") {
        return { rows: [{ slug: "beta" }] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const handler = handlers.get("domain_event");
    expect(handler).toBeDefined();

    await handler!(
      {
        eventName: "scoping_intake.activated",
        dealId: "deal-1",
        dealName: "Alpha Roof",
        dealNumber: "D-1001",
        workflowRoute: "service",
        activatedBy: "user-1",
      },
      "office-1"
    );

    expect(createTenantTaskRulePersistenceMock).toHaveBeenCalledWith(expect.any(Object), "office_beta");
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvent: "scoping_intake.activated.service",
        officeId: "office-1",
        entityId: "deal:deal-1",
        dealId: "deal-1",
        dealName: "Alpha Roof",
        dealNumber: "D-1001",
        taskAssigneeId: "user-1",
      }),
      taskPersistence,
      expect.any(Array)
    );
  });
});
