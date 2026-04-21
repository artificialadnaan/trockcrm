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

const {
  autoAssociateEmailToDeal,
  associateEmailToEntity,
  buildThreadAssignmentFallbackWhereClause,
  getEmails,
  isEmailAssignmentQueueCandidate,
  sendEmail,
} = await import("../../../src/modules/email/service.js");

function hasColumnName(node: any, columnName: string, seen = new Set<unknown>()): boolean {
  if (!node || typeof node !== "object") return false;
  if (seen.has(node)) return false;
  seen.add(node);
  if (node.name === columnName) return true;
  if (Array.isArray(node)) return node.some((entry) => hasColumnName(entry, columnName, seen));
  if ("queryChunks" in node) return hasColumnName((node as any).queryChunks, columnName, seen);
  return Object.values(node).some((entry) => hasColumnName(entry, columnName, seen));
}

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

  it("only treats ambiguous inbound mail as a parking-lot queue candidate", () => {
    expect(
      isEmailAssignmentQueueCandidate({
        direction: "inbound",
        assignmentAmbiguityReason: "multiple_deal_candidates",
      })
    ).toBe(true);

    expect(
      isEmailAssignmentQueueCandidate({
        direction: "inbound",
        assignmentAmbiguityReason: null,
      })
    ).toBe(false);

    expect(
      isEmailAssignmentQueueCandidate({
        direction: "outbound",
        assignmentAmbiguityReason: "multiple_deal_candidates",
      })
    ).toBe(false);
  });

  it("scopes prior-thread fallback lookup to the mailbox user", () => {
    const whereClause = buildThreadAssignmentFallbackWhereClause("mailbox-user-1", "conversation-1");

    expect(hasColumnName(whereClause, "user_id")).toBe(true);
    expect(hasColumnName(whereClause, "graph_conversation_id")).toBe(true);
  });

  it("includes assigned-entity fallback when filtering emails by contact", async () => {
    const whereClauses: unknown[] = [];
    const tenantDb = {
      select: vi.fn(() => {
        const callIndex = (tenantDb.select as any).mock.calls.length;
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn((whereArg: unknown) => {
            whereClauses.push(whereArg);
            return chain;
          }),
          orderBy: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          offset: vi.fn(() => chain),
          then(resolve: (value: any) => void) {
            if (callIndex === 1) {
              resolve([{ count: 1 }]);
            } else {
              resolve([]);
            }
          },
        };
        return chain;
      }),
    };

    await getEmails(tenantDb as any, { contactId: "contact-1" }, "director-1", "director");

    expect(whereClauses.length).toBe(2);
    expect(hasColumnName(whereClauses[0], "contact_id") || hasColumnName(whereClauses[0], "contactId")).toBe(true);
    expect(
      hasColumnName(whereClauses[0], "assigned_entity_type") ||
        hasColumnName(whereClauses[0], "assignedEntityType")
    ).toBe(true);
    expect(
      hasColumnName(whereClauses[0], "assigned_entity_id") ||
        hasColumnName(whereClauses[0], "assignedEntityId")
    ).toBe(true);
  });

  it("includes assigned-entity fallback when filtering emails by deal", async () => {
    const whereClauses: unknown[] = [];
    const tenantDb = {
      select: vi.fn(() => {
        const callIndex = (tenantDb.select as any).mock.calls.length;
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn((whereArg: unknown) => {
            whereClauses.push(whereArg);
            return chain;
          }),
          orderBy: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          offset: vi.fn(() => chain),
          then(resolve: (value: any) => void) {
            if (callIndex === 1) {
              resolve([{ count: 1 }]);
            } else {
              resolve([]);
            }
          },
        };
        return chain;
      }),
    };

    await getEmails(tenantDb as any, { dealId: "deal-1" }, "director-1", "director");

    expect(whereClauses.length).toBe(2);
    expect(hasColumnName(whereClauses[0], "deal_id") || hasColumnName(whereClauses[0], "dealId")).toBe(true);
    expect(
      hasColumnName(whereClauses[0], "assigned_entity_type") ||
        hasColumnName(whereClauses[0], "assignedEntityType")
    ).toBe(true);
    expect(
      hasColumnName(whereClauses[0], "assigned_entity_id") ||
        hasColumnName(whereClauses[0], "assignedEntityId")
    ).toBe(true);
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

  it("completes legacy email assignment queue tasks when an email is manually associated", async () => {
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
              resolve([{ id: "contact-1", companyId: "company-1" }]);
            } else {
              resolve([
                {
                  id: "task-legacy-1",
                  title: "Associate inbound email",
                  status: "pending",
                  assignedTo: "user-1",
                  type: "inbound_email",
                  originRule: "email_assignment_queue",
                  dedupeKey: "email:email-1:assignment_queue",
                  reasonCode: "email_assignment_queue",
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
                  id: "task-legacy-1",
                  title: "Associate inbound email",
                  status: payload.status ?? "completed",
                  assignedTo: "user-1",
                  type: "inbound_email",
                  originRule: "email_assignment_queue",
                  dedupeKey: "email:email-1:assignment_queue",
                  reasonCode: "email_assignment_queue",
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
        assignedEntityType: "contact",
        assignedEntityId: "contact-1",
      },
      "director",
      "director-1",
      "office-1"
    );

    expect(updatePayloads.some((entry) => entry.payload.status === "completed")).toBe(true);
    expect(
      insertPayloads.some(
        (entry) =>
          entry.jobType === "domain_event" &&
          entry.payload?.eventName === "task.completed" &&
          entry.payload?.originRule === "email_assignment_queue"
      )
    ).toBe(true);
  });

  it("does not fail manual assignment when a legacy inbound-email task has an unknown origin rule", async () => {
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
              resolve([{ id: "email-1", userId: "user-1", contactId: null, subject: "Subject", bodyPreview: "Body", bodyHtml: null, sentAt: new Date("2026-04-20T00:00:00.000Z") }]);
            } else if (callIndex === 2) {
              resolve([{ id: "contact-1", companyId: "company-1" }]);
            } else {
              resolve([
                {
                  id: "task-legacy-unknown-1",
                  title: "Associate inbound email",
                  status: "pending",
                  assignedTo: "user-1",
                  type: "inbound_email",
                  originRule: "legacy_missing_rule_id",
                  dedupeKey: "email:email-1:assignment_queue",
                  reasonCode: "legacy_missing_rule_id",
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
                  id: "task-legacy-unknown-1",
                  title: "Associate inbound email",
                  status: payload.status ?? "completed",
                  assignedTo: "user-1",
                  type: "inbound_email",
                  originRule: "legacy_missing_rule_id",
                  dedupeKey: "email:email-1:assignment_queue",
                  reasonCode: "legacy_missing_rule_id",
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

    await expect(
      associateEmailToEntity(
        tenantDb as any,
        "email-1",
        {
          assignedEntityType: "contact",
          assignedEntityId: "contact-1",
        },
        "director",
        "director-1",
        "office-1"
      )
    ).resolves.toBeUndefined();

    expect(updatePayloads.some((entry) => entry.payload.status === "completed")).toBe(true);
    expect(
      insertPayloads.some(
        (entry) =>
          entry.jobType === "domain_event" &&
          entry.payload?.eventName === "task.completed" &&
          entry.payload?.originRule === "legacy_missing_rule_id" &&
          entry.payload?.suppressionWindowDays === null
      )
    ).toBe(true);
  });

  it("persists contact assignments without forcing a deal id", async () => {
    const updatePayloads: Array<{ table: string; payload: any }> = [];
    const insertPayloads: Array<any> = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any) => void) {
            const callIndex = (tenantDb.select as any).mock.calls.length;
            if (callIndex === 1) {
              resolve([{ id: "email-1", userId: "user-1", contactId: null, subject: "Hello", bodyPreview: "Hi", bodyHtml: null, sentAt: new Date("2026-04-20T00:00:00.000Z") }]);
            } else if (callIndex === 2) {
              resolve([{ id: "contact-1", companyId: "company-1" }]);
            } else {
              resolve([]);
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
              returning: vi.fn(async () => []),
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
        assignedEntityType: "contact" as any,
        assignedEntityId: "contact-1",
        assignedDealId: null,
      },
      "director",
      "director-1",
      "office-1"
    );

    expect(updatePayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            assignedEntityType: "contact",
            assignedEntityId: "contact-1",
            dealId: null,
            contactId: "contact-1",
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            sourceEntityType: "contact",
            sourceEntityId: "contact-1",
            companyId: "company-1",
            dealId: null,
            contactId: "contact-1",
          }),
        }),
      ])
    );
    expect(insertPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceEntityType: "contact",
          sourceEntityId: "contact-1",
          companyId: "company-1",
          contactId: "contact-1",
          dealId: null,
        }),
      ])
    );
  });

  it("persists company assignments without forcing a deal id", async () => {
    const updatePayloads: Array<{ table: string; payload: any }> = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any) => void) {
            const callIndex = (tenantDb.select as any).mock.calls.length;
            if (callIndex === 1) {
              resolve([{ id: "email-1", userId: "user-1" }]);
            } else if (callIndex === 2) {
              resolve([{ id: "company-1" }]);
            } else {
              resolve([]);
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
              returning: vi.fn(async () => [{ id: "activity-1" }]),
            })),
          };
        }),
      })),
      insert: vi.fn(),
    };

    await associateEmailToEntity(
      tenantDb as any,
      "email-1",
      {
        assignedEntityType: "company" as any,
        assignedEntityId: "company-1",
        assignedDealId: null,
      },
      "director",
      "director-1",
      "office-1"
    );

    expect(updatePayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            assignedEntityType: "company",
            assignedEntityId: "company-1",
            dealId: null,
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            sourceEntityType: "company",
            sourceEntityId: "company-1",
            companyId: "company-1",
            dealId: null,
          }),
        }),
      ])
    );
  });

  it("persists lead assignments without coercing them into deal ownership", async () => {
    const updatePayloads: Array<{ table: string; payload: any }> = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any) => void) {
            const callIndex = (tenantDb.select as any).mock.calls.length;
            if (callIndex === 1) {
              resolve([{ id: "email-1", userId: "user-1" }]);
            } else if (callIndex === 2) {
              resolve([{ id: "lead-1", companyId: "company-1", propertyId: "property-1" }]);
            } else {
              resolve([]);
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
              returning: vi.fn(async () => [{ id: "activity-1" }]),
            })),
          };
        }),
      })),
      insert: vi.fn(),
    };

    await associateEmailToEntity(
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
    );

    expect(updatePayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            assignedEntityType: "lead",
            assignedEntityId: "lead-1",
            dealId: null,
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            sourceEntityType: "lead",
            sourceEntityId: "lead-1",
            companyId: "company-1",
            propertyId: "property-1",
            leadId: "lead-1",
            dealId: null,
          }),
        }),
      ])
    );
  });

  it("persists property assignments onto property-scoped activity without a deal id", async () => {
    const updatePayloads: Array<{ table: string; payload: any }> = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any) => void) {
            const callIndex = (tenantDb.select as any).mock.calls.length;
            if (callIndex === 1) {
              resolve([{ id: "email-1", userId: "user-1" }]);
            } else if (callIndex === 2) {
              resolve([{ id: "property-1", companyId: "company-1" }]);
            } else {
              resolve([]);
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
              returning: vi.fn(async () => [{ id: "activity-1" }]),
            })),
          };
        }),
      })),
      insert: vi.fn(),
    };

    await associateEmailToEntity(
      tenantDb as any,
      "email-1",
      {
        assignedEntityType: "property" as any,
        assignedEntityId: "property-1",
        assignedDealId: null,
      },
      "director",
      "director-1",
      "office-1"
    );

    expect(updatePayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            assignedEntityType: "property",
            assignedEntityId: "property-1",
            dealId: null,
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            sourceEntityType: "property",
            sourceEntityId: "property-1",
            companyId: "company-1",
            propertyId: "property-1",
            leadId: null,
            dealId: null,
          }),
        }),
      ])
    );
  });

  it("creates a history activity when inbound email resolution has no existing activity row", async () => {
    const insertPayloads: Array<any> = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any) => void) {
            const callIndex = (tenantDb.select as any).mock.calls.length;
            if (callIndex === 1) {
              resolve([
                {
                  id: "email-1",
                  userId: "user-1",
                  contactId: "contact-1",
                  subject: "Need help",
                  bodyPreview: "Inbound preview",
                  bodyHtml: "<p>Inbound preview</p>",
                  sentAt: new Date("2026-04-20T12:00:00.000Z"),
                },
              ]);
            } else if (callIndex === 2) {
              resolve([{ id: "company-1" }]);
            } else {
              resolve([]);
            }
          },
        };
        return chain;
      }),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
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
        assignedEntityType: "company" as any,
        assignedEntityId: "company-1",
        assignedDealId: null,
      },
      "director",
      "director-1",
      "office-1"
    );

    expect(insertPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "email",
          sourceEntityType: "company",
          sourceEntityId: "company-1",
          companyId: "company-1",
          dealId: null,
          contactId: "contact-1",
          emailId: "email-1",
          subject: "Need help",
          body: "Inbound preview",
          occurredAt: new Date("2026-04-20T12:00:00.000Z"),
        }),
      ])
    );
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
