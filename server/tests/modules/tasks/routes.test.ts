import { beforeEach, describe, expect, it, vi } from "vitest";

const taskServiceMocks = vi.hoisted(() => ({
  getTasks: vi.fn(),
  getTaskCounts: vi.fn(),
  getTaskById: vi.fn(),
  createTask: vi.fn(),
  queueTaskCreateSideEffects: vi.fn(),
  updateTask: vi.fn(),
  completeTask: vi.fn(),
  dismissTask: vi.fn(),
  snoozeTask: vi.fn(),
  transitionTaskStatus: vi.fn(),
}));

const adminUsersMocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
}));

const authServiceMocks = vi.hoisted(() => ({
  getAccessibleOffices: vi.fn(),
}));

const eventBusMocks = vi.hoisted(() => ({
  emitLocal: vi.fn(),
  on: vi.fn(),
  emit: vi.fn(),
  setMaxListeners: vi.fn(),
}));

const taskNotificationMocks = vi.hoisted(() => ({
  sendTaskAssignmentEmail: vi.fn(),
  prepareTaskAssignmentEmail: vi.fn(),
  sendPreparedTaskAssignmentEmail: vi.fn(),
}));

vi.mock("../../../src/modules/tasks/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/tasks/service.js")>(
    "../../../src/modules/tasks/service.js"
  );

  return {
    ...actual,
    getTasks: taskServiceMocks.getTasks,
    getTaskCounts: taskServiceMocks.getTaskCounts,
    getTaskById: taskServiceMocks.getTaskById,
    createTask: taskServiceMocks.createTask,
    queueTaskCreateSideEffects: taskServiceMocks.queueTaskCreateSideEffects,
    updateTask: taskServiceMocks.updateTask,
    completeTask: taskServiceMocks.completeTask,
    dismissTask: taskServiceMocks.dismissTask,
    snoozeTask: taskServiceMocks.snoozeTask,
    transitionTaskStatus: taskServiceMocks.transitionTaskStatus,
  };
});

vi.mock("../../../src/modules/admin/users-service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/admin/users-service.js")>(
    "../../../src/modules/admin/users-service.js"
  );

  return {
    ...actual,
    listUsers: adminUsersMocks.listUsers,
  };
});

vi.mock("../../../src/modules/auth/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/auth/service.js")>(
    "../../../src/modules/auth/service.js"
  );

  return {
    ...actual,
    getAccessibleOffices: authServiceMocks.getAccessibleOffices,
  };
});

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: eventBusMocks,
}));

vi.mock("../../../src/modules/tasks/notifications.js", () => taskNotificationMocks);

const { taskRoutes } = await import("../../../src/modules/tasks/routes.js");

type TestUser = {
  id: string;
  role: "admin" | "director" | "rep";
  displayName: string;
  email: string;
  officeId: string;
  activeOfficeId: string;
};

function makeResponse() {
  const res: Record<string, any> & { _resolve?: () => void; _reject?: (err: unknown) => void } = {
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
    send(payload: any) {
      res.body = payload;
      res._resolve?.();
      return res;
    },
  };

  return res;
}

function createTenantDbMock() {
  const insertValues = vi.fn(async () => undefined);
  return {
    insert: vi.fn(() => ({
      values: insertValues,
    })),
    query: vi.fn(),
    insertValues,
  };
}

function findRouteHandler(method: "get" | "post" | "patch", routePath: string) {
  const layer = (taskRoutes as any).stack.find(
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
  tenantDb,
  headers = {},
}: {
  method: "get" | "post" | "patch";
  url: string;
  user: TestUser;
  query?: Record<string, any>;
  body?: Record<string, any>;
  tenantDb?: Record<string, any>;
  headers?: Record<string, string>;
}) {
  const routePath =
    url === "/"
      ? "/"
      : url === "/assignees"
        ? "/assignees"
        : method === "patch"
          ? "/:id"
        : url.endsWith("/complete")
          ? "/:id/complete"
          : "/:id/transition";
  const handler = findRouteHandler(method, routePath);
  const resolvedTenantDb = tenantDb ?? createTenantDbMock();
  const req: Record<string, any> = {
    method: method.toUpperCase(),
    url,
    originalUrl: `/api/tasks${url}`,
    baseUrl: "/api/tasks",
    path: url,
    query,
    body,
    params: {},
    user,
    tenantDb: resolvedTenantDb,
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    headers,
  };
  const res = makeResponse();

  await new Promise<void>((resolve, reject) => {
    res._resolve = resolve;
    res._reject = reject;
    req.params = routePath === "/:id/transition" ? { id: url.split("/")[1] } : {};
    if (routePath === "/:id/complete" || routePath === "/:id") {
      req.params = { id: url.split("/")[1] };
    }
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

describe("task routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authServiceMocks.getAccessibleOffices.mockResolvedValue([
      { id: "office-1", name: "Office One", slug: "office-one" },
    ]);
    adminUsersMocks.listUsers.mockResolvedValue([
      { id: "rep-1", displayName: "Rep One", isActive: true },
      { id: "admin-1", displayName: "Admin One", isActive: true },
    ]);
    taskServiceMocks.queueTaskCreateSideEffects.mockResolvedValue({
      shouldEmitAssignmentEvent: false,
    });
    taskNotificationMocks.sendTaskAssignmentEmail.mockResolvedValue(true);
    taskNotificationMocks.prepareTaskAssignmentEmail.mockResolvedValue({
      to: "admin@example.com",
      subject: "New task assigned: Prep handoff",
      html: "<p>Body</p>",
      options: { cc: "rep@example.com", text: "Body" },
    });
    taskNotificationMocks.sendPreparedTaskAssignmentEmail.mockResolvedValue(true);
  });

  it("forwards assignee filters when listing tasks", async () => {
    taskServiceMocks.getTasks.mockResolvedValue({
      tasks: [],
      pagination: { page: 2, limit: 25, total: 0, totalPages: 0 },
    });

    await invokeRoute({
      method: "get",
      url: "/",
      user: makeDirectorUser(),
      query: {
        assignedTo: "user-2",
        status: "waiting_on",
        section: "today",
        page: "2",
        limit: "25",
      },
    });

    expect(taskServiceMocks.getTasks).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        assignedTo: "user-2",
        status: "waiting_on",
        section: "today",
        page: 2,
        limit: 25,
      }),
      "director",
      "director-1"
    );
  });

  it("returns active office users in the assignee picker for reps", async () => {
    adminUsersMocks.listUsers.mockResolvedValue([
      { id: "rep-1", displayName: "Rep One", isActive: true },
      { id: "admin-1", displayName: "Admin One", isActive: true },
      { id: "inactive-1", displayName: "Inactive One", isActive: false },
    ]);

    const { res } = await invokeRoute({
      method: "get",
      url: "/assignees",
      user: makeRepUser(),
    });

    expect(adminUsersMocks.listUsers).toHaveBeenCalledWith("office-1");
    expect(res.body.users).toEqual([
      { id: "rep-1", displayName: "Rep One" },
      { id: "admin-1", displayName: "Admin One" },
    ]);
  });

  it("honors a rep-selected assignee when creating a manual task", async () => {
    taskServiceMocks.createTask.mockResolvedValue({
      id: "task-1",
      title: "Prep handoff",
      assignedTo: "admin-1",
    });

    const { res } = await invokeRoute({
      method: "post",
      url: "/",
      user: makeRepUser(),
      body: {
        title: "Prep handoff",
        type: "manual",
        assignedTo: "admin-1",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(taskServiceMocks.createTask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        title: "Prep handoff",
        assignedTo: "admin-1",
        createdBy: "rep-1",
      })
    );
  });

  it("emails the assignee and CCs the creator when a task is created for another user", async () => {
    const createdTask = {
      id: "task-1",
      title: "Prep handoff",
      description: "Bring the scope notes",
      assignedTo: "admin-1",
      createdBy: "rep-1",
      dueDate: "2026-05-20",
    };
    taskServiceMocks.createTask.mockResolvedValue(createdTask);

    await invokeRoute({
      method: "post",
      url: "/",
      user: makeRepUser({ id: "rep-1", displayName: "Rep One", email: "rep@example.com" }),
      body: {
        title: "Prep handoff",
        description: "Bring the scope notes",
        type: "manual",
        assignedTo: "admin-1",
        dueDate: "2026-05-20",
      },
    });

    expect(taskNotificationMocks.prepareTaskAssignmentEmail).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        task: createdTask,
        assigneeId: "admin-1",
        assigner: expect.objectContaining({
          id: "rep-1",
          displayName: "Rep One",
          email: "rep@example.com",
        }),
      })
    );
    expect(taskNotificationMocks.sendPreparedTaskAssignmentEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@example.com",
        subject: "New task assigned: Prep handoff",
      })
    );
  });

  it("skips task assignment email for self-assigned created tasks", async () => {
    taskServiceMocks.createTask.mockResolvedValue({
      id: "task-1",
      title: "Self follow-up",
      assignedTo: "rep-1",
      createdBy: "rep-1",
    });

    await invokeRoute({
      method: "post",
      url: "/",
      user: makeRepUser(),
      body: {
        title: "Self follow-up",
        type: "manual",
        assignedTo: "rep-1",
      },
    });

    expect(taskNotificationMocks.prepareTaskAssignmentEmail).not.toHaveBeenCalled();
    expect(taskNotificationMocks.sendPreparedTaskAssignmentEmail).not.toHaveBeenCalled();
  });

  it("emails the new assignee when a task is reassigned", async () => {
    taskServiceMocks.getTaskById.mockResolvedValue({
      id: "task-1",
      title: "Existing task",
      assignedTo: "rep-1",
    });
    const updatedTask = {
      id: "task-1",
      title: "Existing task",
      description: "Updated owner",
      assignedTo: "admin-1",
      dueDate: "2026-05-21",
    };
    taskServiceMocks.updateTask.mockResolvedValue(updatedTask);

    await invokeRoute({
      method: "patch",
      url: "/task-1",
      user: makeDirectorUser({ id: "director-1", displayName: "Director One", email: "director@example.com" }),
      body: {
        assignedTo: "admin-1",
      },
    });

    expect(taskNotificationMocks.prepareTaskAssignmentEmail).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        task: updatedTask,
        assigneeId: "admin-1",
        assigner: expect.objectContaining({
          id: "director-1",
          displayName: "Director One",
          email: "director@example.com",
        }),
      })
    );
    expect(taskNotificationMocks.sendPreparedTaskAssignmentEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@example.com",
      })
    );
  });

  it("skips task assignment email when assignedTo is unchanged on update", async () => {
    taskServiceMocks.getTaskById.mockResolvedValue({
      id: "task-1",
      title: "Existing task",
      assignedTo: "rep-1",
    });
    taskServiceMocks.updateTask.mockResolvedValue({
      id: "task-1",
      title: "Existing task",
      assignedTo: "rep-1",
    });

    await invokeRoute({
      method: "patch",
      url: "/task-1",
      user: makeRepUser(),
      body: {
        assignedTo: "rep-1",
      },
    });

    expect(taskNotificationMocks.prepareTaskAssignmentEmail).not.toHaveBeenCalled();
    expect(taskNotificationMocks.sendPreparedTaskAssignmentEmail).not.toHaveBeenCalled();
  });

  it("rejects rep task assignment to users outside accessible offices", async () => {
    adminUsersMocks.listUsers.mockResolvedValue([
      { id: "rep-1", displayName: "Rep One", isActive: true },
    ]);

    await expect(
      invokeRoute({
        method: "post",
        url: "/",
        user: makeRepUser(),
        body: {
          title: "Prep handoff",
          type: "manual",
          assignedTo: "outside-user",
        },
      })
    ).rejects.toThrow("Assigned user is not active or is outside the current office");

    expect(taskServiceMocks.createTask).not.toHaveBeenCalled();
  });

  it("rejects rep task reassignment to users outside accessible offices", async () => {
    adminUsersMocks.listUsers.mockResolvedValue([
      { id: "rep-1", displayName: "Rep One", isActive: true },
    ]);

    await expect(
      invokeRoute({
        method: "patch",
        url: "/task-1",
        user: makeRepUser(),
        body: {
          assignedTo: "outside-user",
        },
      })
    ).rejects.toThrow("Assigned user is not active or is outside the current office");

    expect(taskServiceMocks.updateTask).not.toHaveBeenCalled();
  });

  it("defaults assignee loading to the active office instead of aggregating all accessible offices", async () => {
    authServiceMocks.getAccessibleOffices.mockResolvedValue([
      { id: "office-1", name: "Office One", slug: "office-one" },
      { id: "office-2", name: "Office Two", slug: "office-two" },
    ]);
    adminUsersMocks.listUsers.mockResolvedValue([
      { id: "office-1-user", displayName: "Office One User", isActive: true },
    ]);

    const { res } = await invokeRoute({
      method: "get",
      url: "/assignees",
      user: makeDirectorUser({ activeOfficeId: "office-1" }),
    });

    expect(adminUsersMocks.listUsers).toHaveBeenCalledTimes(1);
    expect(adminUsersMocks.listUsers).toHaveBeenCalledWith("office-1");
    expect(res.body.users).toEqual([{ id: "office-1-user", displayName: "Office One User" }]);
  });

  it("rejects task creation when the assignee is only active in another accessible office", async () => {
    authServiceMocks.getAccessibleOffices.mockResolvedValue([
      { id: "office-1", name: "Office One", slug: "office-one" },
      { id: "office-2", name: "Office Two", slug: "office-two" },
    ]);
    adminUsersMocks.listUsers.mockResolvedValue([
      { id: "office-1-user", displayName: "Office One User", isActive: true },
    ]);

    await expect(
      invokeRoute({
        method: "post",
        url: "/",
        user: makeDirectorUser({ activeOfficeId: "office-1" }),
        body: {
          title: "Cross-office task",
          type: "manual",
          assignedTo: "office-2-user",
        },
      })
    ).rejects.toThrow("Assigned user is not active or is outside the current office");

    expect(adminUsersMocks.listUsers).toHaveBeenCalledTimes(1);
    expect(adminUsersMocks.listUsers).toHaveBeenCalledWith("office-1");
    expect(taskServiceMocks.createTask).not.toHaveBeenCalled();
  });

  it("allows task creation in a requested office when the assignee belongs to that office", async () => {
    authServiceMocks.getAccessibleOffices.mockResolvedValue([
      { id: "office-1", name: "Office One", slug: "office-one" },
      { id: "office-2", name: "Office Two", slug: "office-two" },
    ]);
    adminUsersMocks.listUsers.mockResolvedValue([
      { id: "office-2-user", displayName: "Office Two User", isActive: true },
    ]);
    taskServiceMocks.createTask.mockResolvedValue({
      id: "task-2",
      title: "Office Two task",
      assignedTo: "office-2-user",
    });

    const { res } = await invokeRoute({
      method: "post",
      url: "/",
      user: makeDirectorUser({ activeOfficeId: "office-1" }),
      headers: { "x-office-id": "office-2" },
      body: {
        title: "Office Two task",
        type: "manual",
        assignedTo: "office-2-user",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(adminUsersMocks.listUsers).toHaveBeenCalledWith("office-2");
    expect(taskServiceMocks.createTask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ assignedTo: "office-2-user" })
    );
  });

  it("filters inactive users out of the assignee picker for directors", async () => {
    authServiceMocks.getAccessibleOffices.mockResolvedValue([
      { id: "office-1", name: "Office One", slug: "office-one" },
    ]);
    adminUsersMocks.listUsers.mockResolvedValue([
      { id: "user-1", displayName: "Active User", isActive: true },
      { id: "user-2", displayName: "Inactive User", isActive: false },
    ]);

    const { res } = await invokeRoute({
      method: "get",
      url: "/assignees",
      user: makeDirectorUser(),
    });

    expect(adminUsersMocks.listUsers).toHaveBeenCalledWith("office-1");
    expect(res.body.users).toEqual([{ id: "user-1", displayName: "Active User" }]);
  });

  it("uses the requested office context when loading assignees", async () => {
    authServiceMocks.getAccessibleOffices.mockResolvedValue([
      { id: "office-2", name: "Office Two", slug: "office-two" },
    ]);
    adminUsersMocks.listUsers.mockResolvedValue([
      { id: "user-3", displayName: "Selected Office User", isActive: true },
    ]);

    const { res } = await invokeRoute({
      method: "get",
      url: "/assignees",
      user: makeDirectorUser(),
      headers: { "x-office-id": "office-2" },
    });

    expect(adminUsersMocks.listUsers).toHaveBeenCalledWith("office-2");
    expect(res.body.users).toEqual([{ id: "user-3", displayName: "Selected Office User" }]);
  });

  it("rejects assignee loading for an inaccessible office", async () => {
    authServiceMocks.getAccessibleOffices.mockResolvedValue([
      { id: "office-1", name: "Office One", slug: "office-one" },
    ]);

    await expect(
      invokeRoute({
        method: "get",
        url: "/assignees",
        user: makeDirectorUser(),
        headers: { "x-office-id": "office-2" },
      })
    ).rejects.toThrow("Requested office is not accessible");

    expect(adminUsersMocks.listUsers).not.toHaveBeenCalled();
  });

  it.each([
    [
      "scheduled",
      { scheduledFor: "2026-04-08T12:00:00.000Z" },
    ],
    [
      "waiting_on",
      { waitingOn: { reason: "waiting on customer" } },
    ],
    [
      "blocked",
      { blockedBy: { kind: "deal", id: "deal-1" } },
    ],
  ])("exposes the lifecycle transition endpoint for %s", async (nextStatus, extraBody) => {
    taskServiceMocks.transitionTaskStatus.mockImplementation(async (_db, taskId, input) => ({
      id: taskId,
      status: input.nextStatus,
      scheduledFor: input.scheduledFor ?? null,
      waitingOn: input.waitingOn ?? null,
      blockedBy: input.blockedBy ?? null,
    }));

    const { res } = await invokeRoute({
      method: "post",
      url: "/task-1/transition",
      user: makeDirectorUser(),
      body: { nextStatus, ...extraBody },
    });

    expect(taskServiceMocks.transitionTaskStatus).toHaveBeenCalledWith(
      expect.any(Object),
      "task-1",
      expect.objectContaining({ nextStatus, ...extraBody }),
      "director",
      "director-1"
    );
    expect(res.body.task).toMatchObject({ id: "task-1", status: nextStatus });
  });

  it("attaches close-loop provenance to task completion events", async () => {
    const completedTask = {
      id: "task-1",
      title: "Follow up on stale deal",
      dealId: "deal-1",
      contactId: "contact-1",
      type: "stale_deal",
      originRule: "stale_deal",
      dedupeKey: "deal:1",
      entitySnapshot: { dealId: "deal-1", contactId: "contact-1" },
    };
    taskServiceMocks.completeTask.mockResolvedValue(completedTask);

    const { req } = await invokeRoute({
      method: "post",
      url: "/task-1/complete",
      user: makeDirectorUser(),
    });

    expect(taskServiceMocks.completeTask).toHaveBeenCalledWith(
      expect.any(Object),
      "task-1",
      "director",
      "director-1"
    );
    expect((req.tenantDb as any).insert).toHaveBeenCalled();
    expect((req.tenantDb as any).insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "domain_event",
        payload: expect.objectContaining({
          eventName: "task.completed",
          taskId: "task-1",
          dealId: "deal-1",
          contactId: "contact-1",
          title: "Follow up on stale deal",
          type: "stale_deal",
          completedBy: "director-1",
          originRule: "stale_deal",
          dedupeKey: "deal:1",
          entitySnapshot: { dealId: "deal-1", contactId: "contact-1" },
          suppressionWindowDays: expect.any(Number),
        }),
      })
    );
    expect(eventBusMocks.emitLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "task.completed",
        payload: expect.objectContaining({
          taskId: "task-1",
          originRule: "stale_deal",
          dedupeKey: "deal:1",
          entitySnapshot: { dealId: "deal-1", contactId: "contact-1" },
          suppressionWindowDays: expect.any(Number),
        }),
      })
    );
  });

  it("fails fast when a rule-backed task has no rule config for close-loop persistence", async () => {
    taskServiceMocks.completeTask.mockResolvedValue({
      id: "task-1",
      title: "Follow up on unknown rule",
      dealId: "deal-1",
      contactId: "contact-1",
      type: "stale_deal",
      originRule: "missing_rule",
      dedupeKey: "deal:1",
      reasonCode: "stale_deal",
      entitySnapshot: { dealId: "deal-1", contactId: "contact-1" },
    });

    await expect(
      invokeRoute({
        method: "post",
        url: "/task-1/complete",
        user: makeDirectorUser(),
      })
    ).rejects.toMatchObject({
      statusCode: 500,
      message: "Missing rule configuration for completed task originRule missing_rule",
    });

    expect(eventBusMocks.emitLocal).not.toHaveBeenCalled();
  });
});
