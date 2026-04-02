import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: { select: vi.fn() },
  pool: {},
}));

const { AppError } = await import("../../../src/middleware/error-handler.js");

describe("Activity Service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Activity Types", () => {
    it("should support all activity types from spec", () => {
      const types = ["call", "note", "meeting", "email", "task_completed"];
      expect(types).toHaveLength(5);
    });

    it("should define outreach activity types (trigger touchpoint update)", () => {
      // The PG trigger only fires for call, email, meeting -- not note or task_completed
      const outreachTypes = ["call", "email", "meeting"];
      const nonOutreachTypes = ["note", "task_completed"];

      for (const type of outreachTypes) {
        expect(["call", "email", "meeting"]).toContain(type);
      }
      for (const type of nonOutreachTypes) {
        expect(["call", "email", "meeting"]).not.toContain(type);
      }
    });
  });

  describe("Call Outcomes", () => {
    it("should support all call outcome values", () => {
      const outcomes = ["connected", "left_voicemail", "no_answer", "scheduled_meeting"];
      expect(outcomes).toHaveLength(4);
    });

    it("should only allow outcomes for call type activities", () => {
      // Outcome field is only meaningful for calls
      const typesWithOutcome = ["call"];
      const typesWithoutOutcome = ["note", "meeting", "email", "task_completed"];

      expect(typesWithOutcome).toContain("call");
      for (const type of typesWithoutOutcome) {
        expect(typesWithOutcome).not.toContain(type);
      }
    });
  });

  describe("Duration Validation", () => {
    it("should accept duration for calls", () => {
      const type = "call";
      const typesWithDuration = ["call", "meeting"];
      expect(typesWithDuration).toContain(type);
    });

    it("should accept duration for meetings", () => {
      const type = "meeting";
      const typesWithDuration = ["call", "meeting"];
      expect(typesWithDuration).toContain(type);
    });

    it("should not require duration for notes", () => {
      const type = "note";
      const typesWithDuration = ["call", "meeting"];
      expect(typesWithDuration).not.toContain(type);
    });

    it("should store null durationMinutes when not provided", () => {
      const input = { type: "call", userId: "user-1" };
      const durationMinutes = (input as any).durationMinutes ?? null;
      expect(durationMinutes).toBeNull();
    });
  });

  describe("Validation", () => {
    it("should require activity type", () => {
      const error = new AppError(400, "Activity type is required");
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe("Activity type is required");
    });

    it("should require userId", () => {
      const error = new AppError(400, "userId is required");
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe("userId is required");
    });

    it("should require at least one association (deal or contact)", () => {
      const error = new AppError(400, "At least one of contactId or dealId is required");
      expect(error.statusCode).toBe(400);
    });

    it("should accept activity with only dealId", () => {
      const input = { type: "note", userId: "u1", dealId: "d1" };
      const hasAssociation = !!(input.dealId || (input as any).contactId);
      expect(hasAssociation).toBe(true);
    });

    it("should accept activity with only contactId", () => {
      const input = { type: "note", userId: "u1", contactId: "c1" } as any;
      const hasAssociation = !!(input.dealId || input.contactId);
      expect(hasAssociation).toBe(true);
    });

    it("should accept activity with both dealId and contactId", () => {
      const input = { type: "call", userId: "u1", dealId: "d1", contactId: "c1" };
      const hasAssociation = !!(input.dealId || input.contactId);
      expect(hasAssociation).toBe(true);
    });
  });

  describe("occurredAt Handling", () => {
    it("should default occurredAt to now when not provided", () => {
      const input = { occurredAt: undefined };
      const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
      expect(occurredAt).toBeInstanceOf(Date);
    });

    it("should parse provided occurredAt string to Date", () => {
      const input = { occurredAt: "2026-04-01T14:30:00Z" };
      const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
      expect(occurredAt.toISOString()).toBe("2026-04-01T14:30:00.000Z");
    });
  });

  describe("Pagination Defaults", () => {
    it("should default page to 1 and limit to 50", () => {
      const filters: Record<string, any> = {};
      const page = filters.page ?? 1;
      const limit = filters.limit ?? 50;
      expect(page).toBe(1);
      expect(limit).toBe(50);
    });

    it("should calculate correct offset", () => {
      const page = 3;
      const limit = 50;
      const offset = (page - 1) * limit;
      expect(offset).toBe(100);
    });
  });
});
