import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const taskServiceMocks = vi.hoisted(() => ({
  getProjectTaskScope: vi.fn(),
  getProjectTasks: vi.fn(),
  createTask: vi.fn(),
  getTasks: vi.fn(),
  queueTaskCreateSideEffects: vi.fn(),
}));

const adminUsersMocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
}));

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: {
    emitLocal: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    setMaxListeners: vi.fn(),
  },
}));

vi.mock("../../../src/modules/tasks/service.js", async () => {
  const actual = await vi.importActual("../../../src/modules/tasks/service.js");

  return {
    ...(actual as Record<string, unknown>),
    getProjectTaskScope: taskServiceMocks.getProjectTaskScope,
    getProjectTasks: taskServiceMocks.getProjectTasks,
    createTask: taskServiceMocks.createTask,
    getTasks: taskServiceMocks.getTasks,
    queueTaskCreateSideEffects: taskServiceMocks.queueTaskCreateSideEffects,
  };
});

vi.mock("../../../src/modules/admin/users-service.js", async () => {
  const actual = await vi.importActual("../../../src/modules/admin/users-service.js");

  return {
    ...(actual as Record<string, unknown>),
    getUserById: adminUsersMocks.getUserById,
  };
});

const actualTaskService = await vi.importActual("../../../src/modules/tasks/service.js");
const { procoreRoutes } = await import("../../../src/modules/procore/routes.js");
const { taskRoutes } = await import("../../../src/modules/tasks/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

type TestUser = {
  id: string;
  role: "admin" | "director" | "rep";
  displayName: string;
  email: string;
  officeId: string;
  activeOfficeId: string;
};

function createAwaitableChain(rows: any[]) {
  const chain: Record<string, any> = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    offset: vi.fn(() => chain),
    then: (onFulfilled: (value: any[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(onFulfilled, onRejected),
  };

  return chain;
}

function createProjectTaskDb(responses: any[][]) {
  const queued = [...responses];

  return {
    select: vi.fn(() => createAwaitableChain(queued.shift() ?? [])),
  };
}

function flattenQueryChunks(input: unknown, seen = new WeakSet<object>()): unknown[] {
  if (!input || typeof input !== "object") return [input];
  if (seen.has(input as object)) return [];
  seen.add(input as object);

  const queryChunks = (input as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) {
    return queryChunks.flatMap((chunk) => flattenQueryChunks(chunk, seen));
  }

  if ("value" in (input as Record<string, unknown>)) {
    return [((input as Record<string, unknown>).value)];
  }

  return Object.values(input as Record<string, unknown>).flatMap((value) => flattenQueryChunks(value, seen));
}

function createCapturedGetTasksDb() {
  const capturedWhere: unknown[] = [];

  function createChain(rows: any[]) {
    const chain: Record<string, any> = {
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn((condition: unknown) => {
        capturedWhere.push(condition);
        return chain;
      }),
      limit: vi.fn(() => chain),
      offset: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      then: (onFulfilled: (value: any[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(onFulfilled, onRejected),
    };

    return chain;
  }

  return {
    db: {
      select: vi.fn((selection?: Record<string, unknown>) => {
        const rows = selection && "count" in selection ? [{ count: 0 }] : [];
        return createChain(rows);
      }),
    },
    getCapturedWhere: () => capturedWhere,
  };
}

function createTenantDbMock() {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(async () => undefined),
    })),
  };
}

function createUser(role: TestUser["role"]): TestUser {
  return {
    id: `${role}-1`,
    role,
    displayName: `${role} user`,
    email: `${role}@example.com`,
    officeId: "office-1",
    activeOfficeId: "office-1",
  };
}

function createProcoreApp(user: TestUser, tenantDb = createTenantDbMock()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    (req as any).tenantDb = tenantDb;
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/procore", procoreRoutes);
  app.use(errorHandler);
  return app;
}

function createTaskApp(user: TestUser, tenantDb = createTenantDbMock()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    (req as any).tenantDb = tenantDb;
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/tasks", taskRoutes);
  app.use(errorHandler);
  return app;
}

describe("project task surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskServiceMocks.queueTaskCreateSideEffects.mockResolvedValue({
      shouldEmitAssignmentEvent: true,
    });
    adminUsersMocks.getUserById.mockResolvedValue({
      id: "rep-2",
      officeId: "office-1",
      isActive: true,
      officeAccess: [],
    });
  });

  it("allows a rep to read all tasks for a permitted project through the project-scoped helper", async () => {
    const db = createProjectTaskDb([
      [{ id: "deal-123", procoreProjectId: 999 }],
      [
        { id: "task-1", title: "QA walk", assignedTo: "rep-1", dealId: "deal-123" },
        { id: "task-2", title: "Owner call", assignedTo: "rep-2", dealId: "deal-123" },
      ],
    ]);

    const rows = await (actualTaskService as Record<string, any>).getProjectTasks(
      db as any,
      "deal-123",
      "rep",
      "rep-1"
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row: { id: string }) => row.id)).toEqual(["task-1", "task-2"]);
  });

  it("allows a rep to read all tasks for a permitted project via the procore route", async () => {
    taskServiceMocks.getProjectTaskScope.mockResolvedValue({
      id: "deal-123",
      procoreProjectId: 999,
    });
    taskServiceMocks.getProjectTasks.mockResolvedValue([
      { id: "task-1", title: "QA walk", assignedTo: "rep-1", dealId: "deal-123" },
      { id: "task-2", title: "Owner call", assignedTo: "rep-2", dealId: "deal-123" },
    ]);

    const response = await request(createProcoreApp(createUser("rep"))).get(
      "/api/procore/my-projects/deal-123/tasks"
    );

    expect(response.status).toBe(200);
    expect(response.body.tasks).toHaveLength(2);
    expect(taskServiceMocks.getProjectTasks).toHaveBeenCalledWith(
      expect.any(Object),
      "deal-123",
      "rep",
      "rep-1"
    );
  });

  it("returns 404 when project-scoped tasks are requested for a non-linked deal", async () => {
    taskServiceMocks.getProjectTaskScope.mockResolvedValue(null);

    const response = await request(createProcoreApp(createUser("director"))).get(
      "/api/procore/my-projects/deal-missing/tasks"
    );

    expect(response.status).toBe(404);
    expect(taskServiceMocks.getProjectTasks).not.toHaveBeenCalled();
  });

  it("creates project-scoped tasks for directors and binds the route deal id", async () => {
    taskServiceMocks.getProjectTaskScope.mockResolvedValue({
      id: "deal-123",
      procoreProjectId: 999,
    });
    taskServiceMocks.createTask.mockResolvedValue({
      id: "task-1",
      title: "Schedule turnover walk",
      assignedTo: "rep-2",
      dealId: "deal-123",
    });

    const response = await request(createProcoreApp(createUser("director"))).post(
      "/api/procore/my-projects/deal-123/tasks"
    ).send({
      title: "Schedule turnover walk",
      assignedTo: "rep-2",
      dealId: "deal-999",
    });

    expect(response.status).toBe(201);
    expect(taskServiceMocks.createTask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        title: "Schedule turnover walk",
        assignedTo: "rep-2",
        createdBy: "director-1",
        dealId: "deal-123",
      })
    );
    expect(taskServiceMocks.queueTaskCreateSideEffects).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        id: "task-1",
        assignedTo: "rep-2",
        dealId: "deal-123",
      }),
      expect.objectContaining({
        actorUserId: "director-1",
        officeId: "office-1",
      })
    );
  });

  it("requires assignedTo when creating project-scoped tasks", async () => {
    taskServiceMocks.getProjectTaskScope.mockResolvedValue({
      id: "deal-123",
      procoreProjectId: 999,
    });

    const response = await request(createProcoreApp(createUser("director"))).post(
      "/api/procore/my-projects/deal-123/tasks"
    ).send({
      title: "Schedule turnover walk",
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("assignedTo is required");
    expect(taskServiceMocks.createTask).not.toHaveBeenCalled();
  });

  it("rejects project-scoped task creation when the assignee is inactive or lacks office access", async () => {
    taskServiceMocks.getProjectTaskScope.mockResolvedValue({
      id: "deal-123",
      procoreProjectId: 999,
    });
    adminUsersMocks.getUserById.mockResolvedValue({
      id: "rep-9",
      officeId: "office-9",
      isActive: true,
      officeAccess: [],
    });

    const response = await request(createProcoreApp(createUser("director"))).post(
      "/api/procore/my-projects/deal-123/tasks"
    ).send({
      title: "Schedule turnover walk",
      assignedTo: "rep-9",
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("Assigned user does not have access to this office");
    expect(taskServiceMocks.createTask).not.toHaveBeenCalled();
  });

  it("rejects project-scoped task creation for reps", async () => {
    const response = await request(createProcoreApp(createUser("rep"))).post(
      "/api/procore/my-projects/deal-123/tasks"
    ).send({
      title: "Rep cannot create this",
    });

    expect(response.status).toBe(403);
    expect(taskServiceMocks.createTask).not.toHaveBeenCalled();
  });

  it("preserves generic rep restrictions by composing rep scope with dealId filters", async () => {
    const { db, getCapturedWhere } = createCapturedGetTasksDb();

    const result = await (actualTaskService as Record<string, any>).getTasks(
      db as any,
      { dealId: "deal-999" },
      "rep",
      "rep-1"
    );

    const flattened = getCapturedWhere().flatMap((condition) => flattenQueryChunks(condition));

    expect(result.tasks).toEqual([]);
    expect(flattened).toEqual(expect.arrayContaining(["rep-1", "deal-999"]));
  });

  it("includes project metadata in shared task payload selections", async () => {
    const { db } = createCapturedGetTasksDb();

    await (actualTaskService as Record<string, any>).getTasks(
      db as any,
      { status: "pending" },
      "director",
      "director-1"
    );

    const taskSelect = db.select.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(taskSelect).toBeTruthy();
    expect(Object.keys(taskSelect)).toEqual(expect.arrayContaining(["dealName", "dealNumber"]));
  });
});
