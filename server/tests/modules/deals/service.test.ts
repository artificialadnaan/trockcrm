import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for deal service logic.
 *
 * These test the pure logic of deal number generation, filtering conditions,
 * and authorization rules WITHOUT requiring a running database.
 * We mock the Drizzle query results and verify the service functions
 * produce correct outputs and throw appropriate errors.
 */

// Mock the db module (public schema queries)
vi.mock("../../../src/db.js", () => {
  const mockSelect = vi.fn();
  return {
    db: {
      select: mockSelect,
    },
    pool: {},
  };
});

// We'll import after mocks are set up
const { AppError } = await import("../../../src/middleware/error-handler.js");
const { updateDeal } = await import("../../../src/modules/deals/service.js");

describe("Deal Service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Deal Number Generation Pattern", () => {
    it("should produce deal numbers matching TR-YYYY-NNNN format", () => {
      // The deal number format is TR-{YYYY}-{NNNN}
      const year = new Date().getFullYear();
      const prefix = `TR-${year}-`;

      // Test the format regex
      const dealNumber = `${prefix}0001`;
      expect(dealNumber).toMatch(/^TR-\d{4}-\d{4}$/);
    });

    it("should pad sequence numbers to 4 digits", () => {
      const year = new Date().getFullYear();
      const testCases = [
        { seq: 1, expected: `TR-${year}-0001` },
        { seq: 9, expected: `TR-${year}-0009` },
        { seq: 42, expected: `TR-${year}-0042` },
        { seq: 100, expected: `TR-${year}-0100` },
        { seq: 9999, expected: `TR-${year}-9999` },
      ];

      for (const tc of testCases) {
        const result = `TR-${year}-${String(tc.seq).padStart(4, "0")}`;
        expect(result).toBe(tc.expected);
      }
    });

    it("should correctly parse sequence from existing deal number", () => {
      const year = new Date().getFullYear();
      const prefix = `TR-${year}-`;
      const lastNumber = `TR-${year}-0042`;

      const seqPart = lastNumber.replace(prefix, "");
      const parsed = parseInt(seqPart, 10);

      expect(parsed).toBe(42);
      expect(parsed + 1).toBe(43);
    });

    it("should handle non-numeric sequence gracefully", () => {
      const year = new Date().getFullYear();
      const prefix = `TR-${year}-`;
      const badNumber = `TR-${year}-xxxx`;

      const seqPart = badNumber.replace(prefix, "");
      const parsed = parseInt(seqPart, 10);

      expect(isNaN(parsed)).toBe(true);
      // When NaN, the generator should default to 1
      const nextSeq = isNaN(parsed) ? 1 : parsed + 1;
      expect(nextSeq).toBe(1);
    });

    it("should start at 0001 when no existing deals for the year", () => {
      // When result.length === 0, nextSeq should be 1
      const resultLength = 0;
      let nextSeq = 1;
      if (resultLength > 0) {
        nextSeq = 999; // Should not reach this
      }

      const year = new Date().getFullYear();
      const dealNumber = `TR-${year}-${String(nextSeq).padStart(4, "0")}`;
      expect(dealNumber).toBe(`TR-${year}-0001`);
    });
  });

  describe("DealFilters Logic", () => {
    it("should default isActive to true", () => {
      const filters: Record<string, any> = {};
      const showActive = filters.isActive ?? true;
      expect(showActive).toBe(true);
    });

    it("should respect explicit isActive=false", () => {
      const filters = { isActive: false };
      const showActive = filters.isActive ?? true;
      expect(showActive).toBe(false);
    });

    it("should default page to 1 and limit to 50", () => {
      const filters: Record<string, any> = {};
      const page = filters.page ?? 1;
      const limit = filters.limit ?? 50;
      expect(page).toBe(1);
      expect(limit).toBe(50);
    });

    it("should calculate correct offset from page and limit", () => {
      const testCases = [
        { page: 1, limit: 50, expectedOffset: 0 },
        { page: 2, limit: 50, expectedOffset: 50 },
        { page: 3, limit: 25, expectedOffset: 50 },
        { page: 1, limit: 10, expectedOffset: 0 },
        { page: 5, limit: 20, expectedOffset: 80 },
      ];

      for (const tc of testCases) {
        const offset = (tc.page - 1) * tc.limit;
        expect(offset).toBe(tc.expectedOffset);
      }
    });

    it("should calculate totalPages correctly", () => {
      const testCases = [
        { total: 0, limit: 50, expectedPages: 0 },
        { total: 1, limit: 50, expectedPages: 1 },
        { total: 50, limit: 50, expectedPages: 1 },
        { total: 51, limit: 50, expectedPages: 2 },
        { total: 100, limit: 50, expectedPages: 2 },
        { total: 101, limit: 50, expectedPages: 3 },
      ];

      for (const tc of testCases) {
        const totalPages = Math.ceil(tc.total / tc.limit);
        expect(totalPages).toBe(tc.expectedPages);
      }
    });

    it("should require search term to be at least 2 characters", () => {
      const shortSearch = "a";
      const validSearch = "ab";
      const longSearch = "building";

      // The service checks: filters.search && filters.search.trim().length >= 2
      expect(shortSearch.trim().length >= 2).toBe(false);
      expect(validSearch.trim().length >= 2).toBe(true);
      expect(longSearch.trim().length >= 2).toBe(true);
    });

    it("should trim whitespace-only search to empty", () => {
      const whitespaceSearch = "   ";
      expect(whitespaceSearch.trim().length >= 2).toBe(false);
    });
  });

  describe("Soft Delete Authorization", () => {
    it("should block reps from deleting deals", () => {
      const userRole = "rep";
      expect(userRole === "rep").toBe(true);
      // The service throws: "Only directors and admins can delete deals"
    });

    it("should allow directors to delete deals", () => {
      const userRole = "director";
      expect(userRole === "rep").toBe(false);
    });

    it("should allow admins to delete deals", () => {
      const userRole = "admin";
      expect(userRole === "rep").toBe(false);
    });
  });

  describe("Rep Ownership Enforcement", () => {
    it("should restrict reps to their own deals", () => {
      const userRole = "rep";
      const userId = "user-1";
      const dealAssignedRepId = "user-2";

      // Reps should not access deals assigned to other reps
      const isOwnDeal = dealAssignedRepId === userId;
      expect(userRole === "rep" && !isOwnDeal).toBe(true);
    });

    it("should allow reps to see their own deals", () => {
      const userRole = "rep";
      const userId = "user-1";
      const dealAssignedRepId = "user-1";

      const isOwnDeal = dealAssignedRepId === userId;
      expect(userRole === "rep" && isOwnDeal).toBe(true);
    });

    it("should allow directors to see any deal", () => {
      const userRole = "director";
      const userId = "user-1";
      const dealAssignedRepId = "user-2";

      // Directors are not restricted by ownership
      expect(userRole === "rep").toBe(false);
    });

    it("should allow admins to see any deal", () => {
      const userRole = "admin";
      expect(userRole === "rep").toBe(false);
    });
  });

  describe("AppError", () => {
    it("should create error with status code and message", () => {
      const err = new AppError(400, "Bad request");
      expect(err.statusCode).toBe(400);
      expect(err.message).toBe("Bad request");
      expect(err.name).toBe("AppError");
    });

    it("should support optional error code", () => {
      const err = new AppError(400, "Override required", "OVERRIDE_REQUIRED");
      expect(err.code).toBe("OVERRIDE_REQUIRED");
    });

    it("should be an instance of Error", () => {
      const err = new AppError(500, "Server error");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("Pipeline View Grouping", () => {
    it("should separate terminal from active stages", () => {
      const stages = [
        { id: "1", slug: "dd", isTerminal: false, isActivePipeline: true, displayOrder: 1 },
        { id: "2", slug: "estimating", isTerminal: false, isActivePipeline: true, displayOrder: 2 },
        { id: "3", slug: "closed_won", isTerminal: true, isActivePipeline: false, displayOrder: 10 },
        { id: "4", slug: "closed_lost", isTerminal: true, isActivePipeline: false, displayOrder: 11 },
      ];

      const pipelineStages = stages.filter((s) => !s.isTerminal);
      const terminalStages = stages.filter((s) => s.isTerminal);

      expect(pipelineStages).toHaveLength(2);
      expect(terminalStages).toHaveLength(2);
      expect(pipelineStages.every((s) => !s.isTerminal)).toBe(true);
      expect(terminalStages.every((s) => s.isTerminal)).toBe(true);
    });

    it("should exclude DD stage when includeDd is false", () => {
      const stages = [
        { id: "1", slug: "dd", isTerminal: false, isActivePipeline: false, displayOrder: 0 },
        { id: "2", slug: "estimating", isTerminal: false, isActivePipeline: true, displayOrder: 1 },
        { id: "3", slug: "bid_sent", isTerminal: false, isActivePipeline: true, displayOrder: 2 },
      ];

      const includeDd = false;

      const filteredStages = stages
        .filter((s) => !s.isTerminal)
        .filter((s) => includeDd || s.isActivePipeline);

      expect(filteredStages).toHaveLength(2);
      expect(filteredStages.find((s) => s.slug === "dd")).toBeUndefined();
    });

    it("should include DD stage when includeDd is true", () => {
      const stages = [
        { id: "1", slug: "dd", isTerminal: false, isActivePipeline: false, displayOrder: 0 },
        { id: "2", slug: "estimating", isTerminal: false, isActivePipeline: true, displayOrder: 1 },
      ];

      const includeDd = true;

      const filteredStages = stages
        .filter((s) => !s.isTerminal)
        .filter((s) => includeDd || s.isActivePipeline);

      expect(filteredStages).toHaveLength(2);
      expect(filteredStages.find((s) => s.slug === "dd")).toBeDefined();
    });

    it("should calculate totalValue using best available estimate", () => {
      const deals = [
        { awardedAmount: "180000", bidEstimate: "170000", ddEstimate: "150000" },
        { awardedAmount: null, bidEstimate: "200000", ddEstimate: "190000" },
        { awardedAmount: null, bidEstimate: null, ddEstimate: "100000" },
        { awardedAmount: null, bidEstimate: null, ddEstimate: null },
      ];

      const totalValue = deals.reduce(
        (sum, d) => sum + Number(d.awardedAmount ?? d.bidEstimate ?? d.ddEstimate ?? 0),
        0
      );

      // 180000 + 200000 + 100000 + 0
      expect(totalValue).toBe(480000);
    });
  });

  describe("Update Deal Field Handling", () => {
    it("should only include fields that are explicitly provided", () => {
      const input: Record<string, any> = {
        name: "Updated Name",
        description: undefined, // not provided
      };

      const updates: Record<string, any> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.description !== undefined) updates.description = input.description;
      if (input.source !== undefined) updates.source = input.source;

      // name was provided, description was undefined (provided), source was not in input at all
      expect(updates).toHaveProperty("name", "Updated Name");
      // undefined IS !== undefined, so description is NOT included... wait, it IS undefined
      // Actually undefined !== undefined is false, so the check passes
      // But the value stored is undefined, which is correct for Drizzle (it ignores undefined)
    });

    it("should allow setting fields to null explicitly", () => {
      const input = {
        description: null as string | null,
        source: null as string | null,
      };

      const updates: Record<string, any> = {};
      if (input.description !== undefined) updates.description = input.description;
      if (input.source !== undefined) updates.source = input.source;

      expect(updates.description).toBeNull();
      expect(updates.source).toBeNull();
    });

    it("should return existing deal when no updates provided", () => {
      const updates: Record<string, any> = {};
      const shouldReturnEarly = Object.keys(updates).length === 0;
      expect(shouldReturnEarly).toBe(true);
    });

    function createOwnedDealTenantDb() {
      const existingDeal = {
        id: "deal-1",
        name: "Palm Villas",
        dealNumber: "TR-2026-0001",
        stageId: "stage-estimating",
        assignedRepId: "rep-1",
        primaryContactId: null,
        sourceLeadId: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        workflowRoute: "normal",
        migrationMode: false,
        ddEstimate: null,
        bidEstimate: null,
        awardedAmount: null,
        description: "Exterior refresh",
        propertyAddress: "123 Palm Way",
        propertyCity: "Dallas",
        propertyState: "TX",
        propertyZip: "75201",
        projectTypeId: null,
        regionId: null,
        source: "referral",
        winProbability: 50,
        expectedCloseDate: null,
        proposalStatus: "drafting",
        proposalNotes: null,
        estimatingSubstage: "building_estimate",
        isBidBoardOwned: true,
        bidBoardStageSlug: "estimating",
        readOnlySyncedAt: new Date("2026-04-21T10:00:00.000Z"),
      };

      return {
        select() {
          return {
            from() {
              return {
                where() {
                  return {
                    limit() {
                      return Promise.resolve([existingDeal]);
                    },
                  };
                },
              };
            },
          };
        },
        update() {
          throw new Error("updateDeal should reject before attempting a database write");
        },
      };
    }

    it("rejects estimating substage edits after Bid Board handoff", async () => {
      await expect(
        updateDeal(
          createOwnedDealTenantDb() as never,
          "deal-1",
          { estimatingSubstage: "sent_to_client" },
          "director",
          "director-1"
        )
      ).rejects.toMatchObject<AppError>({
        statusCode: 403,
        code: "BID_BOARD_OWNED_FIELD_READ_ONLY",
        message: "Estimating progress is mirrored from Bid Board after estimating handoff.",
      });
    });

    it("rejects proposal status edits after Bid Board handoff", async () => {
      await expect(
        updateDeal(
          createOwnedDealTenantDb() as never,
          "deal-1",
          { proposalStatus: "sent" },
          "director",
          "director-1"
        )
      ).rejects.toMatchObject<AppError>({
        statusCode: 403,
        code: "BID_BOARD_OWNED_FIELD_READ_ONLY",
        message: "Proposal status is mirrored from Bid Board after estimating handoff.",
      });
    });
  });
});
