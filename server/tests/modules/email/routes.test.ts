import { beforeEach, describe, expect, it, vi } from "vitest";

const emailServiceMocks = vi.hoisted(() => ({
  getEmailAssignmentQueue: vi.fn(),
  getEmailById: vi.fn(),
  getEmailThread: vi.fn(),
  getEmailThreadForMutation: vi.fn(),
  getEmails: vi.fn(),
  getUserEmails: vi.fn(),
  sendEmail: vi.fn(),
  associateEmailToEntity: vi.fn(),
  ignoreEmailAssignment: vi.fn(),
  unignoreEmailAssignment: vi.fn(),
  updateEmailInboxAction: vi.fn(),
  bindThreadToDeal: vi.fn(),
  detachThreadByConversation: vi.fn(),
  previewThreadReassignmentImpact: vi.fn(),
  assertCanMutateEmailThread: vi.fn(),
}));

const dealServiceMocks = vi.hoisted(() => ({
  getDealById: vi.fn(),
}));

const leadServiceMocks = vi.hoisted(() => ({
  getLeadById: vi.fn(),
}));

const companyServiceMocks = vi.hoisted(() => ({
  getCompanyById: vi.fn(),
}));

const contactServiceMocks = vi.hoisted(() => ({
  getContactById: vi.fn(),
}));

const propertyServiceMocks = vi.hoisted(() => ({
  getPropertyDetail: vi.fn(),
}));

vi.mock("../../../src/modules/email/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/email/service.js")>(
    "../../../src/modules/email/service.js"
  );

  return {
    ...actual,
    getEmailAssignmentQueue: emailServiceMocks.getEmailAssignmentQueue,
    getEmailById: emailServiceMocks.getEmailById,
    getEmailThread: emailServiceMocks.getEmailThread,
    getEmailThreadForMutation: emailServiceMocks.getEmailThreadForMutation,
    getEmails: emailServiceMocks.getEmails,
    getUserEmails: emailServiceMocks.getUserEmails,
    sendEmail: emailServiceMocks.sendEmail,
    associateEmailToEntity: emailServiceMocks.associateEmailToEntity,
    ignoreEmailAssignment: emailServiceMocks.ignoreEmailAssignment,
    unignoreEmailAssignment: emailServiceMocks.unignoreEmailAssignment,
    updateEmailInboxAction: emailServiceMocks.updateEmailInboxAction,
    bindThreadToDeal: emailServiceMocks.bindThreadToDeal,
    detachThreadByConversation: emailServiceMocks.detachThreadByConversation,
    previewThreadReassignmentImpact: emailServiceMocks.previewThreadReassignmentImpact,
    assertCanMutateEmailThread: emailServiceMocks.assertCanMutateEmailThread,
  };
});

vi.mock("../../../src/modules/deals/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/deals/service.js")>(
    "../../../src/modules/deals/service.js"
  );

  return {
    ...actual,
    getDealById: dealServiceMocks.getDealById,
  };
});

vi.mock("../../../src/modules/leads/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/leads/service.js")>(
    "../../../src/modules/leads/service.js"
  );

  return {
    ...actual,
    getLeadById: leadServiceMocks.getLeadById,
  };
});

vi.mock("../../../src/modules/companies/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/companies/service.js")>(
    "../../../src/modules/companies/service.js"
  );

  return {
    ...actual,
    getCompanyById: companyServiceMocks.getCompanyById,
  };
});

vi.mock("../../../src/modules/contacts/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/contacts/service.js")>(
    "../../../src/modules/contacts/service.js"
  );

  return {
    ...actual,
    getContactById: contactServiceMocks.getContactById,
  };
});

vi.mock("../../../src/modules/properties/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/properties/service.js")>(
    "../../../src/modules/properties/service.js"
  );

  return {
    ...actual,
    getPropertyDetail: propertyServiceMocks.getPropertyDetail,
  };
});

const { emailRoutes } = await import("../../../src/modules/email/routes.js");

type TestUser = {
  id: string;
  role: "admin" | "director" | "rep";
  displayName: string;
  email: string;
  officeId: string;
  activeOfficeId: string;
};

function makeResponse() {
  const res: Record<string, any> & { _resolve?: () => void } = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      res._resolve?.();
      return res;
    },
  };

  return res;
}

function findRouteHandler(method: "get" | "post" | "patch", routePath: string) {
  const layer = (emailRoutes as any).stack.find(
    (entry: any) => entry.route?.path === routePath && entry.route?.methods?.[method]
  );

  if (!layer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
  }

  return layer.route.stack[0].handle as (req: any, res: any, next: (err?: unknown) => void) => unknown;
}

async function invokeRoute({
  method,
  url,
  user,
  query = {},
  body = {},
  tenantDb = {},
}: {
  method: "get" | "post" | "patch";
  url: string;
  user: TestUser;
  query?: Record<string, any>;
  body?: Record<string, any>;
  tenantDb?: Record<string, any>;
}) {
  const routePath =
    url === "/"
      ? "/"
      : url === "/send"
      ? "/send"
      : url === "/assignment-queue"
      ? "/assignment-queue"
      : url.startsWith("/company/")
        ? "/company/:companyId"
      : url.startsWith("/contact/")
        ? "/contact/:contactId"
      : url.startsWith("/deal/")
        ? "/deal/:dealId"
      : url.startsWith("/lead/")
        ? "/lead/:leadId"
      : url.startsWith("/") && url.endsWith("/actions")
      ? "/:id/actions"
      : url.startsWith("/") && url.endsWith("/ignore")
        ? "/:id/ignore"
      : url.startsWith("/") && url.endsWith("/un-ignore")
        ? "/:id/un-ignore"
      : url.startsWith("/thread/") && url.endsWith("/assign")
        ? "/thread/:conversationId/assign"
        : url.startsWith("/thread/") && url.endsWith("/reassign")
          ? "/thread/:conversationId/reassign"
          : url.startsWith("/thread/") && url.endsWith("/detach")
          ? "/thread/:conversationId/detach"
          : url.startsWith("/thread/")
              ? "/thread/:conversationId"
              : url === "/send"
                ? "/send"
                : method === "get"
                ? "/:id"
                : "/:id/associate";
  const handler = findRouteHandler(method, routePath);
  const req: Record<string, any> = {
    method: method.toUpperCase(),
    url,
    originalUrl: `/api/email${url}`,
    baseUrl: "/api/email",
    path: url,
    query,
    body,
    params:
      routePath === "/:id/associate" ||
        routePath === "/:id/actions" ||
        routePath === "/:id/ignore" ||
        routePath === "/:id/un-ignore" ||
        routePath === "/:id"
        ? { id: url.split("/")[1] }
        : routePath === "/company/:companyId"
          ? { companyId: url.split("/")[2] }
          : routePath === "/contact/:contactId"
            ? { contactId: url.split("/")[2] }
            : routePath === "/deal/:dealId"
              ? { dealId: url.split("/")[2] }
              : routePath === "/lead/:leadId"
                ? { leadId: url.split("/")[2] }
        : routePath.startsWith("/thread/:conversationId")
          ? { conversationId: url.split("/")[2] }
          : {},
    user,
    tenantDb,
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    headers: {},
  };
  const res = makeResponse();

  await new Promise<void>((resolve, reject) => {
    res._resolve = resolve;
    Promise.resolve(handler(req as any, res as any, (err?: any) => {
      if (err) {
        reject(err);
        return;
      }
    })).catch(reject);
  });

  return { req, res };
}

function makeDirectorUser(overrides: Partial<TestUser> = {}): TestUser {
  return {
    id: "director-1",
    role: "director",
    displayName: "Director One",
    email: "director@example.com",
    officeId: "office-1",
    activeOfficeId: "office-1",
    ...overrides,
  };
}

function makeAdminUser(overrides: Partial<TestUser> = {}): TestUser {
  return {
    id: "admin-1",
    role: "admin",
    displayName: "Admin One",
    email: "admin@example.com",
    officeId: "office-1",
    activeOfficeId: "office-1",
    ...overrides,
  };
}

function makeRepUser(overrides: Partial<TestUser> = {}): TestUser {
  return {
    id: "rep-1",
    role: "rep",
    displayName: "Rep One",
    email: "rep@example.com",
    officeId: "office-1",
    activeOfficeId: "office-1",
    ...overrides,
  };
}

describe("email routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emailServiceMocks.assertCanMutateEmailThread.mockResolvedValue(undefined);
  });

  it("rejects invalid assignment queue pagination params with 400s", async () => {
    await expect(
      invokeRoute({
        method: "get",
        url: "/assignment-queue",
        user: makeDirectorUser(),
        query: { limit: "foo" },
      })
    ).rejects.toThrow("Invalid limit query parameter");

    await expect(
      invokeRoute({
        method: "get",
        url: "/assignment-queue",
        user: makeDirectorUser(),
        query: { page: "abc" },
      })
    ).rejects.toThrow("Invalid page query parameter");

    expect(emailServiceMocks.getEmailAssignmentQueue).not.toHaveBeenCalled();
  });

  it("routes outbound compose sends with an explicit deal association", async () => {
    dealServiceMocks.getDealById.mockResolvedValue({ id: "deal-1" });
    emailServiceMocks.sendEmail.mockResolvedValue({ id: "email-1" });
    const tenantDb = {
      insert: vi.fn(() => ({
        values: vi.fn(async () => undefined),
      })),
    };

    const { req, res } = await invokeRoute({
      method: "post",
      url: "/send",
      user: makeDirectorUser(),
      tenantDb,
      body: {
        to: ["client@example.com"],
        subject: "Deal follow up",
        bodyHtml: "<p>Hello</p>",
        assignedEntityType: "deal",
        assignedEntityId: "deal-1",
      },
    });

    expect(dealServiceMocks.getDealById).toHaveBeenCalledWith(expect.any(Object), "deal-1", "director", "director-1");
    expect(emailServiceMocks.sendEmail).toHaveBeenCalledWith(
      expect.any(Object),
      "director-1",
      expect.objectContaining({
        to: ["client@example.com"],
        subject: "Deal follow up",
        assignedEntityType: "deal",
        assignedEntityId: "deal-1",
        assignedDealId: "deal-1",
        dealId: "deal-1",
      })
    );
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
  });

  it("routes outbound compose sends with explicit company, contact, and lead associations", async () => {
    companyServiceMocks.getCompanyById.mockResolvedValue({ id: "company-1" });
    contactServiceMocks.getContactById.mockResolvedValue({ id: "contact-1", companyId: "company-1" });
    leadServiceMocks.getLeadById.mockResolvedValue({ id: "lead-1" });
    emailServiceMocks.sendEmail.mockResolvedValue({ id: "email-1" });
    const tenantDb = {
      insert: vi.fn(() => ({
        values: vi.fn(async () => undefined),
      })),
    };

    await invokeRoute({
      method: "post",
      url: "/send",
      user: makeRepUser(),
      tenantDb,
      body: {
        to: ["client@example.com"],
        subject: "Company follow up",
        bodyHtml: "<p>Hello</p>",
        assignedEntityType: "company",
        assignedEntityId: "company-1",
      },
    });

    expect(companyServiceMocks.getCompanyById).toHaveBeenCalledWith(expect.any(Object), "company-1");
    expect(emailServiceMocks.sendEmail).toHaveBeenCalledWith(
      expect.any(Object),
      "rep-1",
      expect.objectContaining({
        assignedEntityType: "company",
        assignedEntityId: "company-1",
        dealId: null,
        contactId: null,
      })
    );

    await invokeRoute({
      method: "post",
      url: "/send",
      user: makeRepUser(),
      tenantDb,
      body: {
        to: ["client@example.com"],
        subject: "Contact follow up",
        bodyHtml: "<p>Hello</p>",
        assignedEntityType: "contact",
        assignedEntityId: "contact-1",
      },
    });

    expect(contactServiceMocks.getContactById).toHaveBeenCalledWith(expect.any(Object), "contact-1");
    expect(emailServiceMocks.sendEmail).toHaveBeenCalledWith(
      expect.any(Object),
      "rep-1",
      expect.objectContaining({
        assignedEntityType: "contact",
        assignedEntityId: "contact-1",
        contactId: "contact-1",
        dealId: null,
      })
    );

    await invokeRoute({
      method: "post",
      url: "/send",
      user: makeRepUser(),
      tenantDb,
      body: {
        to: ["client@example.com"],
        subject: "Lead follow up",
        bodyHtml: "<p>Hello</p>",
        assignedEntityType: "lead",
        assignedEntityId: "lead-1",
      },
    });

    expect(leadServiceMocks.getLeadById).toHaveBeenCalledWith(expect.any(Object), "lead-1", "rep", "rep-1");
    expect(emailServiceMocks.sendEmail).toHaveBeenCalledWith(
      expect.any(Object),
      "rep-1",
      expect.objectContaining({
        assignedEntityType: "lead",
        assignedEntityId: "lead-1",
        dealId: null,
        contactId: null,
      })
    );
  });

  it("rejects out-of-bounds assignment queue pagination params with 400s", async () => {
    await expect(
      invokeRoute({
        method: "get",
        url: "/assignment-queue",
        user: makeDirectorUser(),
        query: { page: "0" },
      })
    ).rejects.toThrow("Invalid page query parameter");

    await expect(
      invokeRoute({
        method: "get",
        url: "/assignment-queue",
        user: makeDirectorUser(),
        query: { limit: "101" },
      })
    ).rejects.toThrow("Invalid limit query parameter");
  });

  it("forwards assignment queue filters to the service", async () => {
    emailServiceMocks.getEmailAssignmentQueue.mockResolvedValue({
      items: [],
      pagination: { page: 1, limit: 25, total: 0, totalPages: 0 },
    });

    const { req, res } = await invokeRoute({
      method: "get",
      url: "/assignment-queue",
      user: makeDirectorUser(),
      query: { search: "alpha", status: "ignored", page: "2", limit: "10" },
    });

    expect(emailServiceMocks.getEmailAssignmentQueue).toHaveBeenCalledWith(
      expect.any(Object),
      { search: "alpha", status: "ignored", page: 2, limit: 10 },
      "director-1",
      "director"
    );
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body).toEqual({ items: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 0 } });
  });

  it("rejects invalid entity-email pagination params with 400s", async () => {
    dealServiceMocks.getDealById.mockResolvedValue({ id: "deal-1", sourceLeadId: null });
    companyServiceMocks.getCompanyById.mockResolvedValue({ id: "company-1" });
    leadServiceMocks.getLeadById.mockResolvedValue({ id: "lead-1" });
    contactServiceMocks.getContactById.mockResolvedValue({ id: "contact-1", companyId: "company-1" });

    await expect(
      invokeRoute({
        method: "get",
        url: "/deal/deal-1",
        user: makeDirectorUser(),
        query: { limit: "foo" },
      })
    ).rejects.toThrow("Invalid limit query parameter");

    await expect(
      invokeRoute({
        method: "get",
        url: "/deal/deal-1",
        user: makeDirectorUser(),
        query: { page: "abc" },
      })
    ).rejects.toThrow("Invalid page query parameter");

    await expect(
      invokeRoute({
        method: "get",
        url: "/company/company-1",
        user: makeDirectorUser(),
        query: { limit: "foo" },
      })
    ).rejects.toThrow("Invalid limit query parameter");

    await expect(
      invokeRoute({
        method: "get",
        url: "/lead/lead-1",
        user: makeDirectorUser(),
        query: { page: "abc" },
      })
    ).rejects.toThrow("Invalid page query parameter");

    await expect(
      invokeRoute({
        method: "get",
        url: "/contact/contact-1",
        user: makeDirectorUser(),
        query: { page: "abc" },
      })
    ).rejects.toThrow("Invalid page query parameter");

    expect(emailServiceMocks.getEmails).not.toHaveBeenCalled();
  });

  it("rejects invalid inbox pagination params with 400s", async () => {
    await expect(
      invokeRoute({
        method: "get",
        url: "/",
        user: makeRepUser(),
        query: { page: "0" },
      })
    ).rejects.toThrow("Invalid page query parameter");

    await expect(
      invokeRoute({
        method: "get",
        url: "/",
        user: makeRepUser(),
        query: { limit: "101" },
      })
    ).rejects.toThrow("Invalid limit query parameter");

    expect(emailServiceMocks.getUserEmails).not.toHaveBeenCalled();
  });

  it("forwards valid entity-email pagination params to the service", async () => {
    dealServiceMocks.getDealById.mockResolvedValue({ id: "deal-1", sourceLeadId: null });
    emailServiceMocks.getEmails.mockResolvedValue({
      emails: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
    });

    await invokeRoute({
      method: "get",
      url: "/deal/deal-1",
      user: makeDirectorUser(),
      query: { limit: "10" },
    });

    expect(emailServiceMocks.getEmails).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ dealId: "deal-1", limit: 10 }),
      undefined,
      "director"
    );
  });

  it("forwards inbox filters to getUserEmails for server-side filtering before pagination", async () => {
    emailServiceMocks.getUserEmails.mockResolvedValue({
      emails: [],
      pagination: { page: 2, limit: 25, total: 0, totalPages: 0 },
      counts: { all: 10, unread: 2, unassigned: 2, sent: 3, linked: 8, today: 1 },
    });

    const { req, res } = await invokeRoute({
      method: "get",
      url: "/",
      user: makeRepUser(),
      query: { filter: "unassigned", search: "school", page: "2", limit: "25" },
    });

    expect(emailServiceMocks.getUserEmails).toHaveBeenCalledWith(
      expect.any(Object),
      "rep-1",
      {
        direction: undefined,
        filter: "unassigned",
        search: "school",
        page: 2,
        limit: 25,
      }
    );
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body.counts.unassigned).toBe(2);
  });

  it("routes reader actions through the inbox action service", async () => {
    emailServiceMocks.updateEmailInboxAction.mockResolvedValue({
      id: "email-1",
      isStarred: true,
    });

    const { req, res } = await invokeRoute({
      method: "patch",
      url: "/email-1/actions",
      user: makeRepUser(),
      body: { isStarred: true },
    });

    expect(emailServiceMocks.updateEmailInboxAction).toHaveBeenCalledWith(
      expect.any(Object),
      "email-1",
      "rep-1",
      "rep",
      { isStarred: true, archived: undefined, deleted: undefined }
    );
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body.email).toEqual({ id: "email-1", isStarred: true });
  });

  it("routes ignore and un-ignore actions through the assignment status services", async () => {
    emailServiceMocks.ignoreEmailAssignment.mockResolvedValue({ id: "email-1", assignmentStatus: "ignored" });
    emailServiceMocks.unignoreEmailAssignment.mockResolvedValue({ id: "email-1", assignmentStatus: "unassigned" });

    const ignored = await invokeRoute({
      method: "post",
      url: "/email-1/ignore",
      user: makeRepUser(),
    });

    expect(emailServiceMocks.ignoreEmailAssignment).toHaveBeenCalledWith(
      expect.any(Object),
      "email-1",
      "rep-1",
      "rep"
    );
    expect(ignored.req.commitTransaction).toHaveBeenCalled();
    expect(ignored.res.body).toEqual({ email: { id: "email-1", assignmentStatus: "ignored" } });

    const unignored = await invokeRoute({
      method: "post",
      url: "/email-1/un-ignore",
      user: makeRepUser(),
    });

    expect(emailServiceMocks.unignoreEmailAssignment).toHaveBeenCalledWith(
      expect.any(Object),
      "email-1",
      "rep-1",
      "rep"
    );
    expect(unignored.req.commitTransaction).toHaveBeenCalled();
    expect(unignored.res.body).toEqual({ email: { id: "email-1", assignmentStatus: "unassigned" } });
  });

  it("returns company-linked emails after company existence passes", async () => {
    const tenantDb = {};
    companyServiceMocks.getCompanyById.mockResolvedValue({ id: "company-1", name: "Alpha Roofing" });
    emailServiceMocks.getEmails.mockResolvedValue({
      emails: [{ id: "email-1" }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    const { req, res } = await invokeRoute({
      method: "get",
      url: "/company/company-1",
      user: makeDirectorUser(),
      tenantDb,
    });

    expect(companyServiceMocks.getCompanyById).toHaveBeenCalledWith(tenantDb, "company-1");
    expect(emailServiceMocks.getEmails).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ companyId: "company-1" }),
      undefined,
      "director"
    );
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body).toEqual({
      emails: [{ id: "email-1" }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
  });

  it("verifies contact existence before returning contact-linked emails", async () => {
    const tenantDb = {};
    contactServiceMocks.getContactById.mockResolvedValue({
      id: "contact-1",
      companyId: "company-1",
    });
    emailServiceMocks.getEmails.mockResolvedValue({
      emails: [{ id: "email-1" }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    await invokeRoute({
      method: "get",
      url: "/contact/contact-1",
      user: makeDirectorUser(),
      tenantDb,
    });

    expect(contactServiceMocks.getContactById).toHaveBeenCalledWith(tenantDb, "contact-1");
    expect(emailServiceMocks.getEmails).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ contactId: "contact-1" }),
      undefined,
      "director"
    );
  });

  it("returns deal-linked emails without mailbox-owner scoping after deal access passes", async () => {
    const tenantDb = {};
    dealServiceMocks.getDealById.mockResolvedValue({ id: "deal-1", sourceLeadId: "lead-1" });
    emailServiceMocks.getEmails.mockResolvedValue({
      emails: [{ id: "email-1", userId: "rep-2" }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    await invokeRoute({
      method: "get",
      url: "/deal/deal-1",
      user: makeRepUser(),
      tenantDb,
    });

    expect(dealServiceMocks.getDealById).toHaveBeenCalledWith(tenantDb, "deal-1", "rep", "rep-1");
    expect(emailServiceMocks.getEmails).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ dealId: "deal-1", leadId: "lead-1" }),
      undefined,
      "rep"
    );
  });

  it("returns lead-linked emails without mailbox-owner scoping after lead access passes", async () => {
    const tenantDb = {};
    leadServiceMocks.getLeadById.mockResolvedValue({ id: "lead-1" });
    emailServiceMocks.getEmails.mockResolvedValue({
      emails: [{ id: "email-1", userId: "rep-2" }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    await invokeRoute({
      method: "get",
      url: "/lead/lead-1",
      user: makeDirectorUser(),
      tenantDb,
    });

    expect(leadServiceMocks.getLeadById).toHaveBeenCalledWith(tenantDb, "lead-1", "director", "director-1");
    expect(emailServiceMocks.getEmails).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ leadId: "lead-1" }),
      undefined,
      "director"
    );
  });

  it("blocks reps from opening another user's email even when the deal is visible", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({
      id: "email-1",
      userId: "admin-1",
      dealId: "deal-1",
      assignedEntityType: null,
      assignedEntityId: null,
    });
    dealServiceMocks.getDealById.mockResolvedValue({ id: "deal-1" });

    await expect(
      invokeRoute({
        method: "get",
        url: "/email-1",
        user: makeRepUser(),
      })
    ).rejects.toThrow("You do not have permission to view this email");

    expect(dealServiceMocks.getDealById).not.toHaveBeenCalled();
  });

  it("allows viewing another user's email when it is assigned to an accessible deal", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({
      id: "email-1",
      userId: "rep-2",
      dealId: "deal-1",
      assignedEntityType: "deal",
      assignedEntityId: "deal-1",
    });
    dealServiceMocks.getDealById.mockResolvedValue({ id: "deal-1" });

    const { res } = await invokeRoute({
      method: "get",
      url: "/email-1",
      user: makeRepUser(),
    });

    expect(dealServiceMocks.getDealById).toHaveBeenCalledWith(expect.any(Object), "deal-1", "rep", "rep-1");
    expect(res.body).toEqual({
      email: expect.objectContaining({ id: "email-1", assignedEntityType: "deal", assignedEntityId: "deal-1" }),
    });
  });

  it("allows viewing another user's email when it is assigned to an accessible company", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({
      id: "email-1",
      userId: "rep-2",
      dealId: null,
      assignedEntityType: "company",
      assignedEntityId: "company-1",
    });
    companyServiceMocks.getCompanyById.mockResolvedValue({ id: "company-1", name: "Alpha Roofing" });

    const { res } = await invokeRoute({
      method: "get",
      url: "/email-1",
      user: makeRepUser(),
    });

    expect(companyServiceMocks.getCompanyById).toHaveBeenCalledWith(expect.any(Object), "company-1");
    expect(res.body).toEqual({
      email: expect.objectContaining({ id: "email-1", assignedEntityType: "company", assignedEntityId: "company-1" }),
    });
  });

  it("allows viewing another user's email when it is assigned to an accessible contact", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({
      id: "email-1",
      userId: "rep-2",
      dealId: null,
      assignedEntityType: "contact",
      assignedEntityId: "contact-1",
    });
    contactServiceMocks.getContactById.mockResolvedValue({ id: "contact-1", companyId: "company-1" });

    const { res } = await invokeRoute({
      method: "get",
      url: "/email-1",
      user: makeRepUser(),
    });

    expect(contactServiceMocks.getContactById).toHaveBeenCalledWith(expect.any(Object), "contact-1");
    expect(res.body).toEqual({
      email: expect.objectContaining({ id: "email-1", assignedEntityType: "contact", assignedEntityId: "contact-1" }),
    });
  });

  it("blocks viewing another user's email when the assigned deal is not accessible", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({
      id: "email-1",
      userId: "rep-2",
      dealId: "deal-1",
      assignedEntityType: "deal",
      assignedEntityId: "deal-1",
    });
    dealServiceMocks.getDealById.mockResolvedValue(null);

    await expect(
      invokeRoute({
        method: "get",
        url: "/email-1",
        user: makeRepUser(),
      })
    ).rejects.toThrow("You do not have permission to view this email");
  });

  it("blocks viewing another user's email when it is only assigned to a property", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({
      id: "email-1",
      userId: "rep-2",
      dealId: null,
      assignedEntityType: "property",
      assignedEntityId: "property-1",
    });

    await expect(
      invokeRoute({
        method: "get",
        url: "/email-1",
        user: makeRepUser(),
      })
    ).rejects.toThrow("You do not have permission to view this email");

    expect(propertyServiceMocks.getPropertyDetail).not.toHaveBeenCalled();
  });

  it("blocks viewing another user's ignored shared email by id", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({
      id: "email-1",
      userId: "rep-2",
      dealId: "deal-1",
      assignedEntityType: "deal",
      assignedEntityId: "deal-1",
      assignmentStatus: "ignored",
      archivedAt: null,
      deletedAt: null,
    });

    await expect(
      invokeRoute({
        method: "get",
        url: "/email-1",
        user: makeRepUser(),
      })
    ).rejects.toThrow("You do not have permission to view this email");

    expect(dealServiceMocks.getDealById).not.toHaveBeenCalled();
  });

  it("blocks directors from opening another user's email", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({
      id: "email-1",
      userId: "rep-2",
      dealId: "deal-1",
      assignedEntityType: null,
      assignedEntityId: null,
    });

    await expect(
      invokeRoute({
        method: "get",
        url: "/email-1",
        user: makeDirectorUser(),
      })
    ).rejects.toThrow("You do not have permission to view this email");
  });

  it("blocks admins from opening another user's email", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({
      id: "email-1",
      userId: "rep-2",
      dealId: null,
      assignedEntityType: null,
      assignedEntityId: null,
    });

    await expect(
      invokeRoute({
        method: "get",
        url: "/email-1",
        user: makeAdminUser(),
      })
    ).rejects.toThrow("You do not have permission to view this email");
  });

  it("routes manual deal association through the generic entity resolver", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "director-1" });
    dealServiceMocks.getDealById.mockResolvedValue({ id: "deal-1" });

    const { req, res } = await invokeRoute({
      method: "post",
      url: "/email-1/associate",
      user: makeDirectorUser(),
      body: { dealId: "deal-1" },
    });

    expect(dealServiceMocks.getDealById).toHaveBeenCalledWith(expect.any(Object), "deal-1", "director", "director-1");
    expect(emailServiceMocks.associateEmailToEntity).toHaveBeenCalledWith(
      expect.any(Object),
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
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body).toEqual({ success: true });
  });

  it("returns 403 when a director tries to assign another user's email", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "rep-2" });

    await expect(
      invokeRoute({
        method: "post",
        url: "/email-1/associate",
        user: makeDirectorUser(),
        body: { dealId: "deal-1" },
      })
    ).rejects.toThrow("You do not have permission to modify this email");

    expect(emailServiceMocks.associateEmailToEntity).not.toHaveBeenCalled();
    expect(dealServiceMocks.getDealById).not.toHaveBeenCalled();
  });

  it("routes manual lead association through the generic entity resolver", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "director-1" });
    leadServiceMocks.getLeadById.mockResolvedValue({ id: "lead-1" });

    const { req, res } = await invokeRoute({
      method: "post",
      url: "/email-1/associate",
      user: makeDirectorUser(),
      body: { assignedEntityType: "lead", assignedEntityId: "lead-1" },
    });

    expect(leadServiceMocks.getLeadById).toHaveBeenCalledWith(expect.any(Object), "lead-1", "director", "director-1");
    expect(emailServiceMocks.associateEmailToEntity).toHaveBeenCalledWith(
      expect.any(Object),
      "email-1",
      {
        assignedEntityType: "lead",
        assignedEntityId: "lead-1",
        assignedDealId: null,
      },
      "director",
      "director-1",
      "office-1"
    );
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body).toEqual({ success: true });
  });

  it("routes manual company association through the generic entity resolver", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "director-1", contactId: null });
    companyServiceMocks.getCompanyById.mockResolvedValue({ id: "company-1" });

    const { req, res } = await invokeRoute({
      method: "post",
      url: "/email-1/associate",
      user: makeDirectorUser(),
      body: { assignedEntityType: "company", assignedEntityId: "company-1" },
    });

    expect(companyServiceMocks.getCompanyById).toHaveBeenCalledWith(expect.any(Object), "company-1");
    expect(emailServiceMocks.associateEmailToEntity).toHaveBeenCalledWith(
      expect.any(Object),
      "email-1",
      {
        assignedEntityType: "company",
        assignedEntityId: "company-1",
        assignedDealId: null,
      },
      "director",
      "director-1",
      "office-1"
    );
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body).toEqual({ success: true });
  });

  it("lets a rep manually assign a company even when the email has no CRM contact context", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "rep-1", contactId: null });
    companyServiceMocks.getCompanyById.mockResolvedValue({ id: "company-1" });

    const { req, res } = await invokeRoute({
      method: "post",
      url: "/email-1/associate",
      user: makeRepUser(),
      body: { assignedEntityType: "company", assignedEntityId: "company-1" },
    });

    expect(companyServiceMocks.getCompanyById).toHaveBeenCalledWith(expect.any(Object), "company-1");
    expect(emailServiceMocks.associateEmailToEntity).toHaveBeenCalledWith(
      expect.any(Object),
      "email-1",
      {
        assignedEntityType: "company",
        assignedEntityId: "company-1",
        assignedDealId: null,
      },
      "rep",
      "rep-1",
      "office-1"
    );
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body).toEqual({ success: true });
  });

  it("routes manual property association through the generic entity resolver", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "director-1", contactId: null });
    propertyServiceMocks.getPropertyDetail.mockResolvedValue({ id: "property-1" });

    const { req, res } = await invokeRoute({
      method: "post",
      url: "/email-1/associate",
      user: makeDirectorUser(),
      body: { assignedEntityType: "property", assignedEntityId: "property-1" },
    });

    expect(propertyServiceMocks.getPropertyDetail).toHaveBeenCalledWith(expect.any(Object), "property-1");
    expect(emailServiceMocks.associateEmailToEntity).toHaveBeenCalledWith(
      expect.any(Object),
      "email-1",
      {
        assignedEntityType: "property",
        assignedEntityId: "property-1",
        assignedDealId: null,
      },
      "director",
      "director-1",
      "office-1"
    );
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body).toEqual({ success: true });
  });

  it("lets a rep manually assign a property even when the email has no CRM contact context", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "rep-1", contactId: null });
    propertyServiceMocks.getPropertyDetail.mockResolvedValue({
      property: { id: "property-1", companyId: "company-1" },
    });

    const { res } = await invokeRoute({
      method: "post",
      url: "/email-1/associate",
      user: makeRepUser(),
      body: { assignedEntityType: "property", assignedEntityId: "property-1" },
    });

    expect(propertyServiceMocks.getPropertyDetail).toHaveBeenCalledWith(expect.any(Object), "property-1");
    expect(emailServiceMocks.associateEmailToEntity).toHaveBeenCalledWith(
      expect.any(Object),
      "email-1",
      {
        assignedEntityType: "property",
        assignedEntityId: "property-1",
        assignedDealId: null,
      },
      "rep",
      "rep-1",
      "office-1"
    );
    expect(res.body).toEqual({ success: true });
  });

  it("routes manual contact association through the generic entity resolver", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "director-1", contactId: "contact-1" });
    contactServiceMocks.getContactById.mockResolvedValue({ id: "contact-1" });

    const { req, res } = await invokeRoute({
      method: "post",
      url: "/email-1/associate",
      user: makeDirectorUser(),
      body: { assignedEntityType: "contact", assignedEntityId: "contact-1" },
    });

    expect(contactServiceMocks.getContactById).toHaveBeenCalledWith(expect.any(Object), "contact-1");
    expect(emailServiceMocks.associateEmailToEntity).toHaveBeenCalledWith(
      expect.any(Object),
      "email-1",
      {
        assignedEntityType: "contact",
        assignedEntityId: "contact-1",
        assignedDealId: null,
      },
      "director",
      "director-1",
      "office-1"
    );
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body).toEqual({ success: true });
  });

  it("lets a rep manually assign a contact even when the email has no CRM contact context", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "rep-1", contactId: null });
    contactServiceMocks.getContactById.mockResolvedValue({ id: "contact-1", companyId: "company-1" });

    const { res } = await invokeRoute({
      method: "post",
      url: "/email-1/associate",
      user: makeRepUser(),
      body: { assignedEntityType: "contact", assignedEntityId: "contact-1" },
    });

    expect(contactServiceMocks.getContactById).toHaveBeenCalledWith(expect.any(Object), "contact-1");
    expect(emailServiceMocks.associateEmailToEntity).toHaveBeenCalledWith(
      expect.any(Object),
      "email-1",
      {
        assignedEntityType: "contact",
        assignedEntityId: "contact-1",
        assignedDealId: null,
      },
      "rep",
      "rep-1",
      "office-1"
    );
    expect(res.body).toEqual({ success: true });
  });

  it("does not gate manual company assignment against inferred contact company context", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "rep-1", contactId: "contact-1" });
    companyServiceMocks.getCompanyById.mockResolvedValue({ id: "company-2" });

    await invokeRoute({
      method: "post",
      url: "/email-1/associate",
      user: makeRepUser(),
      body: { assignedEntityType: "company", assignedEntityId: "company-2" },
    });

    expect(emailServiceMocks.associateEmailToEntity).toHaveBeenCalledWith(
      expect.any(Object),
      "email-1",
      { assignedEntityType: "company", assignedEntityId: "company-2", assignedDealId: null },
      "rep",
      "rep-1",
      "office-1"
    );
  });

  it("does not gate manual contact assignment against inferred contact company context", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "rep-1", contactId: "contact-1" });
    contactServiceMocks.getContactById.mockResolvedValue({ id: "contact-2", companyId: "company-2" });

    await invokeRoute({
      method: "post",
      url: "/email-1/associate",
      user: makeRepUser(),
      body: { assignedEntityType: "contact", assignedEntityId: "contact-2" },
    });

    expect(emailServiceMocks.associateEmailToEntity).toHaveBeenCalledWith(
      expect.any(Object),
      "email-1",
      { assignedEntityType: "contact", assignedEntityId: "contact-2", assignedDealId: null },
      "rep",
      "rep-1",
      "office-1"
    );
  });

  it("does not gate manual property assignment against inferred contact company context", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "rep-1", contactId: "contact-1" });
    propertyServiceMocks.getPropertyDetail.mockResolvedValue({ property: { id: "property-2", companyId: "company-2" } });

    await invokeRoute({
      method: "post",
      url: "/email-1/associate",
      user: makeRepUser(),
      body: { assignedEntityType: "property", assignedEntityId: "property-2" },
    });

    expect(emailServiceMocks.associateEmailToEntity).toHaveBeenCalledWith(
      expect.any(Object),
      "email-1",
      { assignedEntityType: "property", assignedEntityId: "property-2", assignedDealId: null },
      "rep",
      "rep-1",
      "office-1"
    );
  });

  it("rejects mismatched deal identifiers before hitting the service", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "director-1" });

    await expect(
      invokeRoute({
        method: "post",
        url: "/email-1/associate",
        user: makeDirectorUser(),
        body: { assignedEntityType: "deal", assignedEntityId: "deal-1", assignedDealId: "deal-2" },
      })
    ).rejects.toThrow("assignedDealId must match assignedEntityId for deal assignments");

    expect(emailServiceMocks.associateEmailToEntity).not.toHaveBeenCalled();
  });

  it("rejects manual assignment when the selected target does not exist", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "rep-1", contactId: null });
    dealServiceMocks.getDealById.mockResolvedValue(null);
    leadServiceMocks.getLeadById.mockResolvedValue(null);
    companyServiceMocks.getCompanyById.mockResolvedValue(null);
    contactServiceMocks.getContactById.mockResolvedValue(null);
    propertyServiceMocks.getPropertyDetail.mockResolvedValue(null);

    await expect(
      invokeRoute({
        method: "post",
        url: "/email-1/associate",
        user: makeRepUser(),
        body: { assignedEntityType: "deal", assignedEntityId: "missing-deal" },
      })
    ).rejects.toThrow("Deal not found");

    await expect(
      invokeRoute({
        method: "post",
        url: "/email-1/associate",
        user: makeRepUser(),
        body: { assignedEntityType: "lead", assignedEntityId: "missing-lead" },
      })
    ).rejects.toThrow("Lead not found");

    await expect(
      invokeRoute({
        method: "post",
        url: "/email-1/associate",
        user: makeRepUser(),
        body: { assignedEntityType: "company", assignedEntityId: "missing-company" },
      })
    ).rejects.toThrow("Company not found");

    await expect(
      invokeRoute({
        method: "post",
        url: "/email-1/associate",
        user: makeRepUser(),
        body: { assignedEntityType: "contact", assignedEntityId: "missing-contact" },
      })
    ).rejects.toThrow("Contact not found");

    await expect(
      invokeRoute({
        method: "post",
        url: "/email-1/associate",
        user: makeRepUser(),
        body: { assignedEntityType: "property", assignedEntityId: "missing-property" },
      })
    ).rejects.toThrow("Property not found");

    expect(emailServiceMocks.associateEmailToEntity).not.toHaveBeenCalled();
  });

  it("returns authoritative thread payloads from the thread route", async () => {
    emailServiceMocks.getEmailThread.mockResolvedValue({
      binding: { id: "binding-1", dealId: "deal-1", dealName: "Deal One", confidence: "high", assignmentReason: "manual_thread_assignment" },
      preview: null,
      emails: [{ id: "email-1" }],
    });

    const { res } = await invokeRoute({
      method: "get",
      url: "/thread/conversation-1",
      user: makeDirectorUser(),
    });

    expect(emailServiceMocks.getEmailThread).toHaveBeenCalledWith(
      expect.any(Object),
      "conversation-1",
      "director-1",
      "director",
      expect.any(Function)
    );
    expect(res.body).toEqual({
      binding: { id: "binding-1", dealId: "deal-1", dealName: "Deal One", confidence: "high", assignmentReason: "manual_thread_assignment" },
      preview: null,
      emails: [{ id: "email-1" }],
    });
  });

  it("returns 403 when a user opens another user's email thread", async () => {
    emailServiceMocks.getEmailThread.mockRejectedValue(
      Object.assign(new Error("You do not have permission to view this email thread"), { statusCode: 403 })
    );

    await expect(
      invokeRoute({
        method: "get",
        url: "/thread/conversation-1",
        user: makeDirectorUser(),
      })
    ).rejects.toMatchObject({
      message: "You do not have permission to view this email thread",
      statusCode: 403,
    });
  });

  it("treats deal 403s as not-visible when resolving thread access", async () => {
    dealServiceMocks.getDealById.mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { statusCode: 403 })
    );
    emailServiceMocks.getEmailThread.mockImplementation(
      async (_db, _conversationId, _userId, _role, canViewDeal: (dealId: string) => Promise<boolean>) => ({
        binding: null,
        preview: null,
        emails: [{ id: "email-1", visible: await canViewDeal("deal-hidden") }],
      })
    );

    const { res } = await invokeRoute({
      method: "get",
      url: "/thread/conversation-1",
      user: makeRepUser(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.emails).toEqual([{ id: "email-1", visible: false }]);
  });

  it("still propagates non-403 deal lookup errors during thread access checks", async () => {
    dealServiceMocks.getDealById.mockRejectedValueOnce(
      Object.assign(new Error("Missing"), { statusCode: 404 })
    );
    emailServiceMocks.getEmailThread.mockImplementation(
      async (_db, _conversationId, _userId, _role, canViewDeal: (dealId: string) => Promise<boolean>) => {
        await canViewDeal("deal-missing");
        return { binding: null, preview: null, emails: [] };
      }
    );

    await expect(
      invokeRoute({
        method: "get",
        url: "/thread/conversation-1",
        user: makeRepUser(),
      })
    ).rejects.toThrow("Missing");
  });

  it("assigns an unbound thread to a deal", async () => {
    emailServiceMocks.getEmailThreadForMutation.mockResolvedValue({
      mailboxAccountId: "mailbox-1",
      binding: null,
      emails: [{ id: "email-1", userId: "director-1" }],
    });
    dealServiceMocks.getDealById.mockResolvedValue({ id: "deal-1" });
    emailServiceMocks.bindThreadToDeal.mockResolvedValue({
      binding: { id: "binding-1", dealId: "deal-1" },
      previousBindingId: null,
    });
    emailServiceMocks.getEmailThread.mockResolvedValue({ binding: { id: "binding-1", dealId: "deal-1" }, preview: null, emails: [] });

    const { req, res } = await invokeRoute({
      method: "post",
      url: "/thread/conversation-1/assign",
      user: makeDirectorUser(),
      body: { dealId: "deal-1" },
    });

    expect(emailServiceMocks.bindThreadToDeal).toHaveBeenCalledWith(expect.any(Object), {
      mailboxAccountId: "mailbox-1",
      providerConversationId: "conversation-1",
      dealId: "deal-1",
      actingUserId: "director-1",
    });
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body.binding).toEqual({ id: "binding-1", dealId: "deal-1" });
    expect(emailServiceMocks.getEmailThread).toHaveBeenLastCalledWith(
      expect.any(Object),
      "conversation-1",
      "director-1",
      "director",
      expect.any(Function)
    );
  });

  it("returns 403 when a user tries to assign another user's thread", async () => {
    emailServiceMocks.getEmailThreadForMutation.mockRejectedValue(
      Object.assign(new Error("You can only view and modify your own email threads"), { statusCode: 403 })
    );

    await expect(
      invokeRoute({
        method: "post",
        url: "/thread/conversation-1/assign",
        user: makeDirectorUser(),
        body: { dealId: "deal-1" },
      })
    ).rejects.toMatchObject({
      message: "You can only view and modify your own email threads",
      statusCode: 403,
    });
  });

  it("reassigns a thread and returns a preview", async () => {
    emailServiceMocks.getEmailThreadForMutation.mockResolvedValue({
      mailboxAccountId: "mailbox-1",
      binding: { id: "binding-1", dealId: "deal-1" },
      emails: [{ id: "email-1", userId: "director-1" }],
    });
    dealServiceMocks.getDealById.mockResolvedValue({ id: "deal-2" });
    emailServiceMocks.previewThreadReassignmentImpact.mockResolvedValue({
      affectedMessageCount: 2,
      affectedMessageIds: ["email-1", "email-2"],
      currentDealId: "deal-1",
      nextDealId: "deal-2",
    });
    emailServiceMocks.bindThreadToDeal.mockResolvedValue({
      binding: { id: "binding-2", dealId: "deal-2" },
      previousBindingId: "binding-1",
    });
    emailServiceMocks.getEmailThread.mockResolvedValue({ binding: { id: "binding-2", dealId: "deal-2" }, preview: null, emails: [] });

    const { res } = await invokeRoute({
      method: "post",
      url: "/thread/conversation-1/reassign",
      user: makeDirectorUser(),
      body: { dealId: "deal-2" },
    });

    expect(emailServiceMocks.previewThreadReassignmentImpact).toHaveBeenCalledWith(expect.any(Object), {
      mailboxAccountId: "mailbox-1",
      providerConversationId: "conversation-1",
      nextDealId: "deal-2",
    });
    expect(res.body.preview.affectedMessageIds).toEqual(["email-1", "email-2"]);
    expect(emailServiceMocks.getEmailThread).toHaveBeenLastCalledWith(
      expect.any(Object),
      "conversation-1",
      "director-1",
      "director",
      expect.any(Function)
    );
  });

  it("detaches a thread using the thread mailbox account id", async () => {
    emailServiceMocks.getEmailThreadForMutation.mockResolvedValue({
      mailboxAccountId: "mailbox-2",
      binding: { id: "binding-1", dealId: "deal-1" },
      emails: [{ id: "email-1", userId: "director-1" }],
    });
    emailServiceMocks.getEmailThread.mockResolvedValue({ binding: null, preview: null, emails: [] });

    await invokeRoute({
      method: "post",
      url: "/thread/conversation-1/detach",
      user: makeDirectorUser(),
      body: {},
    });

    expect(emailServiceMocks.detachThreadByConversation).toHaveBeenCalledWith(
      expect.any(Object),
      "mailbox-2",
      "conversation-1",
      "director-1"
    );
    expect(emailServiceMocks.getEmailThread).toHaveBeenLastCalledWith(
      expect.any(Object),
      "conversation-1",
      "director-1",
      "director",
      expect.any(Function)
    );
  });
});
