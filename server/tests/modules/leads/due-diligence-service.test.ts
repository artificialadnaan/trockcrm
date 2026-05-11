import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";
import { pool } from "../../../src/db.js";
import { sendSystemEmailWithMetadata } from "../../../src/lib/resend-client.js";
import { getStageBySlug } from "../../../src/modules/pipeline/service.js";
import { transitionLeadStage } from "../../../src/modules/leads/service.js";
import {
  notificationRecipientAssignments,
  notificationRecipientGroups,
  users,
} from "@trock-crm/shared/schema";
import {
  assertSafeOfficeSlug,
  assertSafeTenantSchema,
  buildLeadDueDiligenceEmail,
  createLeadDueDiligenceApproval,
  decideDueDiligenceByToken,
  decideLeadDueDiligenceApproval,
  dispatchPendingDueDiligenceEmail,
  getLeadDueDiligenceApprovalForLead,
  getLeadDueDiligenceRecipients,
  listLeadDueDiligenceApprovals,
  renderDueDiligenceDecisionPage,
  renderDueDiligenceNotFoundPage,
  updateNotificationRecipientAssignments,
} from "../../../src/modules/leads/due-diligence-service.js";

vi.mock("../../../src/db.js", () => ({
  pool: {
    connect: vi.fn(),
  },
}));

vi.mock("../../../src/lib/resend-client.js", () => ({
  sendSystemEmailWithMetadata: vi.fn(),
}));

vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageBySlug: vi.fn(),
}));

vi.mock("../../../src/modules/leads/service.js", () => ({
  transitionLeadStage: vi.fn(),
}));

const NOW = new Date("2026-05-05T15:30:00.000Z");

function makeApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    leadId: "lead-1",
    lead_id: "lead-1",
    status: "pending",
    approvalToken: "a".repeat(64),
    approval_token: "a".repeat(64),
    requestedBy: "requester-1",
    requested_by: "requester-1",
    requestedAt: NOW,
    requested_at: NOW,
    decidedBy: null,
    decided_by: null,
    decidedAt: null,
    decided_at: null,
    decisionReason: null,
    decision_reason: null,
    detectionSignal: {
      source: "company",
      type: "lead",
      occurredAt: NOW,
      detail: "Recent lead activity on company",
    },
    detection_signal: {
      source: "company",
      type: "lead",
      occurredAt: NOW,
      detail: "Recent lead activity on company",
    },
    emailSentAt: null,
    email_sent_at: null,
    emailMessageId: null,
    email_message_id: null,
    createdAt: NOW,
    created_at: NOW,
    updatedAt: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeLeadSummary() {
  return {
    leadId: "lead-1",
    leadName: "Roof Replacement",
    bidDueDate: "2026-06-01",
    budgetStatus: "budgeted_q1",
    primaryContactRole: "property_manager",
    primaryContactRoleOtherLabel: null,
    companyName: "Acme Properties",
    companyVerificationStatus: "pending",
    contactFirstName: "Ada",
    contactLastName: "Lovelace",
    contactEmail: "ada@example.com",
    propertyName: "Acme Tower",
    propertyAddress: "1 Main St",
    propertyCity: "Atlanta",
    propertyState: "GA",
    propertyZip: "30301",
    propertyUnitCount: 120,
    propertyBuildYear: 1998,
    projectTypeName: "Roofing",
  };
}

function makePublicSummary(overrides: Record<string, unknown> = {}) {
  return {
    lead_name: "Roof & Gutter Scope",
    primary_contact_role: "property_manager",
    primary_contact_role_other_label: null,
    budget_status: "budgeted_q1",
    bid_due_date: "2026-06-01",
    company_name: "Acme & Sons",
    property_address: "1 Main St",
    property_city: "Atlanta",
    property_state: "GA",
    property_zip: "30301",
    unit_count: 120,
    build_year: 1998,
    project_type_name: "Roofing",
    primary_contact_name: "Ada Lovelace",
    primary_contact_email: "ada@example.com",
    ...overrides,
  };
}

function createTenantDb(options: {
  approvals?: Array<Record<string, unknown>>;
  recipients?: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
  lead?: Record<string, unknown>;
  insertError?: unknown;
  listRows?: Array<Record<string, unknown>>;
} = {}) {
  const state = {
    approvals: options.approvals ? [...options.approvals] : [],
    recipients: options.recipients ? [...options.recipients] : [],
    summary: options.summary ?? makeLeadSummary(),
    lead: options.lead ?? { id: "lead-1", stageId: "stage-new-lead", stage_id: "stage-new-lead" },
    leadUpdates: [] as Array<Record<string, unknown>>,
    approvalUpdates: [] as Array<Record<string, unknown>>,
  };

  const tenantDb = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          if (options.insertError) throw options.insertError;
          const row = makeApproval({
            ...values,
            id: `approval-${state.approvals.length + 1}`,
            approvalToken: values.approvalToken ?? "b".repeat(64),
            approval_token: values.approvalToken ?? "b".repeat(64),
            lead_id: values.leadId,
            requested_by: values.requestedBy,
            requested_at: values.requestedAt,
            detection_signal: values.detectionSignal,
            created_at: values.createdAt,
            updated_at: values.updatedAt,
          });
          state.approvals.push(row);
          return [row];
        }),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            const tableName = (table as { [Symbol.toStringTag]?: string })?.[Symbol.toStringTag] ?? "";
            if (String(tableName).includes("PgTable")) {
              // Drizzle table object identity is not important in these tests:
              // approval updates are the only update(...).returning() path.
            }
            const existing = state.approvals.find((approval) => approval.status === "pending");
            if (!existing) return [];
            const updated = {
              ...existing,
              ...values,
              status: values.status ?? existing.status,
              decided_by: values.decidedBy ?? existing.decided_by,
              decided_at: values.decidedAt ?? existing.decided_at,
              decision_reason: values.decisionReason ?? existing.decision_reason,
              email_sent_at: values.emailSentAt ?? existing.email_sent_at,
              email_message_id: values.emailMessageId ?? existing.email_message_id,
              updated_at: values.updatedAt ?? existing.updated_at,
            };
            Object.assign(existing, updated);
            state.approvalUpdates.push(values);
            return [updated];
          }),
          then: vi.fn((onfulfilled: (value: unknown) => unknown) => {
            const existing = state.approvals.find((approval) => approval.status === "pending");
            if (existing) {
              Object.assign(existing, {
                ...values,
                email_sent_at: values.emailSentAt ?? existing.email_sent_at,
                email_message_id: values.emailMessageId ?? existing.email_message_id,
                updated_at: values.updatedAt ?? existing.updated_at,
              });
              state.approvalUpdates.push(values);
            }
            return Promise.resolve(undefined).then(onfulfilled);
          }),
        })),
      })),
    })),
    select: vi.fn((fields?: Record<string, unknown>) => {
      const selection =
        fields && "email" in fields ? "recipients" :
        fields && "leadName" in fields ? "summary" :
        fields && "stageId" in fields ? "leadStage" :
        "approval";
      let orderedByRequestedAtDesc = false;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.leftJoin = vi.fn(() => chain);
      chain.where = vi.fn(() => {
        if (selection === "recipients") return Promise.resolve(state.recipients);
        chain.limit = vi.fn(async () => {
          if (selection === "leadStage") {
            return [state.lead];
          }
          if (selection === "approval") {
            const approvals = orderedByRequestedAtDesc
              ? [...state.approvals].sort((a, b) => {
                const aTime = new Date(String(a.requestedAt ?? a.requested_at)).getTime();
                const bTime = new Date(String(b.requestedAt ?? b.requested_at)).getTime();
                return bTime - aTime;
              })
              : state.approvals;
            return approvals.slice(0, 1);
          }
          return [state.summary];
        });
        return chain;
      });
      chain.orderBy = vi.fn(() => {
        orderedByRequestedAtDesc = true;
        return chain;
      });
      return chain;
    }),
    execute: vi.fn(async () => ({ rows: options.listRows ?? [] })),
    __state: state,
  };

  return tenantDb;
}

function createRecipientAssignmentDb(options: {
  users: Array<{ id: string; email: string; displayName: string; role?: string; isActive?: boolean }>;
  assignments?: string[];
}) {
  const state = {
    group: {
      id: "group-1",
      key: "lead_due_diligence",
      name: "Lead Due Diligence",
      description: "Recipients who receive new-customer lead due diligence approval requests.",
    },
    users: options.users,
    assignments: [...(options.assignments ?? [])],
  };

  function recipients() {
    return state.assignments
      .map((userId) => state.users.find((user) => user.id === userId))
      .filter((user): user is { id: string; email: string; displayName: string; isActive?: boolean } => Boolean(user))
      .filter((user) => user.isActive !== false)
      .map((user) => ({ userId: user.id, email: user.email, displayName: user.displayName }));
  }

  function adminDirectorRecipients() {
    return state.users
      .filter((user) => (user.role === "admin" || user.role === "director") && user.isActive !== false)
      .map((user) => ({ userId: user.id, email: user.email, displayName: user.displayName }));
  }

  const txDb = {
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async () => {
        if (table === notificationRecipientAssignments) {
          state.assignments = [];
        }
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: Array<{ userId: string }>) => {
        if (table === notificationRecipientAssignments) {
          state.assignments = values.map((value) => value.userId);
        }
      }),
    })),
  };

  let selectedTable: unknown = null;
  let selectedFields: Record<string, unknown> | undefined;
  const tenantDb = {
    select: vi.fn((fields?: Record<string, unknown>) => {
      selectedFields = fields;
      const chain: Record<string, unknown> = {
        from: vi.fn((table: unknown) => {
          selectedTable = table;
          return chain;
        }),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => {
          if (selectedTable === users && selectedFields && "id" in selectedFields) {
            return Promise.resolve(state.users.map((user) => ({ id: user.id })));
          }
          if (selectedTable === notificationRecipientGroups && selectedFields && "email" in selectedFields) {
            return Promise.resolve(recipients());
          }
          if (selectedTable === users && selectedFields && "email" in selectedFields) {
            return Promise.resolve(adminDirectorRecipients());
          }
          return chain;
        }),
        limit: vi.fn(async () => {
          if (selectedTable === notificationRecipientGroups) {
            return [state.group];
          }
          return [];
        }),
      };
      return chain;
    }),
    transaction: vi.fn(async (callback: (tx: typeof txDb) => Promise<void>) => callback(txDb)),
    __state: state,
    __tx: txDb,
  };

  return tenantDb;
}

function queryTextFromExecuteMock(execute: ReturnType<typeof vi.fn>) {
  const queryArg = execute.mock.calls[0][0] as unknown;
  return JSON.stringify((queryArg as { queryChunks?: unknown[] })?.queryChunks ?? queryArg);
}

function makePoolClient(options: {
  schemas?: string[];
  approval?: Record<string, unknown> | null;
  summary?: Record<string, unknown> | null;
  leadStageId?: string | null;
  updateRow?: Record<string, unknown>;
} = {}) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("information_schema.schemata")) {
        return { rows: (options.schemas ?? ["office_atlanta"]).map((schema_name) => ({ schema_name })) };
      }
      if (text.includes("SELECT a.*")) {
        return { rows: options.approval === null ? [] : [options.approval ?? makeApproval({ tenant_schema: "office_atlanta" })] };
      }
      if (text.includes('SELECT stage_id') && text.includes('FROM "office_atlanta".leads')) {
        return { rows: options.leadStageId === null ? [] : [{ stage_id: options.leadStageId ?? "stage-new-lead" }] };
      }
      if (text.includes('FROM "office_atlanta".leads')) {
        return { rows: options.summary === null ? [] : [options.summary ?? makePublicSummary()] };
      }
      if (text.includes('UPDATE "office_atlanta".lead_due_diligence_approvals')) {
        return { rows: [options.updateRow ?? makeApproval({ status: params?.[0], decided_by: null, tenant_schema: "office_atlanta" })] };
      }
      if (text.includes('UPDATE "office_atlanta".leads')) return { rows: [] };
      return { rows: [] };
    }),
    release: vi.fn(),
    calls,
  };
  vi.mocked(pool.connect).mockResolvedValue(client as never);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStageBySlug).mockImplementation(async (slug: string) => {
    if (slug === "new_lead") {
      return { id: "stage-new-lead", slug: "new_lead", name: "New Lead", displayOrder: 1, isTerminal: false };
    }
    if (slug === "qualified_lead") {
      return { id: "stage-qualified-lead", slug: "qualified_lead", name: "Qualified Lead", displayOrder: 2, isTerminal: false };
    }
    return null;
  });
  vi.mocked(transitionLeadStage).mockResolvedValue({
    ok: true,
    lead: { id: "lead-1", stageId: "stage-qualified-lead" },
  } as never);
});

describe("buildLeadDueDiligenceEmail", () => {
  it("renders human-readable POC role and budget status labels", () => {
    const email = buildLeadDueDiligenceEmail({
      summary: makeLeadSummary() as never,
      token: "a".repeat(64),
      detectionSignal: {
        source: "company",
        type: "deal",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
        detail: "Recent deal activity on company",
      },
    });

    expect(email.html).toContain("Property Manager");
    expect(email.html).not.toContain("property_manager");
    expect(email.html).not.toContain("property manager");
    expect(email.html).toContain("Budgeted Q1");
    expect(email.html).not.toContain("budgeted_q1");
  });

  it("omits internal source/type tags from the detection explanation", () => {
    const email = buildLeadDueDiligenceEmail({
      summary: makeLeadSummary() as never,
      token: "a".repeat(64),
      detectionSignal: {
        source: "company",
        type: "deal",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
        detail: "Recent deal activity on company",
      },
    });

    expect(email.html).toContain("Recent deal activity on company on 2026-05-01.");
    expect(email.html).not.toContain("(company/deal)");
  });

  it("does not leave trailing whitespace in the contact line when email is missing", () => {
    const email = buildLeadDueDiligenceEmail({
      summary: {
        ...makeLeadSummary(),
        contactEmail: null,
      } as never,
      token: "a".repeat(64),
      detectionSignal: null,
    });

    expect(email.html).toContain("Ada Lovelace (Property Manager)</td>");
    expect(email.html).not.toContain("Ada Lovelace (Property Manager) </td>");
  });

  it("includes contact email with a readable separator when present", () => {
    const email = buildLeadDueDiligenceEmail({
      summary: makeLeadSummary() as never,
      token: "a".repeat(64),
      detectionSignal: null,
    });

    expect(email.html).toContain("Ada Lovelace (Property Manager) · ada@example.com");
  });
});

describe("createLeadDueDiligenceApproval", () => {
  it("creates a pending row with a 64-character hex token and detection signal", async () => {
    vi.mocked(sendSystemEmailWithMetadata).mockResolvedValue({ success: false, messageId: null });
    const tenantDb = createTenantDb({
      recipients: [{ userId: "user-1", email: "admin@example.com", displayName: "Admin" }],
    });

    const approval = await createLeadDueDiligenceApproval(tenantDb as never, {
      leadId: "lead-1",
      requestedBy: "requester-1",
      detectionSignal: {
        source: "company",
        type: "lead",
        occurredAt: NOW,
        detail: "Recent lead activity on company",
      },
      now: NOW,
    });

    expect(approval.status).toBe("pending");
    expect(String(approval.approvalToken)).toMatch(/^[a-f0-9]{64}$/);
    expect(approval.requestedBy).toBe("requester-1");
    expect(approval.requestedAt).toEqual(NOW);
    expect(approval.createdAt).toEqual(NOW);
    expect(approval.detectionSignal).toMatchObject({ source: "company", type: "lead" });
  });

  it("records fallback no-activity detection signal when no signal is provided", async () => {
    vi.mocked(sendSystemEmailWithMetadata).mockResolvedValue({ success: false, messageId: null });
    const tenantDb = createTenantDb({
      recipients: [{ userId: "user-1", email: "admin@example.com", displayName: "Admin" }],
    });

    const approval = await createLeadDueDiligenceApproval(tenantDb as never, {
      leadId: "lead-1",
      requestedBy: "requester-1",
      detectionSignal: null,
      now: NOW,
    });

    expect(approval.detectionSignal).toEqual({
      source: "none",
      type: "no_recent_activity",
      occurredAt: null,
      detail: "No activity found on company, contact, or property in the last 12 months.",
    });
  });

  it("leaves email metadata null during approval creation even when no recipients are configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tenantDb = createTenantDb({ recipients: [] });

    const approval = await createLeadDueDiligenceApproval(tenantDb as never, {
      leadId: "lead-1",
      requestedBy: "requester-1",
      detectionSignal: null,
      now: NOW,
    });

    expect(sendSystemEmailWithMetadata).not.toHaveBeenCalled();
    expect(approval.emailSentAt).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not send email during approval creation when recipients exist", async () => {
    vi.mocked(sendSystemEmailWithMetadata).mockResolvedValue({ success: true, messageId: "resend-1" });
    const tenantDb = createTenantDb({
      recipients: [{ userId: "user-1", email: "admin@example.com", displayName: "Admin" }],
    });

    const approval = await createLeadDueDiligenceApproval(tenantDb as never, {
      leadId: "lead-1",
      requestedBy: "requester-1",
      detectionSignal: null,
      now: NOW,
    });

    expect(sendSystemEmailWithMetadata).not.toHaveBeenCalled();
    expect(approval.emailSentAt).toBeNull();
    expect(approval.emailMessageId).toBeNull();
  });

  it("throws a clean 409 when an approval already exists for the lead", async () => {
    const tenantDb = createTenantDb({
      insertError: {
        code: "23505",
        constraint: "lead_due_diligence_approvals_lead_uidx",
      },
    });

    await expect(createLeadDueDiligenceApproval(tenantDb as never, {
      leadId: "lead-1",
      requestedBy: "requester-1",
      detectionSignal: null,
      now: NOW,
    })).rejects.toMatchObject<AppError>({
      statusCode: 409,
      message: expect.stringContaining("already exists for this lead"),
    });
  });
});

describe("dispatchPendingDueDiligenceEmail", () => {
  it("sends pending approval email and records metadata", async () => {
    vi.mocked(sendSystemEmailWithMetadata).mockResolvedValue({ success: true, messageId: "resend-1" });
    const tenantDb = createTenantDb({
      approvals: [makeApproval()],
      recipients: [{ userId: "user-1", email: "admin@example.com", displayName: "Admin" }],
    });

    const result = await dispatchPendingDueDiligenceEmail(tenantDb as never, "approval-1", { now: NOW });

    expect(result).toEqual({ success: true, messageId: "resend-1" });
    expect(sendSystemEmailWithMetadata).toHaveBeenCalledWith(
      ["admin@example.com"],
      "Due Diligence for New Lead/Company",
      expect.stringContaining("Review and decide")
    );
    expect((tenantDb as any).__state.approvals[0].email_sent_at).toEqual(NOW);
    expect((tenantDb as any).__state.approvals[0].email_message_id).toBe("resend-1");
  });

  it("falls back to active admins and directors when the DD recipient group is empty", async () => {
    vi.mocked(sendSystemEmailWithMetadata).mockResolvedValue({ success: true, messageId: "resend-1" });
    const tenantDb = createRecipientAssignmentDb({
      users: [
        { id: "admin-1", email: "admin@example.com", displayName: "Admin", role: "admin" },
        { id: "director-1", email: "director@example.com", displayName: "Director", role: "director" },
        { id: "rep-1", email: "rep@example.com", displayName: "Rep", role: "rep" },
        { id: "inactive-admin", email: "inactive@example.com", displayName: "Inactive", role: "admin", isActive: false },
      ],
      assignments: [],
    });

    const recipients = await getLeadDueDiligenceRecipients(tenantDb as never);

    expect(recipients).toEqual([
      { userId: "admin-1", email: "admin@example.com", displayName: "Admin" },
      { userId: "director-1", email: "director@example.com", displayName: "Director" },
    ]);
  });

  it("returns success false and leaves email metadata null when no recipients are configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tenantDb = createTenantDb({ approvals: [makeApproval()], recipients: [] });

    const result = await dispatchPendingDueDiligenceEmail(tenantDb as never, "approval-1", { now: NOW });

    expect(result).toEqual({ success: false, messageId: null });
    expect(sendSystemEmailWithMetadata).not.toHaveBeenCalled();
    expect((tenantDb as any).__state.approvals[0].email_sent_at).toBeNull();
    warn.mockRestore();
  });

  it("is a no-op for already-decided approvals", async () => {
    const tenantDb = createTenantDb({
      approvals: [makeApproval({ status: "approved" })],
      recipients: [{ userId: "user-1", email: "admin@example.com", displayName: "Admin" }],
    });

    const result = await dispatchPendingDueDiligenceEmail(tenantDb as never, "approval-1", { now: NOW });

    expect(result).toEqual({ success: false, messageId: null });
    expect(sendSystemEmailWithMetadata).not.toHaveBeenCalled();
  });

  it("is a no-op when the approval already has email_sent_at", async () => {
    const tenantDb = createTenantDb({
      approvals: [makeApproval({ emailSentAt: NOW, email_sent_at: NOW })],
      recipients: [{ userId: "user-1", email: "admin@example.com", displayName: "Admin" }],
    });

    const result = await dispatchPendingDueDiligenceEmail(tenantDb as never, "approval-1", { now: NOW });

    expect(result).toEqual({ success: false, messageId: null });
    expect(sendSystemEmailWithMetadata).not.toHaveBeenCalled();
  });

  it("catches thrown email errors and leaves email metadata null", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(sendSystemEmailWithMetadata).mockRejectedValue(new Error("resend down"));
    const tenantDb = createTenantDb({
      approvals: [makeApproval()],
      recipients: [{ userId: "user-1", email: "admin@example.com", displayName: "Admin" }],
    });

    const result = await dispatchPendingDueDiligenceEmail(tenantDb as never, "approval-1", { now: NOW });

    expect(result).toEqual({ success: false, messageId: null });
    expect((tenantDb as any).__state.approvals[0].email_sent_at).toBeNull();
    expect(error).toHaveBeenCalledWith(
      "[lead-dd] failed to dispatch due diligence email",
      expect.objectContaining({ approvalId: "approval-1" })
    );
    error.mockRestore();
  });
});

describe("updateNotificationRecipientAssignments", () => {
  it("replaces the recipient list atomically after validating users", async () => {
    const tenantDb = createRecipientAssignmentDb({
      users: [
        { id: "user-1", email: "one@example.com", displayName: "One" },
        { id: "user-2", email: "two@example.com", displayName: "Two" },
      ],
      assignments: ["user-1"],
    });

    const result = await updateNotificationRecipientAssignments(tenantDb as never, "lead_due_diligence", ["user-2"]);

    expect((tenantDb as any).__state.assignments).toEqual(["user-2"]);
    expect((tenantDb as any).transaction).toHaveBeenCalledOnce();
    expect(result.recipients).toEqual([{ userId: "user-2", email: "two@example.com", displayName: "Two" }]);
  });

  it("clears assignments when called with an empty list", async () => {
    const tenantDb = createRecipientAssignmentDb({
      users: [{ id: "user-1", email: "one@example.com", displayName: "One" }],
      assignments: ["user-1"],
    });

    const result = await updateNotificationRecipientAssignments(tenantDb as never, "lead_due_diligence", []);

    expect((tenantDb as any).__state.assignments).toEqual([]);
    expect(result.recipients).toEqual([]);
  });

  it("dedupes duplicate user IDs before inserting assignments", async () => {
    const tenantDb = createRecipientAssignmentDb({
      users: [{ id: "user-1", email: "one@example.com", displayName: "One" }],
      assignments: [],
    });

    await updateNotificationRecipientAssignments(tenantDb as never, "lead_due_diligence", ["user-1", "user-1"]);

    expect((tenantDb as any).__state.assignments).toEqual(["user-1"]);
  });

  it("throws a clean 400 for invalid user IDs before deleting existing assignments", async () => {
    const tenantDb = createRecipientAssignmentDb({
      users: [{ id: "user-1", email: "one@example.com", displayName: "One" }],
      assignments: ["user-1"],
    });

    await expect(updateNotificationRecipientAssignments(
      tenantDb as never,
      "lead_due_diligence",
      ["user-1", "missing-user"]
    )).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message: expect.stringContaining("missing-user"),
    });

    expect((tenantDb as any).transaction).not.toHaveBeenCalled();
    expect((tenantDb as any).__state.assignments).toEqual(["user-1"]);
  });
});

describe("decideLeadDueDiligenceApproval", () => {
  it("approves a pending approval and sets decided_by from the admin user", async () => {
    const tenantDb = createTenantDb({ approvals: [makeApproval()] });

    const approval = await decideLeadDueDiligenceApproval(tenantDb as never, {
      approvalId: "approval-1",
      decision: "approve",
      userId: "director-1",
      now: NOW,
    });

    expect(approval.status).toBe("approved");
    expect(approval.decidedBy).toBe("director-1");
    expect((tenantDb as any).__state.approvalUpdates[0]).toMatchObject({
      status: "approved",
      decidedBy: "director-1",
    });
  });

  it("auto-transitions a new_lead approval to qualified_lead after admin approval", async () => {
    const tenantDb = createTenantDb({
      approvals: [makeApproval()],
      lead: { id: "lead-1", stageId: "stage-new-lead" },
    });

    await decideLeadDueDiligenceApproval(tenantDb as never, {
      approvalId: "approval-1",
      decision: "approve",
      userId: "director-1",
      now: NOW,
    });

    expect(transitionLeadStage).toHaveBeenCalledWith(tenantDb, {
      leadId: "lead-1",
      targetStageId: "stage-qualified-lead",
      userId: "director-1",
      userRole: "admin",
    });
  });

  it("does not auto-transition admin approvals when the lead has already moved out of new_lead", async () => {
    const tenantDb = createTenantDb({
      approvals: [makeApproval()],
      lead: { id: "lead-1", stageId: "stage-sales-validation" },
    });

    await decideLeadDueDiligenceApproval(tenantDb as never, {
      approvalId: "approval-1",
      decision: "approve",
      userId: "director-1",
      now: NOW,
    });

    expect(transitionLeadStage).not.toHaveBeenCalled();
  });

  it("keeps admin approval successful when auto-transition is blocked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(transitionLeadStage).mockResolvedValueOnce({
      ok: false,
      code: "LEAD_DD_PENDING",
      reason: "missing_requirements",
      targetStageId: "stage-qualified-lead",
      resolution: "detail",
      missing: [],
    } as never);
    const tenantDb = createTenantDb({ approvals: [makeApproval()] });

    const approval = await decideLeadDueDiligenceApproval(tenantDb as never, {
      approvalId: "approval-1",
      decision: "approve",
      userId: "director-1",
      now: NOW,
    });

    expect(approval.status).toBe("approved");
    expect(warn).toHaveBeenCalledWith(
      "[lead-dd] auto-transition failed for lead lead-1 after approval",
      expect.objectContaining({ blockReason: "LEAD_DD_PENDING" })
    );
    warn.mockRestore();
  });

  it("rejects a pending approval with a trimmed reason and updates the compat mirror", async () => {
    const tenantDb = createTenantDb({ approvals: [makeApproval()] });

    const approval = await decideLeadDueDiligenceApproval(tenantDb as never, {
      approvalId: "approval-1",
      decision: "reject",
      reason: "  Not enough information  ",
      userId: "director-1",
      now: NOW,
    });

    expect(approval.status).toBe("rejected");
    expect(approval.decisionReason).toBe("Not enough information");
    expect((tenantDb as any).update).toHaveBeenCalledTimes(2);
  });

  it("requires a rejection reason of at least 10 trimmed characters", async () => {
    const tenantDb = createTenantDb({ approvals: [makeApproval()] });

    await expect(decideLeadDueDiligenceApproval(tenantDb as never, {
      approvalId: "approval-1",
      decision: "reject",
      reason: "    short   ",
      userId: "director-1",
      now: NOW,
    })).rejects.toMatchObject<AppError>({ statusCode: 400 });
  });

  it("throws 409 when the approval is already decided", async () => {
    const tenantDb = createTenantDb({ approvals: [makeApproval({ status: "approved" })] });

    await expect(decideLeadDueDiligenceApproval(tenantDb as never, {
      approvalId: "approval-1",
      decision: "approve",
      userId: "director-1",
      now: NOW,
    })).rejects.toMatchObject<AppError>({ statusCode: 409 });
  });
});

describe("decideDueDiligenceByToken", () => {
  it("approves a valid pending token inside a transaction with SELECT FOR UPDATE", async () => {
    const client = makePoolClient();

    const approval = await decideDueDiligenceByToken({
      token: "a".repeat(64),
      decision: "approve",
    });

    expect(approval.status).toBe("approved");
    expect(approval.decided_by).toBeNull();
    expect(client.calls.map((call) => call.text)).toContain("BEGIN");
    expect(client.calls.map((call) => call.text)).toContain("COMMIT");
    expect(client.calls.some((call) => call.text.includes("FOR UPDATE"))).toBe(true);
    expect(client.calls.some((call) => call.text.includes("decided_by = NULL"))).toBe(true);
    expect(client.calls.some((call) => call.text.includes("verification_status"))).toBe(true);
  });

  it("auto-transitions a new_lead approval to qualified_lead after token approval", async () => {
    makePoolClient({
      approval: makeApproval({
        tenant_schema: "office_atlanta",
        requested_by: "requester-1",
        lead_id: "lead-1",
      }),
      leadStageId: "stage-new-lead",
    });

    await decideDueDiligenceByToken({
      token: "a".repeat(64),
      decision: "approve",
    });

    expect(transitionLeadStage).toHaveBeenCalledWith(expect.anything(), {
      leadId: "lead-1",
      targetStageId: "stage-qualified-lead",
      userId: "requester-1",
      userRole: "admin",
    });
  });

  it("rejects a valid pending token with reason validation", async () => {
    makePoolClient({ updateRow: makeApproval({ status: "rejected", decided_by: null, tenant_schema: "office_atlanta" }) });

    const approval = await decideDueDiligenceByToken({
      token: "a".repeat(64),
      decision: "reject",
      reason: "Not a fit for T Rock",
    });

    expect(approval.status).toBe("rejected");
  });

  it("returns generic 404 for invalid token format", async () => {
    await expect(decideDueDiligenceByToken({
      token: "not-a-token",
      decision: "approve",
    })).rejects.toMatchObject<AppError>({
      statusCode: 404,
      message: "Due Diligence decision not found",
    });
  });

  it("returns generic 404 when token is not found in any tenant", async () => {
    makePoolClient({ approval: null });

    await expect(decideDueDiligenceByToken({
      token: "a".repeat(64),
      decision: "approve",
    })).rejects.toMatchObject<AppError>({ statusCode: 404 });
  });

  it("returns an already-decided approval without mutating it", async () => {
    const client = makePoolClient({
      approval: makeApproval({ status: "approved", tenant_schema: "office_atlanta" }),
    });

    const approval = await decideDueDiligenceByToken({
      token: "a".repeat(64),
      decision: "approve",
    });

    expect(approval.status).toBe("approved");
    expect(client.calls.some((call) => call.text.includes("UPDATE office_atlanta.lead_due_diligence_approvals"))).toBe(false);
  });

  it("requires reject reason validation on public token decisions", async () => {
    await expect(decideDueDiligenceByToken({
      token: "a".repeat(64),
      decision: "reject",
      reason: "short",
    })).rejects.toMatchObject<AppError>({ statusCode: 400 });
  });
});

describe("renderDueDiligenceDecisionPage", () => {
  it("rejects invalid token format with a generic 404", async () => {
    await expect(renderDueDiligenceDecisionPage("not-a-token")).rejects.toMatchObject<AppError>({
      statusCode: 404,
      message: "Due Diligence decision not found",
    });
  });

  it("rejects missing tokens with the styled not-found page helper available", () => {
    const html = renderDueDiligenceNotFoundPage();

    expect(html).toContain("T Rock Construction — Lead Due Diligence");
    expect(html).toContain("This Due Diligence link is invalid or has expired.");
    expect(html).not.toContain("approval_token");
  });

  it("returns generic 404 when token is not found in any tenant", async () => {
    makePoolClient({ approval: null });

    await expect(renderDueDiligenceDecisionPage("a".repeat(64))).rejects.toMatchObject<AppError>({
      statusCode: 404,
      message: "Due Diligence decision not found",
    });
  });

  it("renders pending approval summary with split approve and reject forms", async () => {
    makePoolClient({
      approval: makeApproval({
        tenant_schema: "office_atlanta",
        detection_signal: {
          source: "company",
          type: "deal",
          occurredAt: "2026-05-01",
          detail: "Recent deal activity on company",
        },
      }),
      summary: makePublicSummary(),
    });

    const html = await renderDueDiligenceDecisionPage("a".repeat(64));

    expect(html).toContain("T Rock Construction — Lead Due Diligence");
    expect(html).toContain('name="token" value="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="reject"');
    expect(html).toContain('textarea id="reason" name="reason" minlength="10" required');
    expect(html).toContain("Ada Lovelace (Property Manager) · ada@example.com");
    expect(html).toContain("Budgeted Q1");
    expect(html).not.toContain("property_manager");
    expect(html).not.toContain("budgeted_q1");
  });

  it("renders already-decided approval with no action buttons", async () => {
    makePoolClient({
      approval: makeApproval({
        status: "approved",
        decided_at: "2026-05-06T00:00:00.000Z",
        tenant_schema: "office_atlanta",
      }),
      summary: makePublicSummary(),
    });

    const html = await renderDueDiligenceDecisionPage("a".repeat(64));

    expect(html).toContain("This decision has already been recorded as <strong>approved</strong>");
    expect(html).not.toContain('name="decision" value="approve"');
    expect(html).not.toContain('name="decision" value="reject"');
  });

  it("escapes HTML once and omits internal source/type tags in detection text", async () => {
    makePoolClient({
      approval: makeApproval({
        tenant_schema: "office_atlanta",
        detection_signal: {
          source: "company",
          type: "deal",
          occurred_at: "2026-05-01",
          detail: "Recent A&B activity <script>",
        },
      }),
      summary: makePublicSummary({
        company_name: "Acme & Sons",
      }),
    });

    const html = await renderDueDiligenceDecisionPage("a".repeat(64));

    expect(html).toContain("Recent A&amp;B activity &lt;script&gt; on 2026-05-01.");
    expect(html).not.toContain("A&amp;amp;B");
    expect(html).not.toContain("(company/deal)");
    expect(html).toContain("Acme &amp; Sons");
    expect(html).not.toContain("Acme &amp;amp; Sons");
  });

  it("renders inline error and notice states with decision page styling", async () => {
    makePoolClient({
      approval: makeApproval({ tenant_schema: "office_atlanta" }),
      summary: makePublicSummary(),
    });

    const html = await renderDueDiligenceDecisionPage("a".repeat(64), {
      error: "Rejection reason must be at least 10 characters",
      notice: "Decision recorded as approved.",
    });

    expect(html).toContain("Rejection reason must be at least 10 characters");
    expect(html).toContain("Decision recorded as approved.");
    expect(html).toContain('class="error"');
  });
});

describe("approval lookup and list helpers", () => {
  it("returns the approval for a lead when it exists", async () => {
    const tenantDb = createTenantDb({
      approvals: [
        makeApproval({ id: "older", requestedAt: new Date("2026-05-01T00:00:00.000Z") }),
        makeApproval({ id: "newer", requestedAt: new Date("2026-05-03T00:00:00.000Z") }),
      ],
    });

    const approval = await getLeadDueDiligenceApprovalForLead(tenantDb as never, "lead-1");

    expect(approval?.id).toBe("newer");
  });

  it("returns null when no approval exists for a lead", async () => {
    const tenantDb = createTenantDb({ approvals: [] });

    const approval = await getLeadDueDiligenceApprovalForLead(tenantDb as never, "lead-1");

    expect(approval).toBeNull();
  });

  it("lists approvals filtered by status for the admin queue", async () => {
    const rows = [
      { id: "approval-new", status: "pending", requested_at: "2026-05-05T12:00:00.000Z", lead_name: "New" },
      { id: "approval-old", status: "pending", requested_at: "2026-05-04T12:00:00.000Z", lead_name: "Old" },
    ];
    const tenantDb = createTenantDb({ listRows: rows });

    const result = await listLeadDueDiligenceApprovals(tenantDb as never, "pending");

    expect(result).toEqual(rows);
    const queryText = queryTextFromExecuteMock((tenantDb as any).execute);
    expect(queryText).toContain("WHERE a.status");
    expect(queryText).toContain("ORDER BY a.requested_at DESC");
    expect(queryText).toContain("lead_name");
    expect(queryText).toContain("company_name");
  });
});

describe("assertSafeTenantSchema", () => {
  it("accepts valid office tenant schema names", () => {
    expect(() => assertSafeTenantSchema("office_atlanta")).not.toThrow();
    expect(() => assertSafeTenantSchema("office_pwauditoffice")).not.toThrow();
  });

  it("rejects sql injection attempts", () => {
    expect(() => assertSafeTenantSchema("office_x; DROP TABLE leads")).toThrow(AppError);
  });

  it("rejects empty strings and non-office schemas", () => {
    expect(() => assertSafeTenantSchema("")).toThrow(AppError);
    expect(() => assertSafeTenantSchema("public")).toThrow(AppError);
    expect(() => assertSafeTenantSchema("tenant_atlanta")).toThrow(AppError);
  });
});

describe("assertSafeOfficeSlug", () => {
  it("accepts valid office slugs", () => {
    expect(() => assertSafeOfficeSlug("dallas")).not.toThrow();
    expect(() => assertSafeOfficeSlug("pwauditoffice")).not.toThrow();
    expect(() => assertSafeOfficeSlug("atlanta_2")).not.toThrow();
  });

  it("rejects unsafe office slugs", () => {
    expect(() => assertSafeOfficeSlug("")).toThrow(AppError);
    expect(() => assertSafeOfficeSlug("office_x; DROP TABLE leads")).toThrow(AppError);
    expect(() => assertSafeOfficeSlug("dallas-prod")).toThrow(AppError);
    expect(() => assertSafeOfficeSlug("Dallas")).toThrow(AppError);
  });
});
