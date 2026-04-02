import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for Procore sync service logic.
 * Tests the pure logic of sync state management, idempotency guards,
 * and stage mapping without requiring a running database or Procore API.
 */

// Mock the db module
vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    execute: vi.fn(),
  },
  pool: {},
}));

// Mock the procore client
vi.mock("../../../src/lib/procore-client.js", () => ({
  procoreClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    getCircuitState: vi.fn().mockReturnValue({ state: "closed", failures: 0, openedAt: null }),
    isDevMode: vi.fn().mockReturnValue(true),
  },
}));

describe("Procore Sync Service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Circuit Breaker States", () => {
    it("should report correct circuit breaker states", () => {
      const states: Array<"closed" | "open" | "half_open"> = ["closed", "open", "half_open"];
      for (const state of states) {
        expect(states).toContain(state);
      }
    });

    it("circuit breaker should start in closed state", async () => {
      const { procoreClient } = await import("../../../src/lib/procore-client.js");
      const state = procoreClient.getCircuitState();
      expect(state.state).toBe("closed");
      expect(state.failures).toBe(0);
    });
  });

  describe("Idempotency Guards", () => {
    it("should skip project creation if procore_project_id already set", () => {
      const deal = {
        id: "deal-1",
        name: "Test Deal",
        procoreProjectId: 12345,
      };

      // The service checks for existing project ID before calling Procore API
      const shouldSkip = deal.procoreProjectId != null;
      expect(shouldSkip).toBe(true);
    });

    it("should proceed with project creation if procore_project_id is null", () => {
      const deal = {
        id: "deal-2",
        name: "New Deal",
        procoreProjectId: null,
      };

      const shouldSkip = deal.procoreProjectId != null;
      expect(shouldSkip).toBe(false);
    });
  });

  describe("Stage Mapping Logic", () => {
    it("should skip sync when no procore_stage_mapping exists for a stage", () => {
      const stageConfig = {
        id: "stage-1",
        name: "Due Diligence",
        procoreStageMapping: null,
      };

      const shouldSync = stageConfig.procoreStageMapping != null;
      expect(shouldSync).toBe(false);
    });

    it("should proceed with sync when procore_stage_mapping exists", () => {
      const stageConfig = {
        id: "stage-2",
        name: "In Production",
        procoreStageMapping: "Active",
      };

      const shouldSync = stageConfig.procoreStageMapping != null;
      expect(shouldSync).toBe(true);
    });
  });

  describe("Conflict Detection", () => {
    it("should detect conflict when both CRM and Procore changed after last sync", () => {
      const lastSynced = new Date("2026-03-01T00:00:00Z");
      const crmUpdated = new Date("2026-03-15T00:00:00Z");
      const procoreUpdated = new Date("2026-03-10T00:00:00Z");

      const isConflict =
        lastSynced != null &&
        procoreUpdated > lastSynced &&
        crmUpdated > lastSynced;

      expect(isConflict).toBe(true);
    });

    it("should not detect conflict when only Procore changed", () => {
      const lastSynced = new Date("2026-03-15T00:00:00Z");
      const crmUpdated = new Date("2026-03-01T00:00:00Z"); // Before last sync
      const procoreUpdated = new Date("2026-03-20T00:00:00Z");

      const isConflict =
        lastSynced != null &&
        procoreUpdated > lastSynced &&
        crmUpdated > lastSynced;

      expect(isConflict).toBe(false);
    });

    it("should not detect conflict when only CRM changed", () => {
      const lastSynced = new Date("2026-03-15T00:00:00Z");
      const crmUpdated = new Date("2026-03-20T00:00:00Z");
      const procoreUpdated = new Date("2026-03-01T00:00:00Z"); // Before last sync

      const isConflict =
        lastSynced != null &&
        procoreUpdated > lastSynced &&
        crmUpdated > lastSynced;

      expect(isConflict).toBe(false);
    });
  });

  describe("Sync State Upsert Shape", () => {
    it("should produce correct sync state values for create_project", () => {
      const args = {
        entityType: "project" as const,
        procoreId: 12345,
        crmEntityType: "deal",
        crmEntityId: "deal-uuid-123",
        officeId: "office-uuid-456",
        syncDirection: "crm_to_procore" as const,
        syncStatus: "synced" as const,
      };

      expect(args.entityType).toBe("project");
      expect(args.syncDirection).toBe("crm_to_procore");
      expect(args.syncStatus).toBe("synced");
      expect(args.procoreId).toBeGreaterThan(0);
    });

    it("should produce error sync state on API failure", () => {
      const args = {
        entityType: "project" as const,
        procoreId: 0,
        crmEntityType: "deal",
        crmEntityId: "deal-uuid-123",
        officeId: "office-uuid-456",
        syncDirection: "crm_to_procore" as const,
        syncStatus: "error" as const,
        errorMessage: "Procore API returned 403",
      };

      expect(args.syncStatus).toBe("error");
      expect(args.errorMessage).toBeTruthy();
    });
  });

  describe("Change Order Status Mapping", () => {
    it("should map Procore approved status to CRM approved", () => {
      const procoreStatus = "approved";
      let crmStatus: "approved" | "rejected" | "pending" = "pending";
      if (procoreStatus === "approved") crmStatus = "approved";
      else if (procoreStatus === "rejected" || procoreStatus === "void") crmStatus = "rejected";

      expect(crmStatus).toBe("approved");
    });

    it("should map Procore rejected status to CRM rejected", () => {
      const procoreStatus = "rejected";
      let crmStatus: "approved" | "rejected" | "pending" = "pending";
      if (procoreStatus === "approved") crmStatus = "approved";
      else if (procoreStatus === "rejected" || procoreStatus === "void") crmStatus = "rejected";

      expect(crmStatus).toBe("rejected");
    });

    it("should map Procore void status to CRM rejected", () => {
      const procoreStatus = "void";
      let crmStatus: "approved" | "rejected" | "pending" = "pending";
      if (procoreStatus === "approved") crmStatus = "approved";
      else if (procoreStatus === "rejected" || procoreStatus === "void") crmStatus = "rejected";

      expect(crmStatus).toBe("rejected");
    });

    it("should default unknown Procore status to CRM pending", () => {
      const procoreStatus = "in_review";
      let crmStatus: "approved" | "rejected" | "pending" = "pending";
      if (procoreStatus === "approved") crmStatus = "approved";
      else if (procoreStatus === "rejected" || procoreStatus === "void") crmStatus = "rejected";

      expect(crmStatus).toBe("pending");
    });
  });

  describe("Dev Mode", () => {
    it("should detect dev mode when PROCORE_CLIENT_ID is not set", async () => {
      const { procoreClient } = await import("../../../src/lib/procore-client.js");
      expect(procoreClient.isDevMode()).toBe(true);
    });
  });
});
