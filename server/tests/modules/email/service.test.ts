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
  associateEmailToDeal,
  assertCanMutateEmailThread,
  buildThreadAssignmentFallbackWhereClause,
  getEmailAssignmentQueue,
  getEmails,
  getEmailThread,
  getEmailThreadForMutation,
  getUserEmails,
  ignoreEmailAssignment,
  isEmailAssignmentQueueCandidate,
  sendEmail,
  unignoreEmailAssignment,
  updateEmailInboxAction,
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

function sqlConditionReferencesColumn(node: any, columnName: string, seen = new Set<unknown>()): boolean {
  if (!node || typeof node !== "object") return false;
  if (seen.has(node)) return false;
  seen.add(node);

  if (node.name === columnName && node.table) return true;
  if (Array.isArray(node)) return node.some((entry) => sqlConditionReferencesColumn(entry, columnName, seen));
  if ("queryChunks" in node) return sqlConditionReferencesColumn((node as any).queryChunks, columnName, seen);
  if ("value" in node && Array.isArray((node as any).value)) {
    return sqlConditionReferencesColumn((node as any).value, columnName, seen);
  }
  if ("left" in node || "right" in node) {
    return (
      sqlConditionReferencesColumn((node as any).left, columnName, seen) ||
      sqlConditionReferencesColumn((node as any).right, columnName, seen)
    );
  }

  return false;
}

function collectSqlText(node: any, seen = new Set<unknown>()): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";
  if (seen.has(node)) return "";
  seen.add(node);

  if (Array.isArray(node)) {
    return node.map((entry) => collectSqlText(entry, seen)).join(" ");
  }

  if ("queryChunks" in node) {
    return collectSqlText((node as any).queryChunks, seen);
  }

  if ("value" in node && Array.isArray((node as any).value)) {
    return collectSqlText((node as any).value, seen);
  }

  return Object.values(node)
    .map((entry) => collectSqlText(entry, seen))
    .join(" ");
}

function stringifyQueryNode(node: unknown, seen = new WeakSet<object>()): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return String(node);
  }
  if (typeof node !== "object") return "";
  if (seen.has(node as object)) return "";
  seen.add(node as object);

  if (Array.isArray(node)) {
    return node.map((entry) => stringifyQueryNode(entry, seen)).join(" ");
  }
  if ("queryChunks" in (node as Record<string, unknown>)) {
    return stringifyQueryNode((node as { queryChunks?: unknown[] }).queryChunks ?? [], seen);
  }
  if ("value" in (node as Record<string, unknown>)) {
    return stringifyQueryNode((node as { value?: unknown }).value, seen);
  }

  return Object.values(node as Record<string, unknown>)
    .map((entry) => stringifyQueryNode(entry, seen))
    .join(" ");
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

function createEmailThreadDb(options: {
  thread: any[];
  binding?: any | null;
  mailboxAccountId?: string;
  dealRows?: Record<string, { id: string; name: string }>;
  currentUserId?: string;
}) {
  let selectCalls = 0;
  return {
    select: vi.fn((selection?: Record<string, unknown>) => {
      selectCalls += 1;
      let rows: any[] = [];

      if (selectCalls === 1 || selectCalls === 2) {
        rows = options.currentUserId
          ? options.thread.filter((row) => row.userId === options.currentUserId)
          : options.thread;
      } else if (selectCalls === 3) {
        rows = [{ id: options.mailboxAccountId ?? "mailbox-1" }];
      } else if (selectCalls === 4) {
        rows = options.binding ? [options.binding] : [];
      } else if (selection && "id" in selection && "name" in selection && options.binding?.dealId) {
        rows = options.dealRows?.[options.binding.dealId]
          ? [options.dealRows[options.binding.dealId]]
          : [];
      }

      const chain: any = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then(resolve: (value: any[]) => void) {
          resolve(rows);
        },
      };

      return chain;
    }),
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
        assignmentStatus: "unassigned",
      })
    ).toBe(true);

    expect(
      isEmailAssignmentQueueCandidate({
        direction: "inbound",
        assignmentAmbiguityReason: null,
        assignmentStatus: "unassigned",
      })
    ).toBe(false);

    // Outbound (Outlook-sent) mail captured by the Sent-folder sync IS an assignment-queue candidate
    // when it's unassigned-but-ambiguous — that's how a rep's sent email becomes assignable to a deal.
    expect(
      isEmailAssignmentQueueCandidate({
        direction: "outbound",
        assignmentAmbiguityReason: "multiple_deal_candidates",
        assignmentStatus: "unassigned",
      })
    ).toBe(true);

    expect(
      isEmailAssignmentQueueCandidate({
        direction: "inbound",
        assignmentAmbiguityReason: "multiple_deal_candidates",
        assignmentStatus: "ignored",
      })
    ).toBe(false);
  });

  it("scopes prior-thread fallback lookup to the mailbox user", () => {
    const whereClause = buildThreadAssignmentFallbackWhereClause("mailbox-user-1", "conversation-1");

    expect(hasColumnName(whereClause, "user_id")).toBe(true);
    expect(hasColumnName(whereClause, "graph_conversation_id")).toBe(true);
  });

  it("includes assigned-entity fallback when filtering emails by contact without mailbox-owner scoping", async () => {
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

    await getEmails(tenantDb as any, { contactId: "contact-1" }, undefined, "director");

    expect(whereClauses.length).toBe(2);
    expect(stringifyQueryNode(whereClauses[0])).not.toContain("user_id =");
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

  it("includes assigned-entity fallback when filtering emails by deal without mailbox-owner scoping", async () => {
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

    await getEmails(tenantDb as any, { dealId: "deal-1" }, undefined, "director");

    expect(whereClauses.length).toBe(2);
    expect(stringifyQueryNode(whereClauses[0])).not.toContain("user_id =");
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

  it("includes lead assignments when filtering emails by lead without mailbox-owner scoping", async () => {
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

    await getEmails(tenantDb as any, { leadId: "lead-1" }, undefined, "director");

    expect(whereClauses.length).toBe(2);
    expect(stringifyQueryNode(whereClauses[0])).not.toContain("user_id =");
    expect(
      hasColumnName(whereClauses[0], "assigned_entity_type") ||
        hasColumnName(whereClauses[0], "assignedEntityType")
    ).toBe(true);
    expect(
      hasColumnName(whereClauses[0], "assigned_entity_id") ||
        hasColumnName(whereClauses[0], "assignedEntityId")
    ).toBe(true);
  });

  it("includes company-linked assignment and relationship paths when filtering emails by company without mailbox-owner scoping", async () => {
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

    await getEmails(tenantDb as any, { companyId: "company-1" } as any, undefined, "director");

    expect(whereClauses.length).toBe(2);
    expect(stringifyQueryNode(whereClauses[0])).not.toContain("user_id =");
    expect(
      hasColumnName(whereClauses[0], "assigned_entity_type") ||
        hasColumnName(whereClauses[0], "assignedEntityType")
    ).toBe(true);
    expect(
      hasColumnName(whereClauses[0], "assigned_entity_id") ||
        hasColumnName(whereClauses[0], "assignedEntityId")
    ).toBe(true);
    expect(hasColumnName(whereClauses[0], "deal_id") || hasColumnName(whereClauses[0], "dealId")).toBe(true);
    expect(hasColumnName(whereClauses[0], "contact_id") || hasColumnName(whereClauses[0], "contactId")).toBe(true);
  });

  it("hides archived, deleted, and ignored emails from shared entity email history", async () => {
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

    await getEmails(tenantDb as any, { dealId: "deal-1" }, undefined, "director");

    expect(whereClauses.length).toBe(2);
    expect(sqlConditionReferencesColumn(whereClauses[0], "archived_at")).toBe(true);
    expect(sqlConditionReferencesColumn(whereClauses[0], "deleted_at")).toBe(true);
    expect(stringifyQueryNode(whereClauses[0])).toContain("ignored");
  });

  it("returns only the rep-visible subset of a mixed thread", async () => {
    const tenantDb = createEmailThreadDb({
      thread: [
        {
          id: "email-own",
          userId: "rep-1",
          dealId: null,
          assignedEntityType: null,
          assignedEntityId: null,
          contactId: null,
          sentAt: new Date("2026-05-15T10:00:00Z"),
        },
        {
          id: "email-hidden",
          userId: "teammate-1",
          dealId: "deal-hidden",
          assignedEntityType: "deal",
          assignedEntityId: "deal-hidden",
          contactId: null,
          sentAt: new Date("2026-05-15T11:00:00Z"),
        },
      ],
      currentUserId: "rep-1",
    });

    const result = await getEmailThread(
      tenantDb as any,
      "conversation-1",
      "rep-1",
      "rep",
      async () => false
    );

    expect(result.emails.map((email) => email.id)).toEqual(["email-own"]);
    expect(result.binding).toBeNull();
  });

  it("returns only the current user's messages even when the deal is visible", async () => {
    const tenantDb = createEmailThreadDb({
      thread: [
        {
          id: "email-1",
          userId: "teammate-1",
          dealId: "deal-visible",
          assignedEntityType: "deal",
          assignedEntityId: "deal-visible",
          contactId: null,
          sentAt: new Date("2026-05-15T10:00:00Z"),
        },
        {
          id: "email-2",
          userId: "rep-1",
          dealId: "deal-visible",
          assignedEntityType: "deal",
          assignedEntityId: "deal-visible",
          contactId: null,
          sentAt: new Date("2026-05-15T11:00:00Z"),
        },
      ],
      binding: {
        id: "binding-1",
        mailboxAccountId: "mailbox-1",
        provider: "microsoft_graph",
        providerConversationId: "conversation-1",
        dealId: "deal-visible",
        projectId: null,
        confidence: "high",
        assignmentReason: "manual_thread_assignment",
      },
      dealRows: {
        "deal-visible": { id: "deal-visible", name: "Visible Deal" },
      },
      currentUserId: "rep-1",
    });

    const result = await getEmailThread(
      tenantDb as any,
      "conversation-1",
      "rep-1",
      "rep",
      async (dealId) => dealId === "deal-visible"
    );

    expect(result.emails.map((email) => email.id)).toEqual(["email-2"]);
    expect(result.binding?.dealId).toBe("deal-visible");
  });

  it("builds binding metadata from the visible subset rather than the raw thread", async () => {
    const tenantDb = createEmailThreadDb({
      thread: [
        {
          id: "email-hidden",
          userId: "teammate-1",
          dealId: null,
          assignedEntityType: null,
          assignedEntityId: null,
          contactId: "contact-hidden",
          sentAt: new Date("2026-05-15T10:00:00Z"),
        },
        {
          id: "email-own",
          userId: "rep-1",
          dealId: null,
          assignedEntityType: null,
          assignedEntityId: null,
          contactId: "contact-visible",
          sentAt: new Date("2026-05-15T11:00:00Z"),
        },
      ],
      binding: {
        id: "binding-1",
        mailboxAccountId: "mailbox-1",
        provider: "microsoft_graph",
        providerConversationId: "conversation-1",
        dealId: null,
        projectId: null,
        confidence: "high",
        assignmentReason: "manual_thread_assignment",
      },
      currentUserId: "rep-1",
    });

    const result = await getEmailThread(
      tenantDb as any,
      "conversation-1",
      "rep-1",
      "rep",
      async () => false
    );

    expect(result.emails.map((email) => email.id)).toEqual(["email-own"]);
    expect(result.binding?.contactId).toBe("contact-visible");
  });

  it("returns 403 when the thread belongs to another user's mailbox", async () => {
    const tenantDb = {
      select: vi.fn(() => {
        const callIndex = (tenantDb.select as any).mock.calls.length;
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          orderBy: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any[]) => void) {
            if (callIndex === 1) {
              resolve([]);
            } else {
              resolve([{ id: "email-hidden", userId: "teammate-1" }]);
            }
          },
        };
        return chain;
      }),
    };

    await expect(
      getEmailThread(tenantDb as any, "conversation-1", "rep-1", "rep", async () => false)
    ).rejects.toThrow("You do not have permission to view this email thread");
  });

  it("returns 403 when a user tries to mutate another user's thread", async () => {
    const tenantDb = {
      select: vi.fn(() => {
        const callIndex = (tenantDb.select as any).mock.calls.length;
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          orderBy: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any[]) => void) {
            if (callIndex === 1) {
              resolve([]);
            } else {
              resolve([{ id: "email-hidden", userId: "teammate-1" }]);
            }
          },
        };
        return chain;
      }),
    };

    await expect(
      getEmailThreadForMutation(tenantDb as any, "conversation-1", "rep-1")
    ).rejects.toThrow("You can only view and modify your own email threads");
  });

  it("uses recency ordering based on sentAt or syncedAt for user inbox", async () => {
    const orderByClauses: unknown[] = [];
    const tenantDb = {
      select: vi.fn(() => {
        const callIndex = (tenantDb.select as any).mock.calls.length;
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          orderBy: vi.fn((...args: unknown[]) => {
            orderByClauses.push(...args);
            return chain;
          }),
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

    await getUserEmails(tenantDb as any, "user-1", { page: 1, limit: 25 });

    expect(orderByClauses.length).toBeGreaterThan(0);
    expect(
      orderByClauses.some(
        (clause) =>
          (hasColumnName(clause, "synced_at") || hasColumnName(clause, "syncedAt")) &&
          (hasColumnName(clause, "sent_at") || hasColumnName(clause, "sentAt"))
      )
    ).toBe(true);
  });

  it("scopes the assignment queue to the current user for directors too", async () => {
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
              resolve([{ count: 0 }]);
            } else {
              resolve([]);
            }
          },
        };
        return chain;
      }),
    };

    await getEmailAssignmentQueue(tenantDb as any, {}, "director-1", "director");

    expect(whereClauses.length).toBe(2);
    expect(hasColumnName(whereClauses[0], "user_id") || hasColumnName(whereClauses[0], "userId")).toBe(true);
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
      "user-1",
      "office-1"
    );

    expect(updatePayloads.some((entry) => entry.payload.status === "completed")).toBe(true);
    expect(updatePayloads.some((entry) => entry.payload.completedAt)).toBe(true);
    expect(insertPayloads.some((entry) => entry.jobType === "domain_event" && entry.payload?.eventName === "task.completed")).toBe(true);
  });

  it("blocks inbox actions against another user's email for directors", async () => {
    const tenantDb = {
      select: vi.fn(() => {
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any[]) => void) {
            resolve([{ id: "email-1", userId: "rep-2" }]);
          },
        };
        return chain;
      }),
    };

    await expect(
      updateEmailInboxAction(tenantDb as any, "email-1", "director-1", "director", { isStarred: true })
    ).rejects.toThrow("You can only modify your own emails");
  });

  it("blocks ignore and unignore against another user's email for directors", async () => {
    const tenantDb = {
      select: vi.fn(() => {
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any[]) => void) {
            resolve([{ id: "email-1", userId: "rep-2" }]);
          },
        };
        return chain;
      }),
    };

    await expect(ignoreEmailAssignment(tenantDb as any, "email-1", "director-1", "director")).rejects.toThrow(
      "You can only modify your own emails"
    );
    await expect(unignoreEmailAssignment(tenantDb as any, "email-1", "director-1", "director")).rejects.toThrow(
      "You can only modify your own emails"
    );
  });

  it("recomputes denormalized stats for a company-linked email when ignoring it", async () => {
    const updateTables: string[] = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any[]) => void) {
            resolve([
              {
                id: "email-1",
                userId: "rep-1",
                assignedEntityType: "company",
                assignedEntityId: "company-1",
                dealId: null,
                contactId: null,
              },
            ]);
          },
        };
        return chain;
      }),
      update: vi.fn((table: any) => {
        updateTables.push(table?.name ?? "unknown");
        return {
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn(async () => []),
            })),
          })),
        };
      }),
    };

    await ignoreEmailAssignment(tenantDb as any, "email-1", "rep-1", "rep");

    expect(updateTables.length).toBeGreaterThan(1);
  });

  it("recomputes denormalized stats for a company-linked email when unignoring it", async () => {
    const updateTables: string[] = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any[]) => void) {
            resolve([
              {
                id: "email-1",
                userId: "rep-1",
                assignedEntityType: "company",
                assignedEntityId: "company-1",
                dealId: null,
                contactId: null,
              },
            ]);
          },
        };
        return chain;
      }),
      update: vi.fn((table: any) => {
        updateTables.push(table?.name ?? "unknown");
        return {
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn(async () => []),
            })),
          })),
        };
      }),
    };

    await unignoreEmailAssignment(tenantDb as any, "email-1", "rep-1", "rep");

    expect(updateTables.length).toBeGreaterThan(1);
  });

  it("recomputes linked deal stats when ignoring an email assigned to a lead", async () => {
    const updatePayloads: Array<{ table: string; payload: any }> = [];
    const tenantDb = {
      select: vi.fn((shape?: Record<string, unknown>) => {
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any[]) => void) {
            const callIndex = (tenantDb.select as any).mock.calls.length;
            if (callIndex === 1) {
              resolve([
                {
                  id: "email-1",
                  userId: "rep-1",
                  assignedEntityType: "lead",
                  assignedEntityId: "lead-1",
                  dealId: null,
                  contactId: null,
                },
              ]);
              return;
            }
            if (shape && "id" in shape && !("companyId" in shape)) {
              resolve([{ id: "deal-1" }]);
              return;
            }
            if (shape && "companyId" in shape) {
              resolve([{ companyId: "company-1" }]);
              return;
            }
            resolve([]);
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
    };

    await ignoreEmailAssignment(tenantDb as any, "email-1", "rep-1", "rep");

    const dealStatsUpdate = updatePayloads.find((entry) =>
      hasColumnName(entry.payload?.emailCount, "source_lead_id")
    );
    expect(dealStatsUpdate).toBeDefined();
  });

  it("blocks manual association against another user's email for directors", async () => {
    const tenantDb = {
      select: vi.fn(() => {
        const callIndex = (tenantDb.select as any).mock.calls.length;
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any[]) => void) {
            if (callIndex === 1) {
              resolve([{ id: "email-1", userId: "rep-2" }]);
            } else {
              resolve([]);
            }
          },
        };
        return chain;
      }),
    };

    await expect(
      associateEmailToEntity(
        tenantDb as any,
        "email-1",
        { assignedEntityType: "company", assignedEntityId: "company-1" },
        "director",
        "director-1",
        "office-1"
      )
    ).rejects.toThrow("You can only modify your own emails");
  });

  it("blocks thread mutations when the mailbox belongs to another user, even for directors", async () => {
    const tenantDb = {
      select: vi.fn(() => {
        const callIndex = (tenantDb.select as any).mock.calls.length;
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any[]) => void) {
            if (callIndex === 1) {
              resolve([{ id: "mailbox-1" }]);
            } else {
              resolve([]);
            }
          },
        };
        return chain;
      }),
    };

    await expect(
      assertCanMutateEmailThread(
        tenantDb as any,
        { mailboxAccountId: "mailbox-2", binding: null, emails: [] },
        { id: "director-1", role: "director" }
      )
    ).rejects.toThrow("You can only modify your own email threads");
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
      "user-1",
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
        "user-1",
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
      "user-1",
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
            syncedAt: expect.any(Date),
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

  it("bumps email syncedAt when manually associating to a deal", async () => {
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
              resolve([{ id: "email-1", userId: "user-1", contactId: null, subject: "Hello", bodyPreview: "Hi", bodyHtml: null, sentAt: new Date("2026-04-20T00:00:00.000Z") }]);
            } else if (callIndex === 2) {
              resolve([{ id: "deal-1", companyId: "company-1", propertyId: "property-1", sourceLeadId: "lead-1" }]);
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
        values: vi.fn(async () => []),
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
      "user-1",
      "office-1"
    );

    expect(updatePayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            assignedEntityType: "deal",
            assignedEntityId: "deal-1",
            dealId: "deal-1",
            syncedAt: expect.any(Date),
          }),
        }),
      ])
    );
  });

  it("includes source lead email paths when recomputing deal email stats", async () => {
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
              resolve([{ id: "email-1", userId: "user-1", contactId: null }]);
            } else if (callIndex === 2) {
              resolve([{ id: "deal-1", companyId: "company-1", propertyId: "property-1", sourceLeadId: "lead-1" }]);
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
        values: vi.fn(async () => []),
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
      "user-1",
      "office-1"
    );

    const dealStatsUpdate = updatePayloads.find((entry) => entry.payload?.emailCount && hasColumnName(entry.payload.emailCount, "source_lead_id"));
    expect(dealStatsUpdate).toBeDefined();
    const emailCountSql = collectSqlText(dealStatsUpdate?.payload?.emailCount);
    const lastEmailSql = collectSqlText(dealStatsUpdate?.payload?.lastEmailAt);
    expect(emailCountSql).toContain("COUNT(e.id)::int");
    expect(emailCountSql).toContain("source_lead_id");
    expect(lastEmailSql).toContain("source_lead_id");
    expect(emailCountSql).not.toContain("sourceLeadId");
    expect(lastEmailSql).not.toContain("sourceLeadId");
    expect(emailCountSql).not.toContain("COUNT(*)");
  });

  it("bumps email syncedAt when using associateEmailToDeal helper", async () => {
    const updatePayloads: Array<{ table: string; payload: any }> = [];
    const tenantDb = {
      update: vi.fn((table: any) => ({
        set: vi.fn((payload: any) => {
          updatePayloads.push({ table: table?.name ?? "unknown", payload });
          return {
            where: vi.fn(async () => []),
          };
        }),
      })),
    };

    await associateEmailToDeal(tenantDb as any, "email-1", "deal-1");

    expect(updatePayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            assignedEntityType: "deal",
            assignedEntityId: "deal-1",
            dealId: "deal-1",
            syncedAt: expect.any(Date),
          }),
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
      "user-1",
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
      "user-1",
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
      "user-1",
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
      "user-1",
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
        "user-1",
        "office-1"
      )
    ).rejects.toThrow("assignedDealId must match assignedEntityId for deal assignments");
  });

  it("returns an ignored contact-context email to the parking lot when unignored", async () => {
    const email = {
      id: "email-1",
      userId: "rep-1",
      contactId: "contact-1",
      assignedEntityId: null,
      dealId: null,
    };
    const updateSet = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => [{ ...email, assignmentStatus: "unassigned" }]),
      })),
    }));
    const tenantDb = {
      select: vi.fn(() => createSelectChain([email])),
      update: vi.fn(() => ({ set: updateSet })),
    };

    const result = await unignoreEmailAssignment(tenantDb as any, "email-1", "rep-1", "rep");

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentStatus: "unassigned",
        syncedAt: expect.any(Date),
      })
    );
    expect(result.assignmentStatus).toBe("unassigned");
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

  it("persists an explicitly selected contact association instead of falling back to company-only linkage", async () => {
    isGraphAuthConfiguredMock.mockReturnValue(false);

    const emailInsertPayloads: any[] = [];
    const activityInsertPayloads: any[] = [];
    let insertCallCount = 0;
    const selectMock = vi.fn((shape?: Record<string, unknown>) => {
      if (shape && "companyId" in shape && "id" in shape) {
        return createSelectChain([{ id: "contact-1", companyId: "company-1" }]);
      }
      if (shape && "companyId" in shape) {
        return createSelectChain([{ companyId: "company-1" }]);
      }
      return createSelectChain([]);
    });
    const tenantDb = {
      select: selectMock,
      insert: vi.fn((table: any) => ({
        values: vi.fn((payload: any) => {
          insertCallCount += 1;
          if (insertCallCount === 1) {
            emailInsertPayloads.push(payload);
            return {
              returning: vi.fn(async () => [
                {
                  id: "email-1",
                  assignedEntityType: payload.assignedEntityType,
                  assignedEntityId: payload.assignedEntityId,
                  dealId: payload.dealId,
                  contactId: payload.contactId,
                  threadBindingId: null,
                },
              ]),
            };
          }

          activityInsertPayloads.push(payload);

          return {
            returning: vi.fn(async () => []),
            then(resolve: (value: any[]) => void) {
              resolve([]);
            },
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => []),
        })),
      })),
    };

    await sendEmail(tenantDb as any, "user-1", {
      to: ["client@example.com"],
      subject: "Contact follow up",
      bodyHtml: "<p>Hello</p>",
      assignedEntityType: "contact",
      assignedEntityId: "contact-1",
      contactId: "contact-1",
    });

    expect(emailInsertPayloads[0]).toEqual(
      expect.objectContaining({
        assignedEntityType: "contact",
        assignedEntityId: "contact-1",
        contactId: "contact-1",
      })
    );
    expect(activityInsertPayloads[0]).toEqual(
      expect.objectContaining({
        sourceEntityType: "contact",
        sourceEntityId: "contact-1",
        contactId: "contact-1",
      })
    );
  });

  it("persists explicit lead associations and refreshes lead email stats", async () => {
    isGraphAuthConfiguredMock.mockReturnValue(false);

    const updatePayloads: Array<{ table: string; payload: any }> = [];
    const activityInsertPayloads: any[] = [];
    let insertCallCount = 0;
    const selectMock = vi.fn((shape?: Record<string, unknown>) => {
      if (shape && "id" in shape && !("companyId" in shape) && !("propertyId" in shape)) {
        return createSelectChain([{ id: "deal-7" }]);
      }
      if (shape && "propertyId" in shape) {
        return createSelectChain([{ id: "lead-1", companyId: "company-1", propertyId: "property-1" }]);
      }
      if (shape && "companyId" in shape) {
        return createSelectChain([{ companyId: "company-1" }]);
      }
      return createSelectChain([]);
    });
    const tenantDb = {
      select: selectMock,
      insert: vi.fn((table: any) => ({
        values: vi.fn((payload: any) => {
          insertCallCount += 1;
          if (insertCallCount > 1) {
            activityInsertPayloads.push(payload);
          }
          return {
            returning: vi.fn(async () => {
              if (insertCallCount === 1) {
                return [
                  {
                    id: "email-1",
                    assignedEntityType: payload.assignedEntityType,
                    assignedEntityId: payload.assignedEntityId,
                    dealId: payload.dealId ?? null,
                    contactId: payload.contactId ?? null,
                    threadBindingId: null,
                  },
                ];
              }
              return [];
            }),
            then(resolve: (value: any[]) => void) {
              resolve([]);
            },
          };
        }),
      })),
      update: vi.fn((table: any) => ({
        set: vi.fn((payload: any) => {
          updatePayloads.push({ table: table?.name ?? "unknown", payload });
          return {
            where: vi.fn(async () => []),
          };
        }),
      })),
    };

    await sendEmail(tenantDb as any, "user-1", {
      to: ["client@example.com"],
      subject: "Lead follow up",
      bodyHtml: "<p>Hello</p>",
      assignedEntityType: "lead",
      assignedEntityId: "lead-1",
    });

    expect(activityInsertPayloads[0]).toEqual(
      expect.objectContaining({
        sourceEntityType: "lead",
        sourceEntityId: "lead-1",
        leadId: "lead-1",
      })
    );
    expect(updatePayloads.length).toBeGreaterThanOrEqual(3);
  });

  it("recomputes linked entity email stats after sending an outbound email", async () => {
    isGraphAuthConfiguredMock.mockReturnValue(false);

    let insertCalls = 0;
    const updatePayloads: Array<{ table: string; payload: any }> = [];
    const tenantDb = {
      select: vi.fn(() => {
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          then(resolve: (value: any) => void) {
            resolve([{ companyId: "company-1" }]);
          },
        };
        return chain;
      }),
      insert: vi.fn((table: any) => ({
        values: vi.fn((_payload: any) => ({
          returning: vi.fn(async () => {
            insertCalls += 1;
            if (insertCalls === 1) {
              return [
                {
                  id: "email-1",
                  assignedEntityType: "company",
                  assignedEntityId: "company-1",
                  dealId: null,
                  contactId: "contact-1",
                  threadBindingId: null,
                },
              ];
            }
            return [];
          }),
          then(resolve: (value: any[]) => void) {
            resolve([]);
          },
        })),
      })),
      update: vi.fn((table: any) => ({
        set: vi.fn((payload: any) => {
          updatePayloads.push({ table: table?.name ?? "unknown", payload });
          return {
            where: vi.fn(async () => []),
          };
        }),
      })),
    };

    await sendEmail(tenantDb as any, "user-1", {
      to: ["client@example.com"],
      subject: "Follow up",
      bodyHtml: "<p>Hello</p>",
      contactId: "contact-1",
    });

    expect(updatePayloads).toHaveLength(2);
    expect(updatePayloads.some((entry) => hasColumnName(entry.payload?.emailCount, "company_id"))).toBe(true);
    expect(updatePayloads.some((entry) => hasColumnName(entry.payload?.emailCount, "contact_id"))).toBe(true);
  });
});
