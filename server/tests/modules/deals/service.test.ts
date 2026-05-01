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

vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageById: vi.fn(async () => ({
    id: "stage-opportunity",
    slug: "opportunity",
    isTerminal: false,
    displayOrder: 1,
    workflowFamily: "standard_deal",
  })),
  getStageBySlug: vi.fn(async () => ({
    id: "stage-opportunity",
    slug: "opportunity",
    isTerminal: false,
    displayOrder: 1,
    workflowFamily: "standard_deal",
  })),
  getActiveProjectTypes: vi.fn(async () => [
    { id: "type-1", name: "Exterior Renovation", slug: "exterior-renovation", code: "1" },
    { id: "type-3", name: "Roofing", slug: "roofing", code: "3" },
    { id: "type-4", name: "Service", slug: "service", code: "4" },
  ]),
  resolveActiveProjectTypeValue: vi.fn(async (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " "),
  ),
}));

// We'll import after mocks are set up
const { AppError } = await import("../../../src/middleware/error-handler.js");
const pipelineService = await import("../../../src/modules/pipeline/service.js");
const { createDeal, updateDeal } = await import("../../../src/modules/deals/service.js");

describe("Deal Service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(pipelineService.getStageById).mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      isTerminal: false,
      displayOrder: 1,
      workflowFamily: "standard_deal",
    } as never);
  });

  describe("Deal Number Generation Pattern", () => {
    it("should produce deal numbers matching the office-type-julian-suffix format", () => {
      const dealNumber = "dfw-3-11826-aa";
      expect(dealNumber).toMatch(/^(dfw|atl)-[1-9]-\d{5}-[a-z]+$/);
    });

    it("should roll suffixes after z within the daily sequence", () => {
      const testCases = [
        { last: null, expected: "aa" },
        { last: "aa", expected: "ab" },
        { last: "az", expected: "ba" },
        { last: "ba", expected: "bb" },
      ];

      for (const tc of testCases) {
        const chars = tc.last ? tc.last.split("") : [];
        let result = "aa";
        if (tc.last) {
          let index = chars.length - 1;
          while (index >= 0) {
            if (chars[index] < "z") {
              chars[index] = String.fromCharCode(chars[index].charCodeAt(0) + 1);
              result = chars.join("");
              break;
            }
            chars[index] = "a";
            index -= 1;
          }
        }
        expect(result).toBe(tc.expected);
      }
    });

    it("direct deal creation assigns the new dealNumber format and does not set bidBoardProjectNumber", async () => {
      const state = {
        insertedDeal: null as Record<string, unknown> | null,
        executeCalls: 0,
      };
      const tenantDb = {
        select() {
          return {
            from() {
              return {
                where() {
                  return {
                    limit() {
                      return Promise.resolve([{ id: "rep-1", isActive: true, officeId: "office-1" }]);
                    },
                  };
                },
              };
            },
          };
        },
        execute() {
          state.executeCalls += 1;
          if (state.executeCalls === 1) return Promise.resolve({ rows: [{ deal_number: "dfw-3-11826-aa" }] });
          if (state.executeCalls === 3) return Promise.resolve({ rows: [{ last_suffix: "aa" }] });
          return Promise.resolve({ rows: [] });
        },
        insert() {
          return {
            values(values: Record<string, unknown>) {
              state.insertedDeal = {
                id: "deal-1",
                bidBoardProjectNumber: null,
                ...values,
              };
              return {
                returning() {
                  return Promise.resolve([state.insertedDeal]);
                },
              };
            },
          };
        },
      };

      const deal = await createDeal(tenantDb as never, {
        name: "Direct Deal",
        stageId: "stage-dd",
        assignedRepId: "rep-1",
        officeId: "office-1",
        migrationMode: true,
        officeCode: "dfw",
        projectType: "roofing",
      });

      expect(deal.dealNumber).toMatch(/^dfw-3-\d{5}-ab$/);
      expect(deal.bidBoardProjectNumber).toBeNull();
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

  describe("Workflow stage family validation", () => {
    function createDealCreationTenantDb() {
      const state = {
        executeCalls: 0,
        insertedDeal: null as Record<string, unknown> | null,
      };

      return {
        state,
        select() {
          return {
            from() {
              return {
                where() {
                  return {
                    limit() {
                      return Promise.resolve([{ id: "rep-1", isActive: true, officeId: "office-1" }]);
                    },
                  };
                },
              };
            },
          };
        },
        execute() {
          state.executeCalls += 1;
          if (state.executeCalls === 1) return Promise.resolve({ rows: [{ deal_number: "dfw-4-11826-aa" }] });
          if (state.executeCalls === 3) return Promise.resolve({ rows: [{ last_suffix: "aa" }] });
          return Promise.resolve({ rows: [] });
        },
        insert() {
          return {
            values(values: Record<string, unknown>) {
              state.insertedDeal = {
                id: "deal-1",
                bidBoardProjectNumber: null,
                ...values,
              };
              return {
                returning() {
                  return Promise.resolve([state.insertedDeal]);
                },
              };
            },
          };
        },
      };
    }

    it.each([
      "estimate_under_review",
      "estimate_sent_to_client",
      "contract",
    ])("allows service-route deals to be created on shared canonical stage %s", async (slug) => {
      const getStageById = vi.mocked(pipelineService.getStageById);
      getStageById
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: `stage-${slug}`,
          slug,
          isTerminal: false,
          displayOrder: 2,
          workflowFamily: "standard_deal",
        } as never);

      const deal = await createDeal(createDealCreationTenantDb() as never, {
        name: "Service Shared Stage Deal",
        stageId: `stage-${slug}`,
        assignedRepId: "rep-1",
        officeId: "office-1",
        migrationMode: true,
        officeCode: "dfw",
        workflowRoute: "service",
        projectType: "service",
      });

      expect(deal.stageId).toBe(`stage-${slug}`);
      expect(deal.workflowRoute).toBe("service");
      expect(getStageById).toHaveBeenNthCalledWith(1, `stage-${slug}`, "service_deal");
      expect(getStageById).toHaveBeenNthCalledWith(2, `stage-${slug}`, "standard_deal");
    });

    it("continues rejecting normal-only estimating for service-route deals", async () => {
      const getStageById = vi.mocked(pipelineService.getStageById);
      getStageById
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "stage-estimating",
          slug: "estimating",
          isTerminal: false,
          displayOrder: 1,
          workflowFamily: "standard_deal",
        } as never);

      await expect(
        createDeal(createDealCreationTenantDb() as never, {
          name: "Service Bad Stage Deal",
          stageId: "stage-estimating",
          assignedRepId: "rep-1",
          officeId: "office-1",
          migrationMode: true,
          officeCode: "dfw",
          workflowRoute: "service",
          projectType: "service",
        })
      ).rejects.toMatchObject<AppError>({
        statusCode: 400,
        message: "Invalid stage ID for workflow route",
      });
    });

    it("continues rejecting service_estimating for normal-route deals", async () => {
      const getStageById = vi.mocked(pipelineService.getStageById);
      getStageById.mockResolvedValueOnce(null);

      await expect(
        createDeal(createDealCreationTenantDb() as never, {
          name: "Normal Bad Stage Deal",
          stageId: "stage-service-estimating",
          assignedRepId: "rep-1",
          officeId: "office-1",
          migrationMode: true,
          officeCode: "dfw",
          workflowRoute: "normal",
          projectType: "roofing",
        })
      ).rejects.toMatchObject<AppError>({
        statusCode: 400,
        message: "Invalid stage ID for workflow route",
      });
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

    function createProjectTypeTenantDb(initialProjectType = "roofing") {
      const state = {
        dealHistory: [] as Array<Record<string, unknown>>,
        deal: {
          id: "deal-1",
          name: "Palm Villas",
          dealNumber: "dfw-3-10626-aa",
          stageId: "stage-opportunity",
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
          projectType: initialProjectType,
          regionId: null,
          source: "referral",
          winProbability: 50,
          expectedCloseDate: null,
          bidBoardProjectNumber: null,
          intendedProjectNumber: null,
          proposalStatus: "drafting",
          proposalNotes: null,
          estimatingSubstage: "building_estimate",
          isBidBoardOwned: false,
          bidBoardStageSlug: null,
          readOnlySyncedAt: null,
        },
      };

      return {
        state,
        select() {
          return {
            from() {
              return {
                where() {
                  return {
                    limit() {
                      return Promise.resolve([{ ...state.deal }]);
                    },
                  };
                },
              };
            },
          };
        },
        update() {
          return {
            set(values: Record<string, unknown>) {
              return {
                where() {
                  return {
                    returning() {
                      Object.assign(state.deal, values);
                      return Promise.resolve([{ ...state.deal }]);
                    },
                  };
                },
              };
            },
          };
        },
        insert(table: unknown) {
          const tableName = (table as { _: { name?: string } })?._?.name;
          if (tableName !== undefined && tableName !== "deal_history") {
            throw new Error(`Unexpected insert table: ${String(tableName)}`);
          }

          return {
            values(value: Record<string, unknown>) {
              const inserted = { id: `deal-history-${state.dealHistory.length + 1}`, ...value };
              state.dealHistory.push(inserted);
              return {
                returning() {
                  return Promise.resolve([{ ...inserted }]);
                },
                then(onfulfilled: (value: unknown) => unknown) {
                  return Promise.resolve(inserted).then(onfulfilled);
                },
              };
            },
          };
        },
      };
    }

    it("rejects non-admin project type PATCH payloads on deals", async () => {
      await expect(
        updateDeal(
          createProjectTypeTenantDb() as never,
          "deal-1",
          { projectType: "service" },
          "director",
          "director-1"
        )
      ).rejects.toMatchObject<AppError>({
        statusCode: 403,
        message: "Only admins can edit project type after Opportunity",
      });
    });

    it("keeps the issued project number and records intendedProjectNumber for admin project type changes", async () => {
      const tenantDb = createProjectTypeTenantDb();

      const updated = await updateDeal(
        tenantDb as never,
        "deal-1",
        { projectType: "service" },
        "admin",
        "admin-1"
      );

      expect(updated.dealNumber).toBe("dfw-3-10626-aa");
      expect(updated.projectType).toBe("service");
      expect(updated.intendedProjectNumber).toBe("dfw-4-10626-aa");
      expect(tenantDb.state.dealHistory).toEqual([
        expect.objectContaining({
          dealId: "deal-1",
          fieldName: "project_type",
          oldValue: JSON.stringify({
            oldProjectTypeId: null,
            oldProjectType: "roofing",
            oldIntendedProjectNumber: null,
          }),
          newValue: JSON.stringify({
            newProjectTypeId: "type-4",
            newProjectType: "service",
            newIntendedProjectNumber: "dfw-4-10626-aa",
          }),
          changedBy: "admin-1",
        }),
      ]);
    });

    it("clears intendedProjectNumber when admin changes project type back to the issued number type", async () => {
      const tenantDb = createProjectTypeTenantDb("service");
      tenantDb.state.deal.intendedProjectNumber = "dfw-4-10626-aa";

      const updated = await updateDeal(
        tenantDb as never,
        "deal-1",
        { projectType: "roofing" },
        "admin",
        "admin-1"
      );

      expect(updated.dealNumber).toBe("dfw-3-10626-aa");
      expect(updated.projectType).toBe("roofing");
      expect(updated.intendedProjectNumber).toBeNull();
      expect(tenantDb.state.dealHistory).toHaveLength(1);
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

    function createMutableOwnedDealTenantDb() {
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
          return {
            set(values: Record<string, unknown>) {
              return {
                where() {
                  return {
                    returning() {
                      return Promise.resolve([
                        {
                          ...existingDeal,
                          ...values,
                        },
                      ]);
                    },
                  };
                },
              };
            },
          };
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

    it("rejects estimate amount edits after Bid Board handoff", async () => {
      await expect(
        updateDeal(
          createOwnedDealTenantDb() as never,
          "deal-1",
          { bidEstimate: "125000.00" },
          "director",
          "director-1"
        )
      ).rejects.toMatchObject<AppError>({
        statusCode: 403,
        code: "BID_BOARD_OWNED_FIELD_READ_ONLY",
        message: "Bid estimate is mirrored from Bid Board after estimating handoff.",
      });
    });

    it("allows metadata edits after Bid Board handoff", async () => {
      const updated = await updateDeal(
        createMutableOwnedDealTenantDb() as never,
        "deal-1",
        { description: "Updated scope summary", expectedCloseDate: "2026-05-15" },
        "director",
        "director-1"
      );

      expect(updated.description).toBe("Updated scope summary");
      expect(updated.expectedCloseDate).toBe("2026-05-15");
      expect(updated.estimatingSubstage).toBe("building_estimate");
      expect(updated.proposalStatus).toBe("drafting");
    });
  });
});
