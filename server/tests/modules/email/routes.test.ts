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
  bindThreadToDeal: vi.fn(),
  detachThreadByConversation: vi.fn(),
  previewThreadReassignmentImpact: vi.fn(),
  assertCanMutateEmailThread: vi.fn(),
}));

const dealServiceMocks = vi.hoisted(() => ({
  getDealById: vi.fn(),
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

function findRouteHandler(method: "get" | "post", routePath: string) {
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
}: {
  method: "get" | "post";
  url: string;
  user: TestUser;
  query?: Record<string, any>;
  body?: Record<string, any>;
}) {
  const routePath =
    url === "/assignment-queue"
      ? "/assignment-queue"
      : url.startsWith("/thread/") && url.endsWith("/assign")
        ? "/thread/:conversationId/assign"
        : url.startsWith("/thread/") && url.endsWith("/reassign")
          ? "/thread/:conversationId/reassign"
          : url.startsWith("/thread/") && url.endsWith("/detach")
            ? "/thread/:conversationId/detach"
            : url.startsWith("/thread/")
              ? "/thread/:conversationId"
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
      routePath === "/:id/associate"
        ? { id: url.split("/")[1] }
        : routePath.startsWith("/thread/:conversationId")
          ? { conversationId: url.split("/")[2] }
          : {},
    user,
    tenantDb: {},
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

describe("email routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emailServiceMocks.assertCanMutateEmailThread.mockResolvedValue(undefined);
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
      query: { search: "alpha", page: "2", limit: "10" },
    });

    expect(emailServiceMocks.getEmailAssignmentQueue).toHaveBeenCalledWith(
      expect.any(Object),
      { search: "alpha", page: 2, limit: 10 },
      "director-1",
      "director"
    );
    expect(req.commitTransaction).toHaveBeenCalled();
    expect(res.body).toEqual({ items: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 0 } });
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

  it("rejects non-deal association targets before hitting the service", async () => {
    emailServiceMocks.getEmailById.mockResolvedValue({ id: "email-1", userId: "director-1" });

    await expect(
      invokeRoute({
        method: "post",
        url: "/email-1/associate",
        user: makeDirectorUser(),
        body: { assignedEntityType: "lead", assignedEntityId: "lead-1" },
      })
    ).rejects.toThrow("Only deal assignments are supported by this endpoint");

    expect(emailServiceMocks.associateEmailToEntity).not.toHaveBeenCalled();
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
      "director"
    );
    expect(res.body).toEqual({
      binding: { id: "binding-1", dealId: "deal-1", dealName: "Deal One", confidence: "high", assignmentReason: "manual_thread_assignment" },
      preview: null,
      emails: [{ id: "email-1" }],
    });
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
  });
});
