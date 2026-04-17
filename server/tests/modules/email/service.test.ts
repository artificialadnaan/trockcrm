import { describe, expect, it, vi, beforeEach } from "vitest";
const evaluateTaskRulesMock = vi.fn();
const createTenantTaskRulePersistenceMock = vi.fn();
const graphRequestMock = vi.fn();
const getValidAccessTokenMock = vi.fn();
const isGraphAuthConfiguredMock = vi.fn();

vi.mock("../../../src/modules/tasks/rules/evaluator.js", () => ({
  evaluateTaskRules: evaluateTaskRulesMock,
}));

vi.mock("../../../src/modules/tasks/rules/persistence.js", () => ({
  createTenantTaskRulePersistence: createTenantTaskRulePersistenceMock,
}));

vi.mock("../../../src/lib/graph-client.js", () => ({
  graphRequest: graphRequestMock,
}));

vi.mock("../../../src/modules/email/graph-auth.js", () => ({
  getValidAccessToken: getValidAccessTokenMock,
  isGraphAuthConfigured: isGraphAuthConfiguredMock,
}));

const { autoAssociateEmailToDeal, associateEmailToEntity, sendEmail } = await import("../../../src/modules/email/service.js");

function createSelectChain(result: any[]) {
  const chain: any = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    then(resolve: (value: any) => void) {
      resolve(result);
    },
  };

  return chain;
}

function createTenantDbMock(options: {
  activeDeals: Array<{ dealId: string; dealName: string; dealNumber: string }>;
  emailRow: { subject: string };
  contactRow: { firstName: string; lastName: string };
}) {
  let selectCalls = 0;
  const select = vi.fn(() => {
    selectCalls += 1;
    if (selectCalls === 1) return createSelectChain(options.activeDeals);
    if (selectCalls === 2) return createSelectChain([options.emailRow]);
    if (selectCalls === 3) return createSelectChain([options.contactRow]);
    return createSelectChain([]);
  });
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
  }));

  return {
    select,
    update,
    insert: vi.fn(),
  };
}

describe("email service inbound association", () => {
  beforeEach(() => {
    evaluateTaskRulesMock.mockReset();
    createTenantTaskRulePersistenceMock.mockReset();
    graphRequestMock.mockReset();
    getValidAccessTokenMock.mockReset();
    isGraphAuthConfiguredMock.mockReset();

    isGraphAuthConfiguredMock.mockReturnValue(true);
    getValidAccessTokenMock.mockResolvedValue("graph-access-token");
  });

  it("routes the multi-deal disambiguation task through the task evaluator", async () => {
    const tenantDb = createTenantDbMock({
      activeDeals: [
        { dealId: "deal-1", dealName: "Project Alpha", dealNumber: "D-1001" },
        { dealId: "deal-2", dealName: "Project Beta", dealNumber: "D-1002" },
      ],
      emailRow: { subject: "Project Alpha follow-up" },
      contactRow: { firstName: "Brett", lastName: "Smith" },
    });
    const tenantClient = { query: vi.fn(async () => ({ rows: [] })) };
    const taskPersistence = { marker: "task-persistence" };

    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([{ ruleId: "inbound_email_disambiguation", action: "created" }]);

    const result = await autoAssociateEmailToDeal(
      tenantDb as any,
      tenantClient as any,
      "office-1",
      "beta",
      "email-1",
      "contact-1",
      "user-1"
    );

    expect(result).toBeNull();
    expect(createTenantTaskRulePersistenceMock).toHaveBeenCalledWith(tenantClient, "office_beta");
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        officeId: "office-1",
        entityId: "email:email-1",
        sourceEvent: "email.received",
        emailId: "email-1",
        contactId: "contact-1",
        taskAssigneeId: "user-1",
        contactName: "Brett Smith",
        emailSubject: "Project Alpha follow-up",
        activeDealCount: 2,
        activeDealNames: ["D-1001 Project Alpha", "D-1002 Project Beta"],
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(tenantDb.insert).not.toHaveBeenCalled();
  });

  it("completes inbound email tasks when an email is manually associated to a deal", async () => {
    const updatePayloads: Array<{ table: string; payload: any }> = [];
    const insertPayloads: Array<any> = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain: any = {
          from: vi.fn(() => chain),
          innerJoin: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any) => void) {
            const callIndex = (tenantDb.select as any).mock.calls.length;
            if (callIndex === 1) {
              resolve([{ id: "email-1", userId: "user-1" }]);
            } else if (callIndex === 2) {
              resolve([{ id: "deal-1" }]);
            } else {
              resolve([
                {
                  id: "task-1",
                  title: "Reply to contact: email",
                  status: "pending",
                  assignedTo: "user-1",
                  type: "inbound_email",
                  originRule: "inbound_email_reply_needed",
                  dedupeKey: "email:email-1:reply_needed",
                  reasonCode: "reply_needed",
                  dealId: null,
                  contactId: "contact-1",
                  entitySnapshot: { emailId: "email-1" },
                },
              ]);
            }
          },
        };
        return chain;
      }),
      update: vi.fn((table: any) => ({
        set: vi.fn((payload: any) => {
          updatePayloads.push({ table: table?.name ?? "unknown", payload });
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [
                {
                  id: "task-1",
                  title: "Reply to contact: email",
                  status: payload.status ?? "completed",
                  assignedTo: "user-1",
                  type: "inbound_email",
                  originRule: "inbound_email_reply_needed",
                  dedupeKey: "email:email-1:reply_needed",
                  reasonCode: "reply_needed",
                  dealId: payload.dealId ?? null,
                  contactId: "contact-1",
                  entitySnapshot: { emailId: "email-1" },
                },
              ]),
            })),
          };
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (payload: any) => {
          insertPayloads.push(payload);
          return [];
        }),
      })),
    };

    await associateEmailToEntity(
      tenantDb as any,
      "email-1",
      {
        assignedEntityType: "deal",
        assignedEntityId: "deal-1",
        assignedDealId: "deal-1",
      },
      "director",
      "director-1",
      "office-1"
    );

    expect(updatePayloads.some((entry) => entry.payload.status === "completed")).toBe(true);
    expect(updatePayloads.some((entry) => entry.payload.completedAt)).toBe(true);
    expect(insertPayloads.some((entry) => entry.jobType === "domain_event" && entry.payload?.eventName === "task.completed")).toBe(true);
  });

  it("rejects non-deal association targets", async () => {
    const tenantDb = {
      select: vi.fn(() => createSelectChain([{ id: "email-1", userId: "user-1" }])),
      update: vi.fn(),
      insert: vi.fn(),
    };

    await expect(
      associateEmailToEntity(
        tenantDb as any,
        "email-1",
        {
          assignedEntityType: "lead" as any,
          assignedEntityId: "lead-1",
          assignedDealId: null,
        },
        "director",
        "director-1",
        "office-1"
      )
    ).rejects.toThrow("Only deal assignments are supported by this endpoint");
  });

  it("rejects mismatched deal identifiers", async () => {
    const tenantDb = {
      select: vi.fn(() => createSelectChain([{ id: "email-1", userId: "user-1" }])),
      update: vi.fn(),
      insert: vi.fn(),
    };

    await expect(
      associateEmailToEntity(
        tenantDb as any,
        "email-1",
        {
          assignedEntityType: "deal",
          assignedEntityId: "deal-1",
          assignedDealId: "deal-2",
        },
        "director",
        "director-1",
        "office-1"
      )
    ).rejects.toThrow("assignedDealId must match assignedEntityId for deal assignments");
  });

  it("rejects outbound email without an association before sending through Microsoft", async () => {
    const tenantDb = {
      insert: vi.fn(),
      select: vi.fn(),
      update: vi.fn(),
    };

    await expect(
      sendEmail(tenantDb as any, "user-1", {
        to: ["client@example.com"],
        subject: "Follow up",
        bodyHtml: "<p>Hello</p>",
      })
    ).rejects.toThrow("Outbound email must be associated to a deal, company, or contact.");

    expect(graphRequestMock).not.toHaveBeenCalled();
    expect(tenantDb.insert).not.toHaveBeenCalled();
  });
});
