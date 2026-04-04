import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: { select: vi.fn() },
  pool: {},
}));

const { AppError } = await import("../../../src/middleware/error-handler.ts");
const {
  transitionTaskStatus,
  isTaskIncludedInActiveBuckets,
  getTaskCounts,
} = await import("../../../src/modules/tasks/service.js");

type TaskState = Record<string, any>;

function createTransitionDb(initialTask: TaskState, rows: TaskState[] = []) {
  let currentTask = { ...initialTask };
  let lastUpdate: Record<string, any> | null = null;

  const selectChain: any = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
    then: vi.fn((resolve: any) => resolve([currentTask])),
  };
  selectChain.from.mockReturnValue(selectChain);
  selectChain.where.mockReturnValue(selectChain);
  selectChain.limit.mockReturnValue(selectChain);

  const returning = vi.fn(async () => {
    currentTask = { ...currentTask, ...lastUpdate };
    return [currentTask];
  });

  const updateChain: any = {
    set: vi.fn((updates: Record<string, any>) => {
      lastUpdate = updates;
      return {
        where: vi.fn(() => ({ returning })),
      };
    }),
  };

  return {
    db: {
      select: vi.fn(() => selectChain),
      update: vi.fn(() => updateChain),
      execute: vi.fn(async () => ({ rows })),
    },
    getCurrentTask: () => currentTask,
    getLastUpdate: () => lastUpdate,
  };
}

function makeTask(overrides: TaskState = {}): TaskState {
  return {
    id: "task-1",
    title: "Follow up",
    description: null,
    type: "follow_up",
    priority: "normal",
    status: "pending",
    assignedTo: "user-1",
    createdBy: null,
    dealId: null,
    contactId: null,
    emailId: null,
    dueDate: null,
    dueTime: null,
    remindAt: null,
    completedAt: null,
    isOverdue: false,
    createdAt: new Date("2026-04-01T10:00:00.000Z"),
    updatedAt: new Date("2026-04-01T10:00:00.000Z"),
    scheduledFor: null,
    waitingOn: null,
    blockedBy: null,
    startedAt: null,
    ...overrides,
  };
}

describe("Task Service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects waiting_on transitions without a waitingOn payload", async () => {
    const { db } = createTransitionDb(makeTask());

    await expect(
      transitionTaskStatus(
        db as any,
        "task-1",
        { nextStatus: "waiting_on", waitingOn: null },
        "director",
        "user-1"
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "waitingOn is required when moving a task to waiting_on",
    });
  });

  it("rejects blocked transitions without a blockedBy payload", async () => {
    const { db } = createTransitionDb(makeTask());

    await expect(
      transitionTaskStatus(
        db as any,
        "task-1",
        { nextStatus: "blocked", blockedBy: null },
        "director",
        "user-1"
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "blockedBy is required when moving a task to blocked",
    });
  });

  it("sets startedAt only the first time a task enters in_progress", async () => {
    const clock = new Date("2026-04-04T15:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(clock);

    try {
      const { db, getCurrentTask } = createTransitionDb(makeTask());

      const first = await transitionTaskStatus(
        db as any,
        "task-1",
        { nextStatus: "in_progress" },
        "director",
        "user-1"
      );
      expect(first.status).toBe("in_progress");
      expect(first.startedAt).toEqual(clock);

      const second = await transitionTaskStatus(
        db as any,
        "task-1",
        { nextStatus: "waiting_on", waitingOn: { reason: "waiting on client" } },
        "director",
        "user-1"
      );
      expect(second.status).toBe("waiting_on");
      expect(second.startedAt).toEqual(clock);

      const third = await transitionTaskStatus(
        db as any,
        "task-1",
        { nextStatus: "in_progress" },
        "director",
        "user-1"
      );
      expect(third.status).toBe("in_progress");
      expect(third.startedAt).toEqual(clock);
      expect(getCurrentTask().startedAt).toEqual(clock);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid lifecycle transitions from terminal tasks", async () => {
    const { db } = createTransitionDb(makeTask({ status: "completed" }));

    await expect(
      transitionTaskStatus(
        db as any,
        "task-1",
        { nextStatus: "pending" },
        "director",
        "user-1"
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Task is already completed",
    });
  });

  it("treats scheduled tasks as inactive until their scheduledFor time arrives", () => {
    const now = new Date("2026-04-04T12:00:00.000Z");
    const future = new Date("2026-04-04T14:00:00.000Z");
    const past = new Date("2026-04-04T10:00:00.000Z");

    expect(
      isTaskIncludedInActiveBuckets(
        makeTask({ status: "scheduled", scheduledFor: future }),
        now
      )
    ).toBe(false);
    expect(
      isTaskIncludedInActiveBuckets(
        makeTask({ status: "scheduled", scheduledFor: past }),
        now
      )
    ).toBe(true);
    expect(isTaskIncludedInActiveBuckets(makeTask({ status: "waiting_on" }), now)).toBe(true);
    expect(isTaskIncludedInActiveBuckets(makeTask({ status: "blocked" }), now)).toBe(true);
  });

  it("maps task count rows without changing numeric bucket totals", async () => {
    const { db } = createTransitionDb(makeTask(), [{ overdue: "3", today: "1", upcoming: "5", completed: "2" }]);
    const result = await getTaskCounts(db as any, "user-1");

    expect(result).toEqual({ overdue: 3, today: 1, upcoming: 5, completed: 2 });
  });

  it("exposes AppError status codes for task lifecycle failures", () => {
    const error = new AppError(400, "waitingOn is required when moving a task to waiting_on");
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("waitingOn");
  });
});
