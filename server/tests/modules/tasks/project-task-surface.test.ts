import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const taskServiceMocks = vi.hoisted(() => ({
  getProjectTaskScope: vi.fn(),
  getProjectTasks: vi.fn(),
  createTask: vi.fn(),
  getTasks: vi.fn(),
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

  it("preserves generic rep restrictions when filtering the generic task list by dealId", async () => {
    taskServiceMocks.getTasks.mockResolvedValue({
      tasks: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });

    const response = await request(createTaskApp(createUser("rep"))).get(
      "/api/tasks?dealId=deal-999"
    );

    expect(response.status).toBe(200);
    expect(taskServiceMocks.getTasks).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ dealId: "deal-999" }),
      "rep",
      "rep-1"
    );
  });
});
