import { beforeEach, describe, expect, it, vi } from "vitest";

const taskServiceMocks = vi.hoisted(() => ({
  getTasks: vi.fn(),
  getTaskCounts: vi.fn(),
  getTaskById: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  completeTask: vi.fn(),
  dismissTask: vi.fn(),
  snoozeTask: vi.fn(),
  transitionTaskStatus: vi.fn(),
}));

const adminUsersMocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
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
}: {
  method: "get" | "post" | "patch";
  url: string;
  user: TestUser;
  query?: Record<string, any>;
  body?: Record<string, any>;
  }) {
  const routePath = url === "/" ? "/" : url === "/assignees" ? "/assignees" : "/:id/transition";
  const handler = findRouteHandler(method, routePath);
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
    tenantDb: { query: vi.fn() },
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    headers: {},
  };
  const res = makeResponse();

  await new Promise<void>((resolve, reject) => {
    res._resolve = resolve;
    res._reject = reject;
    req.params = routePath === "/:id/transition" ? { id: url.split("/")[1] } : {};
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

  it("returns only the current rep in the assignee picker", async () => {
    const { res } = await invokeRoute({
      method: "get",
      url: "/assignees",
      user: makeRepUser(),
    });

    expect(adminUsersMocks.listUsers).not.toHaveBeenCalled();
    expect(res.body.users).toEqual([
      { id: "rep-1", displayName: "Rep One" },
    ]);
  });

  it("filters inactive users out of the assignee picker for directors", async () => {
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
});
