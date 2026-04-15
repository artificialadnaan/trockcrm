import { beforeEach, describe, expect, it, vi } from "vitest";

const evaluateTaskRulesMock = vi.fn();
const createTenantTaskRulePersistenceMock = vi.fn();

vi.mock("../../src/db.js", () => ({
  pool: {
    connect: async () => ({
      query: vi.fn(),
      release: vi.fn(),
    }),
  },
}));

vi.mock("../../../server/src/modules/tasks/rules/evaluator.js", () => ({
  evaluateTaskRules: evaluateTaskRulesMock,
}));

vi.mock("../../../server/src/modules/tasks/rules/config.js", () => ({
  TASK_RULES: [
    { id: "inbound_email_reply_needed" },
    { id: "inbound_email_deal_disambiguation" },
  ],
}));

vi.mock("../../../server/src/modules/tasks/rules/persistence.js", () => ({
  createTenantTaskRulePersistence: createTenantTaskRulePersistenceMock,
}));

const emailSyncModule = await import("../../src/jobs/email-sync.js");
const processInboundMessage = (emailSyncModule as any).processInboundMessage as (
  client: any,
  schemaName: string,
  userId: string,
  officeId: string,
  msg: any
) => Promise<boolean>;

function createQueryMock(options: {
  activeDeals: Array<{ deal_id: string; deal_number: string; deal_name: string }>;
}) {
  return vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM office_beta.emails") && sql.includes("graph_message_id = $1")) {
      return { rows: [] };
    }

    if (sql.includes("FROM office_beta.contacts")) {
      return {
        rows: [{ id: "contact-1", first_name: "Brett", last_name: "Smith" }],
      };
    }

    if (sql.startsWith("INSERT INTO office_beta.emails")) {
      return { rows: [{ id: "email-1" }] };
    }

    if (sql.includes("FROM office_beta.deals d")) {
      return { rows: options.activeDeals };
    }

    if (sql.startsWith("UPDATE office_beta.emails")) {
      return { rows: [] };
    }

    if (sql.startsWith("INSERT INTO office_beta.activities")) {
      return { rows: [] };
    }

    if (sql.startsWith("INSERT INTO public.job_queue")) {
      return { rows: [] };
    }

    throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
  });
}

describe("email sync inbound message routing", () => {
  beforeEach(() => {
    evaluateTaskRulesMock.mockReset();
    createTenantTaskRulePersistenceMock.mockReset();
  });

  it("routes a single-active-deal email to the reply-needed task rule", async () => {
    const queryMock = createQueryMock({
      activeDeals: [
        { deal_id: "deal-1", deal_number: "D-1001", deal_name: "Project Alpha" },
      ],
    });
    const client = { query: queryMock };
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ ruleId: "inbound_email_reply_needed", action: "created" }]);

    const processed = await processInboundMessage(
      client,
      "office_beta",
      "user-1",
      "office-1",
      {
        id: "graph-1",
        from: { emailAddress: { address: "brett@example.com" } },
        toRecipients: [],
        ccRecipients: [],
        subject: "Project Alpha follow-up",
        bodyPreview: "Please reply",
        body: { content: "<p>Please reply</p>" },
        hasAttachments: false,
        receivedDateTime: "2026-04-04T15:00:00.000Z",
        conversationId: "conv-1",
      }
    );

    expect(processed).toBe(true);
    expect(createTenantTaskRulePersistenceMock).toHaveBeenCalledWith(client, "office_beta");
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        officeId: "office-1",
        entityId: "email:email-1",
        sourceEvent: "email.received",
        dealId: "deal-1",
        contactId: "contact-1",
        emailId: "email-1",
        taskAssigneeId: "user-1",
        contactName: "Brett Smith",
        emailSubject: "Project Alpha follow-up",
        activeDealCount: 1,
        activeDealNames: ["D-1001 Project Alpha"],
      }),
      taskPersistence,
      expect.any(Array)
    );
    const activityCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.activities")
    );
    expect(activityCall).toBeDefined();
    expect(activityCall?.[0]).toContain("responsible_user_id");
    expect(activityCall?.[0]).toContain("performed_by_user_id");
    expect(activityCall?.[0]).toContain("source_entity_type");
    expect(activityCall?.[0]).toContain("source_entity_id");
    expect(activityCall?.[1]).toEqual([
      "user-1",
      "deal",
      "deal-1",
      "deal-1",
      "contact-1",
      "email-1",
      "Project Alpha follow-up",
      "Please reply",
      new Date("2026-04-04T15:00:00.000Z"),
    ]);
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks"))).toBe(false);
  });

  it("routes a multi-active-deal email to the disambiguation task rule", async () => {
    const queryMock = createQueryMock({
      activeDeals: [
        { deal_id: "deal-1", deal_number: "D-1001", deal_name: "Project Alpha" },
        { deal_id: "deal-2", deal_number: "D-1002", deal_name: "Project Beta" },
      ],
    });
    const client = { query: queryMock };
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ ruleId: "inbound_email_deal_disambiguation", action: "created" }]);

    const processed = await processInboundMessage(
      client,
      "office_beta",
      "user-1",
      "office-1",
      {
        id: "graph-2",
        from: { emailAddress: { address: "brett@example.com" } },
        toRecipients: [],
        ccRecipients: [],
        subject: "Need deal help",
        bodyPreview: "Please route this",
        body: { content: "<p>Please route this</p>" },
        hasAttachments: false,
        receivedDateTime: "2026-04-04T15:00:00.000Z",
        conversationId: "conv-2",
      }
    );

    expect(processed).toBe(true);
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        officeId: "office-1",
        entityId: "email:email-1",
        sourceEvent: "email.received",
        dealId: null,
        contactId: "contact-1",
        emailId: "email-1",
        taskAssigneeId: "user-1",
        contactName: "Brett Smith",
        emailSubject: "Need deal help",
        activeDealCount: 2,
        activeDealNames: ["D-1001 Project Alpha", "D-1002 Project Beta"],
      }),
      taskPersistence,
      expect.any(Array)
    );
    const activityCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.activities")
    );
    expect(activityCall).toBeDefined();
    expect(activityCall?.[1]).toEqual([
      "user-1",
      "contact",
      "contact-1",
      null,
      "contact-1",
      "email-1",
      "Need deal help",
      "Please route this",
      new Date("2026-04-04T15:00:00.000Z"),
    ]);
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks"))).toBe(false);
  });
});
