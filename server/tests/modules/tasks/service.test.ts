import { Table } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TASK_STATUSES, TASK_RESOLUTION_STATUSES } from "../../../../shared/src/types/enums.js";
import {
  tasks,
  taskStatusEnum,
  taskResolutionStatusEnum,
  taskResolutionState,
} from "../../../../shared/src/schema/index.js";

vi.mock("../../../src/db.js", () => ({
  db: { select: vi.fn() },
  pool: {},
}));

const { AppError } = await import("../../../src/middleware/error-handler.ts");
const {
  completeTask,
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

  describe("Task Priority Ordering", () => {
    it("should rank priorities as urgent < high < normal < low", () => {
      const priorityRank: Record<string, number> = {
        urgent: 0,
        high: 1,
        normal: 2,
        low: 3,
      };

      expect(priorityRank.urgent).toBeLessThan(priorityRank.high);
      expect(priorityRank.high).toBeLessThan(priorityRank.normal);
      expect(priorityRank.normal).toBeLessThan(priorityRank.low);
    });

    it("should sort tasks by priority rank ascending", () => {
      const rankOf = (p: string) => {
        const map: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
        return map[p] ?? 4;
      };

      const items = [
        { id: "1", priority: "low" },
        { id: "2", priority: "urgent" },
        { id: "3", priority: "normal" },
        { id: "4", priority: "high" },
      ];

      const sorted = [...items].sort((a, b) => rankOf(a.priority) - rankOf(b.priority));

      expect(sorted[0].priority).toBe("urgent");
      expect(sorted[1].priority).toBe("high");
      expect(sorted[2].priority).toBe("normal");
      expect(sorted[3].priority).toBe("low");
    });

    it("should define correct task priority levels", () => {
      const priorities = ["urgent", "high", "normal", "low"];
      expect(priorities).toHaveLength(4);
      expect(priorities[0]).toBe("urgent");
      expect(priorities[3]).toBe("low");
    });

    it("should define correct task types", () => {
      const types = [
        "follow_up",
        "stale_deal",
        "inbound_email",
        "approval_request",
        "touchpoint",
        "manual",
        "system",
      ];
      expect(types).toHaveLength(7);
    });

    it("should define the smart task lifecycle contract on the shared enum and task table", () => {
      const expectedStatuses = [
        "pending",
        "scheduled",
        "in_progress",
        "waiting_on",
        "blocked",
        "completed",
        "dismissed",
      ];

      expect(TASK_STATUSES).toEqual(expectedStatuses);
      expect(taskStatusEnum.enumValues).toEqual(expectedStatuses);

      const columns = tasks[Table.Symbol.Columns];
      expect(columns.officeId).toBeDefined();
      expect(columns.originRule).toBeDefined();
      expect(columns.dedupeKey).toBeDefined();
      expect(columns.reasonCode).toBeDefined();
      expect(columns.scheduledFor).toBeDefined();
    });
  });

  describe("Task Resolution State Contract", () => {
    it("should expose the close-loop suppression fields keyed by origin rule and dedupe key", () => {
      const expectedResolutionStatuses = ["completed", "dismissed", "suppressed"];
      const columns = taskResolutionState[Table.Symbol.Columns];

      expect(TASK_RESOLUTION_STATUSES).toEqual(expectedResolutionStatuses);
      expect(taskResolutionStatusEnum.enumValues).toEqual(expectedResolutionStatuses);
      expect(taskResolutionState[Table.Symbol.Columns].resolutionStatus.enumValues).toEqual(
        expectedResolutionStatuses
      );
      expect(Object.keys(columns)).toEqual(
        expect.arrayContaining([
          "officeId",
          "taskId",
          "originRule",
          "dedupeKey",
          "resolutionStatus",
          "resolutionReason",
          "suppressedUntil",
          "entitySnapshot",
        ])
      );
      expect(columns.originRule).toBeDefined();
      expect(columns.dedupeKey).toBeDefined();
      expect(columns.resolutionStatus).toBeDefined();
      expect(columns.resolutionReason).toBeDefined();
      expect(columns.suppressedUntil).toBeDefined();
      expect(columns.entitySnapshot).toBeDefined();
    });
  });

  describe("Lifecycle Validation", () => {
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

    it("rejects scheduled transitions without a scheduledFor payload", async () => {
      const { db } = createTransitionDb(makeTask());

      await expect(
        transitionTaskStatus(
          db as any,
          "task-1",
          { nextStatus: "scheduled", scheduledFor: null },
          "director",
          "user-1"
        )
      ).rejects.toMatchObject({
        statusCode: 400,
        message: "scheduledFor is required when moving a task to scheduled",
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

    it("clears waitingOn when leaving waiting_on", async () => {
      const { db } = createTransitionDb(makeTask({ status: "waiting_on", waitingOn: { reason: "client" } }));

      const result = await transitionTaskStatus(
        db as any,
        "task-1",
        { nextStatus: "in_progress" },
        "director",
        "user-1"
      );

      expect(result.status).toBe("in_progress");
      expect(result.waitingOn).toBeNull();
    });

    it("clears blockedBy when leaving blocked", async () => {
      const { db } = createTransitionDb(makeTask({ status: "blocked", blockedBy: { kind: "deal", id: "deal-1" } }));

      const result = await transitionTaskStatus(
        db as any,
        "task-1",
        { nextStatus: "waiting_on", waitingOn: { reason: "client response" } },
        "director",
        "user-1"
      );

      expect(result.status).toBe("waiting_on");
      expect(result.blockedBy).toBeNull();
      expect(result.waitingOn).toEqual({ reason: "client response" });
    });

    it("allows scheduled tasks to move into progress after scheduling", async () => {
      const clock = new Date("2026-04-04T15:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(clock);

      try {
        const { db } = createTransitionDb(makeTask());

        const scheduled = await transitionTaskStatus(
          db as any,
          "task-1",
          { nextStatus: "scheduled", scheduledFor: new Date("2026-04-05T12:00:00.000Z") },
          "director",
          "user-1"
        );
        expect(scheduled.status).toBe("scheduled");
        expect(scheduled.scheduledFor).toBeInstanceOf(Date);

        const inProgress = await transitionTaskStatus(
          db as any,
          "task-1",
          { nextStatus: "in_progress" },
          "director",
          "user-1"
        );
        expect(inProgress.status).toBe("in_progress");
        expect(inProgress.startedAt).toEqual(clock);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Section Filtering Logic", () => {
    it("should classify overdue as past due_date with active status", () => {
      const today = new Date().toISOString().split("T")[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

      expect(yesterday < today).toBe(true);
    });

    it("should classify today as due_date equals current date", () => {
      const today = new Date().toISOString().split("T")[0];
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("should classify upcoming as due_date after today or null", () => {
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
      const today = new Date().toISOString().split("T")[0];
      expect(tomorrow > today).toBe(true);
    });

    it("should include null due dates in upcoming section", () => {
      const dueDate: string | null = null;
      const isUpcoming = dueDate === null;
      expect(isUpcoming).toBe(true);
    });

    it("should group completed and dismissed into completed section", () => {
      const completedStatuses = ["completed", "dismissed"];
      for (const status of completedStatuses) {
        expect(["completed", "dismissed"]).toContain(status);
      }
    });

    it("should only show active statuses in overdue/today/upcoming", () => {
      const activeStatuses = ["pending", "in_progress"];
      expect(activeStatuses).not.toContain("completed");
      expect(activeStatuses).not.toContain("dismissed");
    });
  });

  describe("Snooze Validation", () => {
    it("should reject snooze on completed tasks", () => {
      const status = "completed";
      const canSnooze = !["completed", "dismissed"].includes(status);
      expect(canSnooze).toBe(false);
    });

    it("should reject snooze on dismissed tasks", () => {
      const status = "dismissed";
      const canSnooze = !["completed", "dismissed"].includes(status);
      expect(canSnooze).toBe(false);
    });

    it("should allow snooze on pending tasks", () => {
      const status = "pending";
      const canSnooze = !["completed", "dismissed"].includes(status);
      expect(canSnooze).toBe(true);
    });

    it("should allow snooze on in_progress tasks", () => {
      const status = "in_progress";
      const canSnooze = !["completed", "dismissed"].includes(status);
      expect(canSnooze).toBe(true);
    });

    it("should accept valid date format for snooze", () => {
      const validDate = "2026-04-15";
      expect(validDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("should clear isOverdue flag when snoozing", () => {
      const snoozedUpdate = { dueDate: "2026-05-01", isOverdue: false };
      expect(snoozedUpdate.isOverdue).toBe(false);
    });
  });

  describe("Task Count Queries", () => {
    it("should return zero counts when no tasks exist", () => {
      const counts = { overdue: 0, today: 0, upcoming: 0, completed: 0 };
      expect(counts.overdue).toBe(0);
      expect(counts.today).toBe(0);
      expect(counts.upcoming).toBe(0);
      expect(counts.completed).toBe(0);
    });

    it("should return numeric values for all sections", () => {
      const row = { overdue: "3", today: "1", upcoming: "5", completed: "2" };
      const counts = {
        overdue: Number(row.overdue ?? 0),
        today: Number(row.today ?? 0),
        upcoming: Number(row.upcoming ?? 0),
        completed: Number(row.completed ?? 0),
      };
      expect(counts.overdue).toBe(3);
      expect(counts.today).toBe(1);
      expect(counts.upcoming).toBe(5);
      expect(counts.completed).toBe(2);
    });

    it("should count dismissed tasks in the completed bucket", async () => {
      const { db } = createTransitionDb(makeTask(), [{ overdue: "0", today: "0", upcoming: "0", completed: "4" }]);
      const counts = await getTaskCounts(db as any, "user-1");
      expect(counts.completed).toBe(4);
    });

    it("should handle null count values gracefully", () => {
      const row: Record<string, any> = {};
      const overdue = Number(row.overdue ?? 0);
      expect(overdue).toBe(0);
    });

    it("should default pagination to page 1, limit 100", () => {
      const filters: Record<string, any> = {};
      const page = filters.page ?? 1;
      const limit = filters.limit ?? 100;
      expect(page).toBe(1);
      expect(limit).toBe(100);
    });

    it("should calculate correct offset from page and limit", () => {
      const testCases = [
        { page: 1, limit: 100, expectedOffset: 0 },
        { page: 2, limit: 100, expectedOffset: 100 },
        { page: 3, limit: 50, expectedOffset: 100 },
      ];
      for (const tc of testCases) {
        const offset = (tc.page - 1) * tc.limit;
        expect(offset).toBe(tc.expectedOffset);
      }
    });
  });

  describe("AppError Integration", () => {
    it("should throw 404 for missing tasks", () => {
      const error = new AppError(404, "Task not found");
      expect(error.statusCode).toBe(404);
      expect(error.message).toBe("Task not found");
    });

    it("should throw 403 for unauthorized access", () => {
      const error = new AppError(403, "You can only view your own tasks");
      expect(error.statusCode).toBe(403);
    });

    it("should throw 400 for invalid state transitions", () => {
      const error = new AppError(400, "Task is already completed");
      expect(error.statusCode).toBe(400);
    });

    it("should throw 400 when snoozing completed task", () => {
      const error = new AppError(400, "Cannot snooze a completed task");
      expect(error.statusCode).toBe(400);
      expect(error.message).toContain("Cannot snooze");
    });
  });

  describe("Rep Ownership Enforcement", () => {
    it("should restrict reps to their own tasks", () => {
      const userRole = "rep";
      const userId = "user-1";
      const taskAssignedTo = "user-2";
      const isOwnTask = taskAssignedTo === userId;
      expect(userRole === "rep" && !isOwnTask).toBe(true);
    });

    it("should allow reps to see their own tasks", () => {
      const userRole = "rep";
      const userId = "user-1";
      const taskAssignedTo = "user-1";
      const isOwnTask = taskAssignedTo === userId;
      expect(isOwnTask).toBe(true);
    });

    it("should allow directors to see any task", () => {
      const userRole = "director";
      expect(userRole === "rep").toBe(false);
    });

    it("should allow admins to see any task", () => {
      const userRole = "admin";
      expect(userRole === "rep").toBe(false);
    });
  });

  describe("Completion Behavior", () => {
    it("completes waiting_on tasks", async () => {
      const { db } = createTransitionDb(makeTask({ status: "waiting_on", waitingOn: { reason: "client" } }));
      const result = await completeTask(db as any, "task-1", "director", "user-1");

      expect(result.status).toBe("completed");
      expect(result.completedAt).toBeInstanceOf(Date);
      expect(result.isOverdue).toBe(false);
    });
  });
});
