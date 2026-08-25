// C2 — proves the two F6 endpoints are actually REACHABLE, by driving the real Express router.
//
// `router.get("/:id")` matches ANY single path segment and Express takes the first route that matches,
// so a literal `/pending-acknowledgement` registered after it is dead: the request lands in the
// single-task handler, the literal string is passed to getTaskById as a task id, and Postgres rejects it
// as malformed uuid input. The caller sees a 500 with nothing in it that points at routing, and every
// unit test of the handler itself still passes — because the handler is fine. Registration ORDER is the
// defect, and only the router can show it.
//
// So these tests mount `taskRoutes` on a real express app and go through supertest. Asserting the
// route's presence in the stack, or grepping routes.ts, would both be green with the block appended to
// the bottom of the file.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const taskServiceMocks = vi.hoisted(() => ({
  getPendingAssignmentTasks: vi.fn(),
  acknowledgeTaskAssignments: vi.fn(),
  getTaskById: vi.fn(),
}));

vi.mock("../../../src/modules/tasks/service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/modules/tasks/service.js")>(
    "../../../src/modules/tasks/service.js"
  );
  return {
    ...actual,
    getPendingAssignmentTasks: taskServiceMocks.getPendingAssignmentTasks,
    acknowledgeTaskAssignments: taskServiceMocks.acknowledgeTaskAssignments,
    getTaskById: taskServiceMocks.getTaskById,
  };
});

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: { emitLocal: vi.fn(), on: vi.fn(), emit: vi.fn(), setMaxListeners: vi.fn() },
}));

const { taskRoutes } = await import("../../../src/modules/tasks/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

const CALLER = "11111111-1111-1111-1111-111111111111";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/tasks", (req, _res, next) => {
    (req as any).user = {
      id: CALLER,
      role: "rep",
      displayName: "Alice Rep",
      email: "alice@example.com",
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    (req as any).tenantDb = { __tenant: true };
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/tasks", taskRoutes);
  app.use(errorHandler);
  return app;
}

describe("F6 task routes — reachable through the real router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskServiceMocks.getPendingAssignmentTasks.mockResolvedValue({ tasks: [], total: 0, newTotal: 0 });
    taskServiceMocks.acknowledgeTaskAssignments.mockResolvedValue(0);
    taskServiceMocks.getTaskById.mockResolvedValue({ id: "whatever" });
  });

  it("routes GET /pending-acknowledgement to its own handler, NOT to GET /:id", async () => {
    const response = await request(createTestApp()).get("/api/tasks/pending-acknowledgement");

    expect(response.status).toBe(200);
    expect(taskServiceMocks.getPendingAssignmentTasks).toHaveBeenCalledTimes(1);
    // The tell for the swallowing bug: /:id would have been handed the literal string as a task id.
    expect(taskServiceMocks.getTaskById).not.toHaveBeenCalled();
  });

  it("scopes the list to the AUTHENTICATED caller, never a query parameter", async () => {
    await request(createTestApp())
      .get("/api/tasks/pending-acknowledgement")
      .query({ userId: "22222222-2222-2222-2222-222222222222" });

    expect(taskServiceMocks.getPendingAssignmentTasks).toHaveBeenCalledWith(
      expect.anything(),
      CALLER
    );
  });

  // The fixture mirrors the service's REAL return shape, fields and all. A route test that invents its
  // own shape keeps passing after the service changes and quietly stops describing the endpoint.
  it("passes the service payload through verbatim — rows, total and newTotal", async () => {
    const row = {
      id: "t1",
      assignmentVersion: "2026-08-25T12:34:56.123456Z",
      title: "Call back",
      priority: "urgent",
      dueDate: null,
      createdByName: "Adam Shaw",
      isNew: true,
    };
    taskServiceMocks.getPendingAssignmentTasks.mockResolvedValue({ tasks: [row], total: 9, newTotal: 3 });

    const response = await request(createTestApp()).get("/api/tasks/pending-acknowledgement");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ tasks: [row], total: 9, newTotal: 3 });
  });

  it("forwards each displayed assignment version through POST /acknowledge and answers 204 with no body", async () => {
    taskServiceMocks.acknowledgeTaskAssignments.mockResolvedValue(2);

    const response = await request(createTestApp())
      .post("/api/tasks/acknowledge")
      .send({
        assignments: [
          { taskId: "a", assignmentVersion: "2026-08-25T12:34:56.123456Z" },
          { taskId: "b", assignmentVersion: "2026-08-25T12:34:57.123456Z" },
        ],
      });

    expect(response.status).toBe(204);
    expect(response.text).toBe("");
    expect(taskServiceMocks.acknowledgeTaskAssignments).toHaveBeenCalledWith(
      expect.anything(),
      CALLER,
      [
        { taskId: "a", assignmentVersion: "2026-08-25T12:34:56.123456Z" },
        { taskId: "b", assignmentVersion: "2026-08-25T12:34:57.123456Z" },
      ]
    );
  });

  it("answers 204 for an empty or malformed payload instead of erroring a stale client", async () => {
    const app = createTestApp();

    expect((await request(app).post("/api/tasks/acknowledge").send({})).status).toBe(204);
    expect((await request(app).post("/api/tasks/acknowledge").send({ assignments: [] })).status).toBe(204);
    expect((await request(app).post("/api/tasks/acknowledge").send({ assignments: "nope" })).status).toBe(204);
  });

  // An uncommitted tenant transaction leaks a pool connection rather than failing a response, so it is
  // invisible in a status code — which is why the commit is spied on per request. The service-call
  // assertions are what keep this from being green against `GET /:id` swallowing the request, since
  // that handler commits too.
  it("commits the tenant transaction on BOTH routes", async () => {
    const commitTransaction = vi.fn().mockResolvedValue(undefined);
    const app = express();
    app.use(express.json());
    app.use("/api/tasks", (req, _res, next) => {
      (req as any).user = { id: CALLER, role: "rep", displayName: "A", email: "a@b.c", officeId: "o", activeOfficeId: "o" };
      (req as any).tenantDb = {};
      (req as any).commitTransaction = commitTransaction;
      next();
    });
    app.use("/api/tasks", taskRoutes);
    app.use(errorHandler);

    await request(app).get("/api/tasks/pending-acknowledgement").expect(200);
    expect(taskServiceMocks.getPendingAssignmentTasks).toHaveBeenCalledTimes(1);
    expect(commitTransaction).toHaveBeenCalledTimes(1);

    await request(app).post("/api/tasks/acknowledge").send({ assignments: [] }).expect(204);
    expect(taskServiceMocks.acknowledgeTaskAssignments).toHaveBeenCalledTimes(1);
    expect(commitTransaction).toHaveBeenCalledTimes(2);
  });
});
