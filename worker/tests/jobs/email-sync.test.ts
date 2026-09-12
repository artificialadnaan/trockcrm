import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

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
  activeDeals: Array<{
    id: string;
    deal_number: string;
    name: string;
    company_id?: string | null;
    stage_slug?: string | null;
    stage_display_order?: number | null;
    property_address?: string | null;
    property_city?: string | null;
    property_state?: string | null;
    property_zip?: string | null;
  }>;
  threadBinding?: {
    id: string;
    deal_id: string | null;
  } | null;
  contactMatch?: {
    id: string;
    first_name: string;
    last_name: string;
    company_id: string | null;
  } | null;
  companyName?: string | null;
  /** Whether the deal the email resolves to sits in a terminal (Won / Lost) stage. */
  dealIsTerminal?: boolean;
}) {
  return vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("SELECT set_config('search_path', $1, false)")) {
      return { rows: [{ set_config: params?.[0] ?? null }] };
    }

    if (sql.startsWith("SELECT set_config('app.current_user_id', $1, false)")) {
      return { rows: [{ set_config: params?.[0] ?? null }] };
    }

    if (sql.includes("FROM public.pipeline_stage_config") && sql.includes("MIN(display_order)")) {
      return { rows: [{ display_order: 2 }] };
    }

    if (sql.includes("FROM office_beta.emails") && sql.includes("graph_message_id = $1")) {
      return { rows: [] };
    }

    if (sql.includes("SELECT id FROM public.user_graph_tokens")) {
      return { rows: [{ id: "mailbox-1" }] };
    }

    if (sql.includes("FROM office_beta.email_thread_bindings") && sql.includes("provider_conversation_id = $2")) {
      return { rows: options.threadBinding ? [options.threadBinding] : [] };
    }

    if (sql.includes("FROM office_beta.email_thread_bindings") && sql.includes("provider_conversation_id IS NULL")) {
      return { rows: [] };
    }

    if (sql.startsWith("UPDATE office_beta.email_thread_bindings")) {
      return { rows: options.threadBinding ? [options.threadBinding] : [] };
    }

    if (sql.includes("SELECT id") && sql.includes("FROM office_beta.tasks") && sql.includes("email_assignment_queue")) {
      return { rows: [] };
    }

    if (sql.includes("SELECT id, first_name, last_name, company_id") && sql.includes("FROM office_beta.contacts")) {
      return { rows: options.contactMatch ? [options.contactMatch] : [] };
    }

    if (sql.includes("SELECT company_id, company_name") && sql.includes("FROM office_beta.contacts")) {
      return {
        rows: options.contactMatch
          ? [{ company_id: options.contactMatch.company_id, company_name: options.companyName ?? "Alpha Roofing" }]
          : [],
      };
    }

    if (sql.startsWith("INSERT INTO office_beta.emails")) {
      return { rows: [{ id: "email-1" }] };
    }

    // Deal-parent fetch (company/property/source-lead) for the activity link columns + parent-company stat,
    // which ALSO reports is_terminal — the reply-needed task is suppressed once the deal has closed.
    // MUST precede the broad `FROM office_beta.deals d` branch below: that one matches this SQL too and
    // would answer with a deal-candidate row that has no is_terminal field, so every case would read as
    // "open" and the terminal-deal assertions would prove nothing.
    if (sql.includes("COALESCE(psc.is_terminal, false)")) {
      return {
        rows: [
          {
            company_id: null,
            property_id: null,
            source_lead_id: null,
            is_terminal: options.dealIsTerminal ?? false,
          },
        ],
      };
    }

    if (sql.includes("FROM office_beta.deals d")) {
      return { rows: options.activeDeals };
    }

    if (sql.includes("FROM office_beta.deals") && sql.includes("company_id = $1") && !sql.includes("FROM office_beta.deals d")) {
      return { rows: options.activeDeals };
    }

    if (sql.startsWith("UPDATE office_beta.emails")) {
      return { rows: [] };
    }

    // Email-stat refresh (email_count / last_email_at) for any resolved target.
    if (
      (sql.includes("UPDATE office_beta.deals") ||
        sql.includes("UPDATE office_beta.companies") ||
        sql.includes("UPDATE office_beta.leads") ||
        sql.includes("UPDATE office_beta.contacts")) &&
      sql.includes("email_count")
    ) {
      return { rows: [] };
    }

    if (sql.startsWith("INSERT INTO office_beta.activities")) {
      return { rows: [] };
    }

    if (sql.startsWith("INSERT INTO office_beta.tasks")) {
      return { rows: [{ id: "task-1" }] };
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
        { id: "deal-1", deal_number: "D-1001", name: "Project Alpha", stage_slug: "estimating", stage_display_order: 2 },
      ],
      contactMatch: { id: "contact-1", first_name: "Brett", last_name: "Smith", company_id: "company-1" },
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
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO public.job_queue"),
      expect.arrayContaining([
        expect.stringContaining("\"sourceType\":\"email_message\""),
        "office-1",
      ])
    );
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks"))).toBe(false);
    expect(queryMock).toHaveBeenCalledWith("SELECT set_config('search_path', $1, false)", ["public"]);
    expect(queryMock).toHaveBeenCalledWith("SELECT set_config('app.current_user_id', $1, false)", [""]);
  });

  it("routes a multi-active-deal email to the disambiguation task rule", async () => {
    const queryMock = createQueryMock({
      activeDeals: [
        { id: "deal-1", deal_number: "TR-2026-0001", name: "Project Alpha", stage_slug: "estimating", stage_display_order: 2 },
        { id: "deal-2", deal_number: "TR-2026-0002", name: "Project Beta", stage_slug: "estimating", stage_display_order: 2 },
      ],
      contactMatch: { id: "contact-1", first_name: "Brett", last_name: "Smith", company_id: "company-1" },
    });
    const client = { query: queryMock };

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
    expect(evaluateTaskRulesMock).not.toHaveBeenCalled();
    expect(
      queryMock.mock.calls.some(
        ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks")
      )
    ).toBe(true);
    expect(queryMock).toHaveBeenCalledWith("SELECT set_config('search_path', $1, false)", ["public"]);
    expect(queryMock).toHaveBeenCalledWith("SELECT set_config('app.current_user_id', $1, false)", [""]);
  });

  it("routes an explicitly matched multi-deal email to the reply-needed task rule", async () => {
    const queryMock = createQueryMock({
      activeDeals: [
        { id: "deal-1", deal_number: "TR-2026-0001", name: "Project Alpha", stage_slug: "estimating", stage_display_order: 2 },
        { id: "deal-2", deal_number: "TR-2026-0002", name: "Project Beta", stage_slug: "estimating", stage_display_order: 2 },
      ],
      contactMatch: { id: "contact-1", first_name: "Brett", last_name: "Smith", company_id: "company-1" },
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
        id: "graph-5",
        from: { emailAddress: { address: "brett@example.com" } },
        toRecipients: [],
        ccRecipients: [],
        subject: "TR-2026-0002 follow-up",
        bodyPreview: "Please reply on the exact deal",
        body: { content: "<p>Please reply on the exact deal</p>" },
        hasAttachments: false,
        receivedDateTime: "2026-04-04T15:00:00.000Z",
        conversationId: "conv-5",
      }
    );

    expect(processed).toBe(true);
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-2",
        activeDealCount: 2,
        activeDealNames: ["TR-2026-0001 Project Alpha", "TR-2026-0002 Project Beta"],
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(
      queryMock.mock.calls.some(
        ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks")
      )
    ).toBe(false);
  });

  it("resolves a unique lead-stage match even when multiple active deals exist", async () => {
    const queryMock = createQueryMock({
      activeDeals: [
        { id: "deal-1", deal_number: "D-1001", name: "Project Alpha", stage_slug: "lead", stage_display_order: 1 },
        { id: "deal-2", deal_number: "D-1002", name: "Project Beta", stage_slug: "estimating", stage_display_order: 2 },
      ],
      contactMatch: { id: "contact-1", first_name: "Brett", last_name: "Smith", company_id: "company-1" },
    });
    const client = { query: queryMock };
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([]);

    const processed = await processInboundMessage(
      client,
      "office_beta",
      "user-1",
      "office-1",
      {
        id: "graph-6",
        from: { emailAddress: { address: "brett@example.com" } },
        toRecipients: [],
        ccRecipients: [],
        subject: "Project Alpha follow-up",
        bodyPreview: "Checking in on the pre-RFP work",
        body: { content: "<p>Checking in on the pre-RFP work</p>" },
        hasAttachments: false,
        receivedDateTime: "2026-04-04T16:00:00.000Z",
        conversationId: "conv-6",
      }
    );

    expect(processed).toBe(true);
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        activeDealCount: 2,
        activeDealNames: ["D-1001 Project Alpha", "D-1002 Project Beta"],
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(
      queryMock.mock.calls.some(
        ([sql, params]) =>
          typeof sql === "string" &&
          sql.includes("INSERT INTO office_beta.emails") &&
          Array.isArray(params) &&
          params[12] === "deal-1" // dealId moved 10→12 after internet_message_id + direction params were added
      )
    ).toBe(true);
    expect(
      queryMock.mock.calls.some(
        ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks")
      )
    ).toBe(false);
  });

  it("resolves a unique property match to the only related active deal", async () => {
    const queryMock = createQueryMock({
      activeDeals: [
        {
          id: "deal-1",
          deal_number: "D-1001",
          name: "Project Alpha",
          stage_slug: "estimating",
          stage_display_order: 2,
          property_address: "123 Main St",
          property_city: "Dallas",
          property_state: "TX",
          property_zip: "75201",
        },
        {
          id: "deal-2",
          deal_number: "D-1002",
          name: "Project Beta",
          stage_slug: "estimating",
          stage_display_order: 2,
          property_address: "555 Oak Ave",
          property_city: "Austin",
          property_state: "TX",
          property_zip: "73301",
        },
      ],
      contactMatch: { id: "contact-1", first_name: "Brett", last_name: "Smith", company_id: "company-1" },
    });
    const client = { query: queryMock };
    const taskPersistence = { marker: "task-persistence" };
    createTenantTaskRulePersistenceMock.mockReturnValue(taskPersistence);
    evaluateTaskRulesMock.mockResolvedValue([]);

    const processed = await processInboundMessage(
      client,
      "office_beta",
      "user-1",
      "office-1",
      {
        id: "graph-7",
        from: { emailAddress: { address: "brett@example.com" } },
        toRecipients: [],
        ccRecipients: [],
        subject: "Re: 123 Main St Dallas TX 75201",
        bodyPreview: "Following up on 123 Main St, Dallas, TX 75201",
        body: { content: "<p>Following up on 123 Main St, Dallas, TX 75201</p>" },
        hasAttachments: false,
        receivedDateTime: "2026-04-04T17:00:00.000Z",
        conversationId: "conv-7",
      }
    );

    expect(processed).toBe(true);
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        activeDealCount: 2,
        activeDealNames: ["D-1001 Project Alpha", "D-1002 Project Beta"],
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(
      queryMock.mock.calls.some(
        ([sql, params]) =>
          typeof sql === "string" &&
          sql.includes("INSERT INTO office_beta.emails") &&
          Array.isArray(params) &&
          params[12] === "deal-1" // dealId moved 10→12 after internet_message_id + direction params were added
      )
    ).toBe(true);
    expect(
      queryMock.mock.calls.some(
        ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks")
      )
    ).toBe(false);
  });

  it("routes a bound thread to the reply-needed task rule even when multiple active deals exist", async () => {
    const queryMock = createQueryMock({
      activeDeals: [
        { id: "deal-1", deal_number: "D-1001", name: "Project Alpha", stage_slug: "estimating", stage_display_order: 2 },
        { id: "deal-2", deal_number: "D-1002", name: "Project Beta", stage_slug: "estimating", stage_display_order: 2 },
      ],
      threadBinding: {
        id: "binding-1",
        deal_id: "deal-1",
      },
      contactMatch: { id: "contact-1", first_name: "Brett", last_name: "Smith", company_id: "company-1" },
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
        id: "graph-4",
        from: { emailAddress: { address: "brett@example.com" } },
        toRecipients: [],
        ccRecipients: [],
        subject: "Re: Project Alpha",
        bodyPreview: "Still following up",
        body: { content: "<p>Still following up</p>" },
        hasAttachments: false,
        receivedDateTime: "2026-04-04T15:00:00.000Z",
        conversationId: "conv-4",
      }
    );

    expect(processed).toBe(true);
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        activeDealCount: 2,
        activeDealNames: ["D-1001 Project Alpha", "D-1002 Project Beta"],
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(
      queryMock.mock.calls.some(
        ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks")
      )
    ).toBe(false);
  });

  it("routes a bound thread to the reply-needed task rule even without a matched contact", async () => {
    const queryMock = createQueryMock({
      activeDeals: [
        { id: "deal-1", deal_number: "D-1001", name: "Project Alpha", stage_slug: "estimating", stage_display_order: 2 },
        { id: "deal-2", deal_number: "D-1002", name: "Project Beta", stage_slug: "estimating", stage_display_order: 2 },
      ],
      threadBinding: {
        id: "binding-3",
        deal_id: "deal-1",
      },
      contactMatch: null,
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
        id: "graph-8",
        from: { emailAddress: { address: "unknown.sender@example.com" } },
        toRecipients: [],
        ccRecipients: [],
        subject: "Re: Project Alpha",
        bodyPreview: "Bound thread without contact match",
        body: { content: "<p>Bound thread without contact match</p>" },
        hasAttachments: false,
        receivedDateTime: "2026-04-04T18:00:00.000Z",
        conversationId: "conv-8",
      }
    );

    expect(processed).toBe(true);
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        contactId: null,
        emailId: "email-1",
        contactName: "unknown.sender@example.com",
        activeDealCount: 0,
        activeDealNames: [],
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(
      queryMock.mock.calls.some(
        ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks")
      )
    ).toBe(false);
  });

  it("keeps the bound thread deal when the conversation was already classified", async () => {
    const queryMock = createQueryMock({
      activeDeals: [
        { id: "deal-2", deal_number: "D-1002", name: "Project Beta", stage_slug: "estimating", stage_display_order: 2 },
      ],
      threadBinding: {
        id: "binding-2",
        deal_id: "deal-2",
      },
      contactMatch: { id: "contact-1", first_name: "Brett", last_name: "Smith", company_id: "company-1" },
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
        id: "graph-3",
        from: { emailAddress: { address: "brett@example.com" } },
        toRecipients: [],
        ccRecipients: [],
        subject: "Re: Project Beta",
        bodyPreview: "Following up on the thread",
        body: { content: "<p>Following up on the thread</p>" },
        hasAttachments: false,
        receivedDateTime: "2026-04-04T15:00:00.000Z",
        conversationId: "conv-3",
      }
    );

    expect(processed).toBe(true);
    expect(evaluateTaskRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-2",
        emailId: "email-1",
        activeDealCount: 1,
        activeDealNames: ["D-1002 Project Beta"],
      }),
      taskPersistence,
      expect.any(Array)
    );
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks"))).toBe(false);
  });

  it("stores unresolved inbound mail against the mailbox and creates a classification task when no contact matches", async () => {
    const queryMock = createQueryMock({
      activeDeals: [],
      contactMatch: null,
    });
    const client = { query: queryMock };

    const processed = await processInboundMessage(
      client,
      "office_beta",
      "user-1",
      "office-1",
      {
        id: "graph-8",
        from: { emailAddress: { address: "unknown@example.com" } },
        toRecipients: [],
        ccRecipients: [],
        subject: "Unmatched inbound",
        bodyPreview: "Please classify this thread",
        body: { content: "<p>Please classify this thread</p>" },
        hasAttachments: false,
        receivedDateTime: "2026-04-04T18:00:00.000Z",
        conversationId: "conv-8",
      }
    );

    expect(processed).toBe(true);
    expect(evaluateTaskRulesMock).not.toHaveBeenCalled();
    expect(
      queryMock.mock.calls.some(
        ([sql, params]) =>
          typeof sql === "string" &&
          sql.includes("INSERT INTO office_beta.activities") &&
          Array.isArray(params) &&
          params[1] === "mailbox"
      )
    ).toBe(false);
    expect(
      queryMock.mock.calls.some(
        ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.tasks")
      )
    ).toBe(true);
  });

  // A "reply needed" task on a Won or Lost deal is the single biggest source of task debris in prod: 1,977
  // of the 3,395 open tasks sitting on closed deals were inbound_email_reply_needed, 56 of them minted in
  // the last 7 days. The email itself is NOT the problem — a message about a closed job belongs on that
  // job's timeline — so both halves are asserted here: the task is suppressed AND the storage, the deal
  // association, the activity row and the stat refresh all still happen.
  describe("an inbound email on a CLOSED deal", () => {
    const closedDealMsg = {
      id: "graph-terminal-1",
      subject: "Invoice question on the finished job",
      from: { emailAddress: { address: "pat@alpha.example" } },
      toRecipients: [{ emailAddress: { address: "rep@trockgc.com" } }],
      body: { content: "<p>One more thing about the job you wrapped up.</p>" },
      hasAttachments: false,
      receivedDateTime: "2026-09-12T18:00:00.000Z",
      conversationId: "conv-terminal-1",
    };
    const oneDeal = [
      { id: "deal-9", deal_number: "DFW-4-22226-ag", name: "Won Job", company_id: "company-1", stage_slug: "won", stage_display_order: 9 },
    ];
    const contact = { id: "contact-1", first_name: "Pat", last_name: "Rivera", company_id: "company-1" };

    it("mints no reply-needed task, while still storing and associating the email", async () => {
      const queryMock = createQueryMock({ activeDeals: oneDeal, contactMatch: contact, dealIsTerminal: true });
      const processed = await processInboundMessage(
        { query: queryMock } as any, "office_beta", "user-1", "office-1", closedDealMsg
      );

      expect(processed).toBe(true);
      // Suppressed: no rule evaluation at all, so no inbound_email_reply_needed task.
      expect(evaluateTaskRulesMock).not.toHaveBeenCalled();
      // Preserved: the email row, the deal-linked activity, and the deal's email stats.
      const ranSql = (needle: string) =>
        queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes(needle));
      expect(ranSql("INSERT INTO office_beta.emails")).toBe(true);
      expect(ranSql("INSERT INTO office_beta.activities")).toBe(true);
      const activityCall = queryMock.mock.calls.find(
        ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.activities")
      );
      // params: [responsible, performedBy, sourceEntityType, sourceEntityId, dealId, ...]
      expect((activityCall?.[1] as unknown[])?.[2]).toBe("deal");
      expect((activityCall?.[1] as unknown[])?.[4]).toBe("deal-9");
    });

    // The deal-parent lookup that now also reports is_terminal feeds the activity's company/property/lead
    // link columns. It must therefore stay a LEFT JOIN: a deal whose stage_id is null or dangling has to
    // keep returning its row, or adding a flag would silently strip those links. A stubbed query cannot
    // tell a JOIN from a LEFT JOIN, so this case takes the SQL the job actually issued and EXECUTES it.
    it("keeps the deal's link columns for a STAGELESS deal (the lookup is a LEFT JOIN)", async () => {
      const queryMock = createQueryMock({ activeDeals: oneDeal, contactMatch: contact, dealIsTerminal: true });
      await processInboundMessage({ query: queryMock } as any, "office_beta", "user-1", "office-1", closedDealMsg);

      const issued = queryMock.mock.calls
        .map(([sql]) => sql)
        .filter((sql): sql is string => typeof sql === "string" && sql.includes("COALESCE(psc.is_terminal, false)"));
      expect(issued).toHaveLength(1);

      const db = new PGlite();
      await db.exec(`
        CREATE SCHEMA office_beta;
        CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, is_terminal boolean NOT NULL DEFAULT false);
        CREATE TABLE office_beta.deals (
          id uuid PRIMARY KEY, company_id uuid, property_id uuid, source_lead_id uuid, stage_id uuid
        );
        INSERT INTO public.pipeline_stage_config (id, is_terminal)
          VALUES ('00000000-0000-4000-8000-0000000050e1', true);
        INSERT INTO office_beta.deals (id, company_id, property_id, source_lead_id, stage_id) VALUES
          ('00000000-0000-4000-8000-00000000d001',
           '00000000-0000-4000-8000-0000000c0001',
           '00000000-0000-4000-8000-0000000b0001',
           '00000000-0000-4000-8000-0000000e0001', NULL);
      `);

      const { rows } = await db.query<{
        company_id: string | null;
        source_lead_id: string | null;
        is_terminal: boolean;
      }>(issued[0], ["00000000-0000-4000-8000-00000000d001"]);

      // The row survives, its parent links are intact, and an unresolvable stage reads as "not closed" —
      // i.e. exactly the behaviour this call site had before is_terminal was added.
      expect(rows).toHaveLength(1);
      expect(rows[0].company_id).toBe("00000000-0000-4000-8000-0000000c0001");
      expect(rows[0].source_lead_id).toBe("00000000-0000-4000-8000-0000000e0001");
      expect(rows[0].is_terminal).toBe(false);
    });

    it("CONTROL — the same email on an OPEN deal still evaluates the reply rule", async () => {
      const queryMock = createQueryMock({ activeDeals: oneDeal, contactMatch: contact, dealIsTerminal: false });
      const processed = await processInboundMessage(
        { query: queryMock } as any, "office_beta", "user-1", "office-1", closedDealMsg
      );

      expect(processed).toBe(true);
      expect(evaluateTaskRulesMock).toHaveBeenCalledTimes(1);
      expect(evaluateTaskRulesMock.mock.calls[0][0]).toMatchObject({
        sourceEvent: "email.received",
        dealId: "deal-9",
      });
    });
  });
});
