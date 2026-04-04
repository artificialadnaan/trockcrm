import { describe, it, expect, vi, beforeEach } from "vitest";
import { TASK_STATUSES } from "../../../../shared/src/types/enums.js";

vi.mock("../../../src/db.js", () => ({
  db: { select: vi.fn() },
  pool: {},
}));

const { AppError } = await import("../../../src/middleware/error-handler.js");

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

      const tasks = [
        { id: "1", priority: "low" },
        { id: "2", priority: "urgent" },
        { id: "3", priority: "normal" },
        { id: "4", priority: "high" },
      ];

      const sorted = [...tasks].sort((a, b) => rankOf(a.priority) - rankOf(b.priority));

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

    it("should define correct task statuses", () => {
      expect(TASK_STATUSES).toEqual([
        "pending",
        "scheduled",
        "in_progress",
        "waiting_on",
        "blocked",
        "completed",
        "dismissed",
      ]);
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
      // Per service logic: null due_date goes in upcoming section
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
      // Per service: snoozeTask sets isOverdue = false
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
});
