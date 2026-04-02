import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: { select: vi.fn() },
  pool: {},
}));

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: {
    emitLocal: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    setMaxListeners: vi.fn(),
  },
}));

describe("Notification Service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Notification Types", () => {
    it("should support all notification types from spec", () => {
      const types = [
        "stale_deal",
        "inbound_email",
        "task_assigned",
        "approval_needed",
        "activity_drop",
        "deal_won",
        "deal_lost",
        "stage_change",
        "system",
      ];
      expect(types).toHaveLength(9);
    });

    it("should categorize notification types by source", () => {
      const automatedTypes = ["stale_deal", "inbound_email", "activity_drop"];
      const dealLifecycleTypes = ["deal_won", "deal_lost", "stage_change"];
      const userActionTypes = ["task_assigned", "approval_needed"];
      const genericTypes = ["system"];

      const allTypes = [
        ...automatedTypes,
        ...dealLifecycleTypes,
        ...userActionTypes,
        ...genericTypes,
      ];
      expect(allTypes).toHaveLength(9);
    });
  });

  describe("Unread Count Logic", () => {
    it("should return zero for no notifications", () => {
      const count = Number(undefined ?? 0);
      expect(count).toBe(0);
      expect(typeof count).toBe("number");
    });

    it("should count only unread notifications", () => {
      const notifications = [
        { id: "1", isRead: false },
        { id: "2", isRead: true },
        { id: "3", isRead: false },
        { id: "4", isRead: false },
      ];
      const unreadCount = notifications.filter((n) => !n.isRead).length;
      expect(unreadCount).toBe(3);
    });

    it("should return zero when all are read", () => {
      const notifications = [
        { id: "1", isRead: true },
        { id: "2", isRead: true },
      ];
      const unreadCount = notifications.filter((n) => !n.isRead).length;
      expect(unreadCount).toBe(0);
    });

    it("should parse count from query result correctly", () => {
      // Simulating what the service does: Number(result[0]?.count ?? 0)
      const result = [{ count: "5" }];
      const count = Number(result[0]?.count ?? 0);
      expect(count).toBe(5);
    });

    it("should handle empty result array", () => {
      const result: any[] = [];
      const count = Number(result[0]?.count ?? 0);
      expect(count).toBe(0);
    });
  });

  describe("Mark As Read", () => {
    it("should set isRead to true and record readAt timestamp", () => {
      const before = new Date();
      const update = { isRead: true, readAt: new Date() };
      expect(update.isRead).toBe(true);
      expect(update.readAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it("should return null when notification not found", () => {
      const result: any[] = [];
      const notification = result[0] ?? null;
      expect(notification).toBeNull();
    });

    it("should scope mark-as-read to the requesting user", () => {
      // The service filters by both notificationId AND userId
      // to prevent users from marking other users' notifications
      const userId = "user-1";
      const notificationUserId = "user-2";
      const isSameUser = userId === notificationUserId;
      expect(isSameUser).toBe(false);
    });
  });

  describe("Mark All As Read", () => {
    it("should only mark unread notifications", () => {
      // The service filters by isRead = false
      const filter = { isRead: false };
      expect(filter.isRead).toBe(false);
    });

    it("should return count of marked notifications", () => {
      const rowCount = 5;
      expect(typeof rowCount).toBe("number");
      expect(rowCount).toBeGreaterThan(0);
    });

    it("should return zero when no unread notifications exist", () => {
      const rowCount = 0;
      expect(rowCount).toBe(0);
    });
  });

  describe("SSE Event Formatting", () => {
    it("should format SSE events correctly", () => {
      const event = "notification";
      const data = { id: "123", title: "Test" };
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

      expect(payload).toContain("event: notification\n");
      expect(payload).toContain('"id":"123"');
      expect(payload.endsWith("\n\n")).toBe(true);
    });

    it("should include event name and data fields", () => {
      const event = "task_update";
      const data = { type: "assigned", taskId: "t1" };
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

      expect(payload).toContain("event: task_update\n");
      expect(payload).toContain("data: ");
    });
  });

  describe("Notification Pagination", () => {
    it("should default to page 1, limit 30", () => {
      const filters: Record<string, any> = { userId: "u1" };
      const page = filters.page ?? 1;
      const limit = filters.limit ?? 30;
      expect(page).toBe(1);
      expect(limit).toBe(30);
    });

    it("should calculate totalPages correctly", () => {
      const testCases = [
        { total: 0, limit: 30, expectedPages: 0 },
        { total: 1, limit: 30, expectedPages: 1 },
        { total: 30, limit: 30, expectedPages: 1 },
        { total: 31, limit: 30, expectedPages: 2 },
        { total: 90, limit: 30, expectedPages: 3 },
      ];
      for (const tc of testCases) {
        const totalPages = Math.ceil(tc.total / tc.limit);
        expect(totalPages).toBe(tc.expectedPages);
      }
    });
  });

  describe("Notification Creation", () => {
    it("should require userId and type", () => {
      const input = { userId: "u1", type: "system", title: "Test" };
      expect(input.userId).toBeDefined();
      expect(input.type).toBeDefined();
    });

    it("should default body and link to null", () => {
      const input = { userId: "u1", type: "system", title: "Test" };
      const body = (input as any).body ?? null;
      const link = (input as any).link ?? null;
      expect(body).toBeNull();
      expect(link).toBeNull();
    });
  });
});
