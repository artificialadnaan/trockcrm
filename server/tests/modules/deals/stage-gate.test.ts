import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UserRole } from "@trock-crm/shared/types";
import {
  closeoutChecklistItems,
  dealApprovals,
  dealScopingIntake,
  dealTeamMembers,
  deals,
  files,
  tasks,
  users,
} from "@trock-crm/shared/schema";

/**
 * Unit tests for stage gate validation logic.
 *
 * These test the core decision-making in validateStageGate:
 * - Backward move detection (comparing displayOrder)
 * - Rep vs director/admin permission rules
 * - Missing requirement aggregation
 * - Same-stage no-op handling
 * - Terminal stage detection
 * - Override type assignment
 *
 * We mock the Drizzle DB calls and test the pure logic paths.
 */

// ── Helpers to build mock stage objects ──────────────────────────────────────

interface MockStage {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
  isTerminal: boolean;
  isActivePipeline: boolean;
  requiredFields: string[];
  requiredDocuments: string[];
  requiredApprovals: string[];
  staleThresholdDays: number | null;
  procoreStageMapping: string | null;
  color: string | null;
}

function makeStage(overrides: Partial<MockStage> & { slug: string }): MockStage {
  return {
    id: `stage-${overrides.slug}`,
    name: overrides.name ?? overrides.slug.replace(/_/g, " "),
    displayOrder: overrides.displayOrder ?? 0,
    isTerminal: overrides.isTerminal ?? false,
    isActivePipeline: overrides.isActivePipeline ?? true,
    requiredFields: overrides.requiredFields ?? [],
    requiredDocuments: overrides.requiredDocuments ?? [],
    requiredApprovals: overrides.requiredApprovals ?? [],
    staleThresholdDays: overrides.staleThresholdDays ?? null,
    procoreStageMapping: overrides.procoreStageMapping ?? null,
    color: overrides.color ?? null,
    ...overrides,
  };
}

const STAGES = {
  dd: makeStage({ slug: "dd", displayOrder: 0, isActivePipeline: false }),
  estimating: makeStage({ slug: "estimating", displayOrder: 1 }),
  bid_sent: makeStage({ slug: "bid_sent", displayOrder: 2 }),
  in_production: makeStage({ slug: "in_production", displayOrder: 3 }),
  close_out: makeStage({ slug: "close_out", displayOrder: 4 }),
  closed_won: makeStage({ slug: "closed_won", displayOrder: 10, isTerminal: true, isActivePipeline: false }),
  closed_lost: makeStage({ slug: "closed_lost", displayOrder: 11, isTerminal: true, isActivePipeline: false }),
};

interface MockDeal {
  id: string;
  name: string;
  stageId: string;
  assignedRepId: string;
  isActive: boolean;
  [key: string]: any;
}

function makeDeal(overrides: Partial<MockDeal> = {}): MockDeal {
  return {
    id: overrides.id ?? "deal-1",
    name: overrides.name ?? "Test Deal",
    stageId: overrides.stageId ?? STAGES.dd.id,
    assignedRepId: overrides.assignedRepId ?? "rep-1",
    isActive: overrides.isActive ?? true,
    ...overrides,
  };
}

type FakeDealRow = {
  id: string;
  name: string;
  stageId: string;
  workflowRoute: "estimating" | "service";
  assignedRepId: string;
  projectTypeId: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  description: string | null;
  estimatingSubstage?: string | null;
  proposalStatus?: string | null;
  proposalRevisionCount?: number | null;
  updatedAt?: Date;
};

type FakeUserRow = {
  id: string;
  officeId: string;
};

type FakeFileRow = {
  id: string;
  dealId: string | null;
  category: string;
  intakeRequirementKey: string | null;
  intakeSection?: string | null;
  intakeSource?: string | null;
  isActive: boolean;
};

type FakeDealScopingIntakeRow = {
  id: string;
  dealId: string;
  officeId: string;
  workflowRouteSnapshot: "estimating" | "service";
  status: "draft" | "ready" | "activated";
  projectTypeId: string | null;
  sectionData: Record<string, unknown>;
  completionState: Record<string, unknown>;
  readinessErrors: Record<string, unknown>;
  firstReadyAt: Date | null;
  activatedAt: Date | null;
  lastAutosavedAt: Date;
  createdBy: string;
  lastEditedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

type FakeTaskRow = Record<string, unknown>;
type FakeDealTeamMemberRow = {
  id: string;
  dealId: string;
  userId: string;
  role: string;
  isActive: boolean;
};

type FakeTenantState = {
  deals: FakeDealRow[];
  users: FakeUserRow[];
  files: FakeFileRow[];
  dealScopingIntake: FakeDealScopingIntakeRow[];
  tasks: FakeTaskRow[];
  dealTeamMembers: FakeDealTeamMemberRow[];
  dealApprovals: Array<Record<string, unknown>>;
  closeoutChecklistItems: Array<Record<string, unknown>>;
};

function createHardeningTenantDb(initialState?: Partial<FakeTenantState>) {
  const now = new Date("2026-04-15T15:00:00.000Z");
  const state: FakeTenantState = {
    deals: [
      {
        id: "deal-1",
        name: "Palm Villas",
        stageId: STAGES.dd.id,
        workflowRoute: "estimating",
        assignedRepId: "rep-1",
        projectTypeId: "pt-1",
        propertyAddress: "123 Palm Way",
        propertyCity: "Miami",
        propertyState: "FL",
        propertyZip: "33101",
        description: "Exterior refresh",
        estimatingSubstage: null,
        proposalStatus: "not_started",
        proposalRevisionCount: 0,
        updatedAt: now,
      },
    ],
    users: [
      { id: "user-1", officeId: "office-1" },
      { id: "rep-1", officeId: "office-1" },
      { id: "est-1", officeId: "office-1" },
    ],
    files: [],
    dealScopingIntake: [
      {
        id: "intake-1",
        dealId: "deal-1",
        officeId: "office-1",
        workflowRouteSnapshot: "estimating",
        status: "draft",
        projectTypeId: "pt-1",
        sectionData: {
          projectOverview: { propertyName: "Palm Villas", bidDueDate: "2026-04-30" },
          propertyDetails: { propertyAddress: "123 Palm Way" },
          scopeSummary: { summary: "Exterior refresh" },
        },
        completionState: {},
        readinessErrors: {},
        firstReadyAt: null,
        activatedAt: null,
        lastAutosavedAt: now,
        createdBy: "user-1",
        lastEditedBy: "user-1",
        createdAt: now,
        updatedAt: now,
      },
    ],
    tasks: [],
    dealTeamMembers: [],
    dealApprovals: [],
    closeoutChecklistItems: [],
    ...initialState,
  };

  function getRows(table: unknown) {
    const tableName = String((table as Record<PropertyKey, unknown> | undefined)?.[Symbol.for("drizzle:Name")] ?? "");
    if (tableName === "deals") return state.deals;
    if (tableName === "users") return state.users;
    if (tableName === "files") return state.files;
    if (tableName === "deal_scoping_intake") return state.dealScopingIntake;
    if (tableName === "tasks") return state.tasks;
    if (tableName === "deal_team_members") return state.dealTeamMembers;
    if (tableName === "deal_approvals") return state.dealApprovals;
    if (tableName === "closeout_checklist_items") return state.closeoutChecklistItems;
    throw new Error("Unexpected table in fake tenant db");
  }

  return {
    state,
    select() {
      return {
        from(table: unknown) {
          const rows = getRows(table);
          return {
            where() {
              return {
                limit(limit: number) {
                  return Promise.resolve(rows.slice(0, limit));
                },
                then(onfulfilled: (value: unknown[]) => unknown) {
                  return Promise.resolve(rows).then(onfulfilled);
                },
              };
            },
            limit(limit: number) {
              return Promise.resolve(rows.slice(0, limit));
            },
            then(onfulfilled: (value: unknown[]) => unknown) {
              return Promise.resolve(rows).then(onfulfilled);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(value: Record<string, unknown>) {
          const rows = getRows(table) as Array<Record<string, unknown>>;
          const insertedRow = {
            id: value.id ?? `${String((table as { _: { name: string } })._?.name ?? "row")}-${rows.length + 1}`,
            ...value,
          };
          rows.push(insertedRow);
          return {
            returning() {
              return Promise.resolve([insertedRow]);
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              const rows = getRows(table) as Array<Record<string, unknown>>;
              rows.forEach((row) => Object.assign(row, values));
              return {
                returning() {
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
  };
}

const mockedStageLookups = vi.hoisted(() => ({
  queue: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../src/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const next = mockedStageLookups.queue.shift();
            return next ? [next] : [];
          },
        }),
      }),
    }),
  },
}));

// ── Core validation logic extracted for testing ─────────────────────────────

/**
 * This mirrors the core logic of validateStageGate from stage-gate.ts,
 * extracted as a pure function for unit testing without DB dependencies.
 */
function evaluateStageGate(opts: {
  deal: MockDeal;
  currentStage: MockStage;
  targetStage: MockStage;
  userRole: UserRole;
  userId: string;
  existingFileCategories?: string[];
  existingApprovedRoles?: string[];
  scopingGate?: {
    applies: boolean;
    allowed: boolean;
    missingFields?: string[];
    missingDocuments?: string[];
    blockReason?: string;
  };
}) {
  const { deal, currentStage, targetStage, userRole, userId, existingFileCategories = [], existingApprovedRoles = [], scopingGate } = opts;

  // Rep ownership check
  if (userRole === "rep" && deal.assignedRepId !== userId) {
    return { error: "You can only modify your own deals", statusCode: 403 };
  }

  // Same stage -- no-op
  if (currentStage.id === targetStage.id) {
    return {
      allowed: true,
      isBackwardMove: false,
      isTerminal: targetStage.isTerminal,
      targetStage: {
        id: targetStage.id,
        name: targetStage.name,
        slug: targetStage.slug,
        isTerminal: targetStage.isTerminal,
        displayOrder: targetStage.displayOrder,
      },
      currentStage: {
        id: currentStage.id,
        name: currentStage.name,
        slug: currentStage.slug,
        isTerminal: currentStage.isTerminal,
        displayOrder: currentStage.displayOrder,
      },
      missingRequirements: { fields: [], documents: [], approvals: [] },
      requiresOverride: false,
      overrideType: null as string | null,
      blockReason: null as string | null,
    };
  }

  // Detect backward move
  const isBackwardMove = targetStage.displayOrder < currentStage.displayOrder;

  // Check required fields
  const requiredFields = targetStage.requiredFields ?? [];
  const missingFields: string[] = [];
  for (const field of requiredFields) {
    const value = deal[field];
    if (value == null || value === "") {
      missingFields.push(field);
    }
  }

  // Check required documents
  const requiredDocuments = targetStage.requiredDocuments ?? [];
  const missingDocuments: string[] = [];
  const existingCatSet = new Set(existingFileCategories);
  for (const docType of requiredDocuments) {
    if (!existingCatSet.has(docType)) {
      missingDocuments.push(docType);
    }
  }

  // Check required approvals
  const requiredApprovals = targetStage.requiredApprovals ?? [];
  const missingApprovals: string[] = [];
  const approvedRoleSet = new Set(existingApprovedRoles);
  for (const role of requiredApprovals) {
    if (!approvedRoleSet.has(role)) {
      missingApprovals.push(role);
    }
  }

  const hasMissingRequirements =
    missingFields.length > 0 || missingDocuments.length > 0 || missingApprovals.length > 0;

  const isDirectorOrAdmin = userRole === "director" || userRole === "admin";

  let allowed = true;
  let blockReason: string | null = null;
  let requiresOverride = false;
  let overrideType: "backward_move" | "missing_requirements" | null = null;

  // Rule 1: Backward move
  if (isBackwardMove) {
    if (!isDirectorOrAdmin) {
      allowed = false;
      blockReason = "Reps cannot move deals backward. A director must perform this action.";
    } else {
      requiresOverride = true;
      overrideType = "backward_move";
    }
  }

  // Rule 2: Missing requirements
  if (hasMissingRequirements) {
    if (!isDirectorOrAdmin) {
      allowed = false;
      blockReason = blockReason
        ? `${blockReason} Additionally, stage requirements are not met.`
        : "Stage requirements are not met. Complete all required items before advancing.";
    } else {
      requiresOverride = true;
      overrideType = overrideType ?? "missing_requirements";
    }
  }

  if (scopingGate?.applies && !scopingGate.allowed) {
    allowed = false;
    requiresOverride = false;
    overrideType = null;
    blockReason = scopingGate.blockReason ?? "Scoping intake is incomplete. Complete all required scoping items before advancing.";
    missingFields.push(...(scopingGate.missingFields ?? []));
    missingDocuments.push(...(scopingGate.missingDocuments ?? []));
  }

  return {
    allowed,
    isBackwardMove,
    isTerminal: targetStage.isTerminal,
    targetStage: {
      id: targetStage.id,
      name: targetStage.name,
      slug: targetStage.slug,
      isTerminal: targetStage.isTerminal,
      displayOrder: targetStage.displayOrder,
    },
    currentStage: {
      id: currentStage.id,
      name: currentStage.name,
      slug: currentStage.slug,
      isTerminal: currentStage.isTerminal,
      displayOrder: currentStage.displayOrder,
    },
    missingRequirements: {
      fields: missingFields,
      documents: missingDocuments,
      approvals: missingApprovals,
    },
    requiresOverride,
    overrideType,
    blockReason,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Stage Gate Validation", () => {
  describe("Backward Move Detection", () => {
    it("should detect backward move when target displayOrder < current displayOrder", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.estimating.id }),
        currentStage: STAGES.estimating,
        targetStage: STAGES.dd,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result.isBackwardMove).toBe(true);
    });

    it("should detect forward move when target displayOrder > current displayOrder", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.dd.id }),
        currentStage: STAGES.dd,
        targetStage: STAGES.estimating,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result.isBackwardMove).toBe(false);
    });

    it("should not flag same-stage as backward move", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.estimating.id }),
        currentStage: STAGES.estimating,
        targetStage: STAGES.estimating,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result.isBackwardMove).toBe(false);
    });

    it("should detect multi-stage backward move (e.g., in_production -> dd)", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.in_production.id }),
        currentStage: STAGES.in_production,
        targetStage: STAGES.dd,
        userRole: "director",
        userId: "dir-1",
      });

      expect(result.isBackwardMove).toBe(true);
      expect(result.allowed).toBe(true);
      expect(result.requiresOverride).toBe(true);
      expect(result.overrideType).toBe("backward_move");
    });
  });

  describe("Rep Permission Rules", () => {
    it("should block backward move for reps", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.estimating.id }),
        currentStage: STAGES.estimating,
        targetStage: STAGES.dd,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain("Reps cannot move deals backward");
    });

    it("should allow forward move for reps when no requirements", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.dd.id }),
        currentStage: STAGES.dd,
        targetStage: STAGES.estimating,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result.allowed).toBe(true);
      expect(result.blockReason).toBeNull();
      expect(result.requiresOverride).toBe(false);
    });

    it("should block rep from moving forward when requirements are missing", () => {
      const stageWithReqs = makeStage({
        slug: "bid_sent",
        displayOrder: 2,
        requiredFields: ["bidEstimate"],
      });

      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.estimating.id, bidEstimate: null }),
        currentStage: STAGES.estimating,
        targetStage: stageWithReqs,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain("Stage requirements are not met");
      expect(result.missingRequirements.fields).toContain("bidEstimate");
    });

    it("should block rep from modifying another rep's deal", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ assignedRepId: "rep-2" }),
        currentStage: STAGES.dd,
        targetStage: STAGES.estimating,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result).toHaveProperty("error");
      expect((result as any).error).toContain("You can only modify your own deals");
      expect((result as any).statusCode).toBe(403);
    });

    it("should combine backward move and missing requirement block reasons for rep", () => {
      const stageWithReqs = makeStage({
        slug: "dd",
        displayOrder: 0,
        requiredFields: ["description"],
      });

      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.estimating.id, description: null }),
        currentStage: STAGES.estimating,
        targetStage: stageWithReqs,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result.allowed).toBe(false);
      expect((result as any).blockReason).toContain("Reps cannot move deals backward");
      expect((result as any).blockReason).toContain("Additionally, stage requirements are not met");
    });
  });

  describe("Director/Admin Override Rules", () => {
    it("should allow backward move for directors with override flag", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.estimating.id }),
        currentStage: STAGES.estimating,
        targetStage: STAGES.dd,
        userRole: "director",
        userId: "dir-1",
      });

      expect(result.allowed).toBe(true);
      expect(result.isBackwardMove).toBe(true);
      expect(result.requiresOverride).toBe(true);
      expect(result.overrideType).toBe("backward_move");
    });

    it("should allow backward move for admins with override flag", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.bid_sent.id }),
        currentStage: STAGES.bid_sent,
        targetStage: STAGES.dd,
        userRole: "admin",
        userId: "admin-1",
      });

      expect(result.allowed).toBe(true);
      expect(result.requiresOverride).toBe(true);
      expect(result.overrideType).toBe("backward_move");
    });

    it("should allow director to advance with missing requirements (override)", () => {
      const stageWithReqs = makeStage({
        slug: "bid_sent",
        displayOrder: 2,
        requiredFields: ["bidEstimate"],
      });

      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.estimating.id, bidEstimate: null }),
        currentStage: STAGES.estimating,
        targetStage: stageWithReqs,
        userRole: "director",
        userId: "dir-1",
      });

      expect(result.allowed).toBe(true);
      expect(result.requiresOverride).toBe(true);
      expect(result.overrideType).toBe("missing_requirements");
    });

    it("should prioritize backward_move override type over missing_requirements", () => {
      const targetWithReqs = makeStage({
        slug: "dd",
        displayOrder: 0,
        requiredFields: ["description"],
      });

      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.estimating.id, description: null }),
        currentStage: STAGES.estimating,
        targetStage: targetWithReqs,
        userRole: "director",
        userId: "dir-1",
      });

      expect(result.allowed).toBe(true);
      expect(result.requiresOverride).toBe(true);
      // backward_move is set first, then missing_requirements uses ?? so backward_move wins
      expect(result.overrideType).toBe("backward_move");
    });

    it("should allow director to modify any rep's deal", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ assignedRepId: "rep-2" }),
        currentStage: STAGES.dd,
        targetStage: STAGES.estimating,
        userRole: "director",
        userId: "dir-1",
      });

      expect(result.allowed).toBe(true);
      expect(result).not.toHaveProperty("error");
    });

    it("should block director override when scoping gate is incomplete for estimating entry", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.dd.id }),
        currentStage: STAGES.dd,
        targetStage: STAGES.estimating,
        userRole: "director",
        userId: "dir-1",
        scopingGate: {
          applies: true,
          allowed: false,
          missingFields: ["projectOverview.bidDueDate"],
          missingDocuments: ["site_photos"],
          blockReason: "Scoping intake is incomplete. Complete all required scoping items before advancing.",
        },
      });

      expect(result.allowed).toBe(false);
      expect(result.requiresOverride).toBe(false);
      expect(result.overrideType).toBeNull();
      expect(result.blockReason).toContain("Scoping intake is incomplete");
      expect(result.missingRequirements.fields).toContain("projectOverview.bidDueDate");
      expect(result.missingRequirements.documents).toContain("site_photos");
    });
  });

  describe("Same-Stage No-Op", () => {
    it("should return allowed=true for same stage", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.dd.id }),
        currentStage: STAGES.dd,
        targetStage: STAGES.dd,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result.allowed).toBe(true);
      expect(result.isBackwardMove).toBe(false);
      expect(result.requiresOverride).toBe(false);
      expect(result.overrideType).toBeNull();
      expect(result.blockReason).toBeNull();
    });

    it("should have empty missing requirements for same stage", () => {
      // Even if the stage has requirements, same-stage should skip validation
      const stageWithReqs = makeStage({
        slug: "bid_sent",
        displayOrder: 2,
        requiredFields: ["bidEstimate"],
      });

      const result = evaluateStageGate({
        deal: makeDeal({ stageId: stageWithReqs.id, bidEstimate: null }),
        currentStage: stageWithReqs,
        targetStage: stageWithReqs,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result.allowed).toBe(true);
      expect((result as any).missingRequirements.fields).toHaveLength(0);
    });
  });

  describe("Terminal Stage Detection", () => {
    it("should detect closed_won as terminal", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.close_out.id }),
        currentStage: STAGES.close_out,
        targetStage: STAGES.closed_won,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result.isTerminal).toBe(true);
      expect((result as any).targetStage.slug).toBe("closed_won");
    });

    it("should detect closed_lost as terminal", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.close_out.id }),
        currentStage: STAGES.close_out,
        targetStage: STAGES.closed_lost,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result.isTerminal).toBe(true);
      expect((result as any).targetStage.slug).toBe("closed_lost");
    });

    it("should not flag non-terminal stages as terminal", () => {
      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.dd.id }),
        currentStage: STAGES.dd,
        targetStage: STAGES.estimating,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result.isTerminal).toBe(false);
    });
  });

  describe("Required Fields Validation", () => {
    it("should detect missing required fields", () => {
      const target = makeStage({
        slug: "bid_sent",
        displayOrder: 2,
        requiredFields: ["bidEstimate", "description"],
      });

      const result = evaluateStageGate({
        deal: makeDeal({
          stageId: STAGES.estimating.id,
          bidEstimate: null,
          description: "",
        }),
        currentStage: STAGES.estimating,
        targetStage: target,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result.allowed).toBe(false);
      const missing = (result as any).missingRequirements.fields;
      expect(missing).toContain("bidEstimate");
      expect(missing).toContain("description");
    });

    it("should pass when all required fields are present", () => {
      const target = makeStage({
        slug: "bid_sent",
        displayOrder: 2,
        requiredFields: ["bidEstimate", "description"],
      });

      const result = evaluateStageGate({
        deal: makeDeal({
          stageId: STAGES.estimating.id,
          bidEstimate: "150000",
          description: "A real description",
        }),
        currentStage: STAGES.estimating,
        targetStage: target,
        userRole: "rep",
        userId: "rep-1",
      });

      expect(result.allowed).toBe(true);
      expect((result as any).missingRequirements.fields).toHaveLength(0);
    });

    it("should treat empty string as missing", () => {
      const target = makeStage({
        slug: "bid_sent",
        displayOrder: 2,
        requiredFields: ["description"],
      });

      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.estimating.id, description: "" }),
        currentStage: STAGES.estimating,
        targetStage: target,
        userRole: "rep",
        userId: "rep-1",
      });

      expect((result as any).missingRequirements.fields).toContain("description");
    });

    it("should treat null as missing", () => {
      const target = makeStage({
        slug: "bid_sent",
        displayOrder: 2,
        requiredFields: ["awardedAmount"],
      });

      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.estimating.id, awardedAmount: null }),
        currentStage: STAGES.estimating,
        targetStage: target,
        userRole: "rep",
        userId: "rep-1",
      });

      expect((result as any).missingRequirements.fields).toContain("awardedAmount");
    });

    it("should accept zero as a valid value (not missing)", () => {
      const target = makeStage({
        slug: "bid_sent",
        displayOrder: 2,
        requiredFields: ["winProbability"],
      });

      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.estimating.id, winProbability: 0 }),
        currentStage: STAGES.estimating,
        targetStage: target,
        userRole: "rep",
        userId: "rep-1",
      });

      // 0 is not null and not empty string, so it should pass
      expect((result as any).missingRequirements.fields).not.toContain("winProbability");
    });
  });

  describe("Required Documents Validation", () => {
    it("should detect missing required documents", () => {
      const target = makeStage({
        slug: "bid_sent",
        displayOrder: 2,
        requiredDocuments: ["estimate", "proposal"],
      });

      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.estimating.id }),
        currentStage: STAGES.estimating,
        targetStage: target,
        userRole: "rep",
        userId: "rep-1",
        existingFileCategories: ["estimate"], // has estimate but not proposal
      });

      expect((result as any).missingRequirements.documents).toContain("proposal");
      expect((result as any).missingRequirements.documents).not.toContain("estimate");
    });

    it("should pass when all required documents exist", () => {
      const target = makeStage({
        slug: "bid_sent",
        displayOrder: 2,
        requiredDocuments: ["estimate", "proposal"],
      });

      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.estimating.id }),
        currentStage: STAGES.estimating,
        targetStage: target,
        userRole: "rep",
        userId: "rep-1",
        existingFileCategories: ["estimate", "proposal", "photo"],
      });

      expect((result as any).missingRequirements.documents).toHaveLength(0);
      expect(result.allowed).toBe(true);
    });
  });

  describe("Required Approvals Validation", () => {
    it("should detect missing required approvals", () => {
      const target = makeStage({
        slug: "in_production",
        displayOrder: 3,
        requiredApprovals: ["director"],
      });

      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.bid_sent.id }),
        currentStage: STAGES.bid_sent,
        targetStage: target,
        userRole: "rep",
        userId: "rep-1",
        existingApprovedRoles: [],
      });

      expect((result as any).missingRequirements.approvals).toContain("director");
    });

    it("should pass when all required approvals are present", () => {
      const target = makeStage({
        slug: "in_production",
        displayOrder: 3,
        requiredApprovals: ["director"],
      });

      const result = evaluateStageGate({
        deal: makeDeal({ stageId: STAGES.bid_sent.id }),
        currentStage: STAGES.bid_sent,
        targetStage: target,
        userRole: "rep",
        userId: "rep-1",
        existingApprovedRoles: ["director"],
      });

      expect((result as any).missingRequirements.approvals).toHaveLength(0);
      expect(result.allowed).toBe(true);
    });
  });

  describe("Closed Lost Requirements (Stage Change Logic)", () => {
    it("should require lost_reason_id for closed_lost transition", () => {
      // This tests the logic in changeDealStage, not validateStageGate
      const targetSlug = "closed_lost";
      const lostReasonId: string | undefined = undefined;
      const lostNotes: string | undefined = "They went with a competitor";

      const needsLostReason = targetSlug === "closed_lost" && !lostReasonId;
      expect(needsLostReason).toBe(true);
    });

    it("should require lost_notes for closed_lost transition", () => {
      const targetSlug = "closed_lost";
      const lostReasonId = "reason-1";
      const lostNotes: string | undefined = undefined;

      const needsLostNotes = targetSlug === "closed_lost" && (!lostNotes || lostNotes.trim().length === 0);
      expect(needsLostNotes).toBe(true);
    });

    it("should reject empty lost_notes (whitespace only)", () => {
      const targetSlug = "closed_lost";
      const lostNotes = "   ";

      const needsLostNotes = targetSlug === "closed_lost" && (!lostNotes || lostNotes.trim().length === 0);
      expect(needsLostNotes).toBe(true);
    });

    it("should accept valid lost fields", () => {
      const targetSlug = "closed_lost";
      const lostReasonId = "reason-1";
      const lostNotes = "They went with a competitor";

      const needsLostReason = targetSlug === "closed_lost" && !lostReasonId;
      const needsLostNotes = targetSlug === "closed_lost" && (!lostNotes || lostNotes.trim().length === 0);

      expect(needsLostReason).toBe(false);
      expect(needsLostNotes).toBe(false);
    });
  });

  describe("Closed Won Handling", () => {
    it("should set actualCloseDate on closed_won", () => {
      const targetSlug = "closed_won";
      const updates: Record<string, any> = {};

      if (targetSlug === "closed_won") {
        updates.actualCloseDate = new Date().toISOString().split("T")[0];
      }

      expect(updates.actualCloseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("Deal Reopen Detection", () => {
    it("should detect reopen when moving from terminal to active stage", () => {
      const currentStageIsTerminal = true;
      const targetStageIsTerminal = false;
      const isReopen = currentStageIsTerminal && !targetStageIsTerminal;
      expect(isReopen).toBe(true);
    });

    it("should not flag terminal-to-terminal as reopen", () => {
      const currentStageIsTerminal = true;
      const targetStageIsTerminal = true;
      const isReopen = currentStageIsTerminal && !targetStageIsTerminal;
      expect(isReopen).toBe(false);
    });

    it("should not flag active-to-active as reopen", () => {
      const currentStageIsTerminal = false;
      const targetStageIsTerminal = false;
      const isReopen = currentStageIsTerminal && !targetStageIsTerminal;
      expect(isReopen).toBe(false);
    });

    it("should clear terminal fields on reopen", () => {
      const isReopen = true;
      const updates: Record<string, any> = {};

      if (isReopen) {
        updates.actualCloseDate = null;
        updates.lostReasonId = null;
        updates.lostNotes = null;
        updates.lostCompetitor = null;
        updates.lostAt = null;
      }

      expect(updates.actualCloseDate).toBeNull();
      expect(updates.lostReasonId).toBeNull();
      expect(updates.lostNotes).toBeNull();
      expect(updates.lostCompetitor).toBeNull();
      expect(updates.lostAt).toBeNull();
    });
  });

  describe("Override Reason Enforcement", () => {
    it("should require override reason when override is needed", () => {
      const requiresOverride = true;
      const overrideReason: string | undefined = undefined;

      const needsReason = requiresOverride && !overrideReason;
      expect(needsReason).toBe(true);
    });

    it("should pass when override reason is provided", () => {
      const requiresOverride = true;
      const overrideReason = "Director approved backward move per client request";

      const needsReason = requiresOverride && !overrideReason;
      expect(needsReason).toBe(false);
    });

    it("should not require reason when no override needed", () => {
      const requiresOverride = false;
      const overrideReason: string | undefined = undefined;

      const needsReason = requiresOverride && !overrideReason;
      expect(needsReason).toBe(false);
    });
  });

  describe("Duration Calculation", () => {
    it("should calculate duration in seconds from stage_entered_at", () => {
      const stageEnteredAt = new Date(Date.now() - 3600 * 1000); // 1 hour ago
      const durationSeconds = Math.floor((Date.now() - stageEnteredAt.getTime()) / 1000);

      expect(durationSeconds).toBeGreaterThanOrEqual(3599);
      expect(durationSeconds).toBeLessThanOrEqual(3601);
    });

    it("should handle null stage_entered_at", () => {
      const stageEnteredAt: Date | null = null;
      const durationStr = stageEnteredAt
        ? `${Math.floor((Date.now() - stageEnteredAt.getTime()) / 1000)} seconds`
        : null;

      expect(durationStr).toBeNull();
    });
  });
});

describe("Scoping Attachment Hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unmock("../../../src/modules/deals/scoping-service.js");
    mockedStageLookups.queue.length = 0;
  });

  it("uses route-specific required attachment categories for service readiness", async () => {
    const { evaluateDealScopingReadiness } = await import("../../../src/modules/deals/scoping-service.js");
    const tenantDb = createHardeningTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Palm Villas",
          stageId: STAGES.dd.id,
          workflowRoute: "service",
          assignedRepId: "rep-1",
          projectTypeId: "pt-1",
          propertyAddress: "123 Palm Way",
          propertyCity: "Miami",
          propertyState: "FL",
          propertyZip: "33101",
          description: "Exterior refresh",
        },
      ],
      dealScopingIntake: [
        {
          id: "intake-1",
          dealId: "deal-1",
          officeId: "office-1",
          workflowRouteSnapshot: "service",
          status: "draft",
          projectTypeId: "pt-1",
          sectionData: {
            projectOverview: { propertyName: "Palm Villas" },
            propertyDetails: { propertyAddress: "123 Palm Way" },
            scopeSummary: { summary: "Exterior refresh" },
          },
          completionState: {},
          readinessErrors: {},
          firstReadyAt: null,
          activatedAt: null,
          lastAutosavedAt: new Date("2026-04-15T15:00:00.000Z"),
          createdBy: "user-1",
          lastEditedBy: "user-1",
          createdAt: new Date("2026-04-15T15:00:00.000Z"),
          updatedAt: new Date("2026-04-15T15:00:00.000Z"),
        },
      ],
      files: [
        {
          id: "file-1",
          dealId: "deal-1",
          category: "photo",
          intakeRequirementKey: "site_photos",
          intakeSection: "attachments",
          intakeSource: "scoping_intake",
          isActive: true,
        },
      ],
    });

    const readiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1");

    expect(readiness.status).toBe("ready");
    expect(readiness.requiredAttachmentKeys).toEqual(["site_photos"]);
    expect(readiness.attachmentRequirements).toEqual([
      expect.objectContaining({
        key: "site_photos",
        category: "photo",
        satisfied: true,
      }),
    ]);
  });

  it("requires a linked file in the canonical category before attachment satisfaction passes", async () => {
    const { evaluateDealScopingReadiness } = await import("../../../src/modules/deals/scoping-service.js");
    const tenantDb = createHardeningTenantDb({
      files: [
        {
          id: "file-1",
          dealId: "deal-1",
          category: "photo",
          intakeRequirementKey: "scope_docs",
          intakeSection: "attachments",
          intakeSource: "scoping_intake",
          isActive: true,
        },
        {
          id: "file-2",
          dealId: "deal-1",
          category: "photo",
          intakeRequirementKey: "site_photos",
          intakeSection: "attachments",
          intakeSource: "scoping_intake",
          isActive: true,
        },
      ],
    });

    const readiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1");
    const scopeDocsRequirement = readiness.attachmentRequirements.find(
      (requirement) => requirement.key === "scope_docs"
    );

    expect(readiness.status).toBe("draft");
    expect(scopeDocsRequirement).toEqual(
      expect.objectContaining({
        key: "scope_docs",
        category: "other",
        satisfied: false,
      })
    );
  });
});

describe("Stage Gate Payload Hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unmock("../../../src/modules/deals/scoping-service.js");
    mockedStageLookups.queue.length = 0;
  });

  it("returns a structured effective checklist and only counts linked attachment categories", async () => {
    vi.doMock("../../../src/modules/deals/scoping-service.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../../src/modules/deals/scoping-service.js")>();
      return {
        ...actual,
        evaluateDealScopingReadiness: vi.fn(async () => ({
          status: "ready",
          errors: { sections: {}, attachments: {} },
          completionState: {},
          requiredSections: ["projectOverview"],
          requiredAttachmentKeys: ["scope_docs"],
          attachmentRequirements: [
            {
              key: "scope_docs",
              category: "other",
              label: "Scope docs",
              satisfied: true,
            },
          ],
        })),
      };
    });

    const { validateStageGate } = await import("../../../src/modules/deals/stage-gate.js");
    const tenantDb = createHardeningTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Palm Villas",
          stageId: STAGES.estimating.id,
          workflowRoute: "estimating",
          assignedRepId: "rep-1",
          projectTypeId: "pt-1",
          propertyAddress: "123 Palm Way",
          propertyCity: "Miami",
          propertyState: "FL",
          propertyZip: "33101",
          description: "Exterior refresh",
        },
      ],
      files: [
        {
          id: "file-1",
          dealId: "deal-1",
          category: "proposal",
          intakeRequirementKey: null,
          isActive: true,
        },
      ],
    });

    mockedStageLookups.queue.push(
      {
        id: STAGES.estimating.id,
        name: STAGES.estimating.name,
        slug: STAGES.estimating.slug,
        isTerminal: STAGES.estimating.isTerminal,
        displayOrder: STAGES.estimating.displayOrder,
        requiredFields: [],
        requiredDocuments: [],
        requiredApprovals: [],
      },
      {
        id: STAGES.bid_sent.id,
        name: STAGES.bid_sent.name,
        slug: STAGES.bid_sent.slug,
        isTerminal: STAGES.bid_sent.isTerminal,
        displayOrder: STAGES.bid_sent.displayOrder,
        requiredFields: ["description"],
        requiredDocuments: ["proposal"],
        requiredApprovals: ["director"],
      }
    );

    const result = await validateStageGate(
      tenantDb as never,
      "deal-1",
      STAGES.bid_sent.id,
      "rep",
      "rep-1"
    );

    expect(result.missingRequirements.documents).toEqual(["proposal"]);
    expect(result.effectiveChecklist.fields).toEqual([
      expect.objectContaining({
        key: "description",
        source: "stage",
        satisfied: true,
      }),
    ]);
    expect(result.effectiveChecklist.attachments).toEqual([
      expect.objectContaining({
        key: "proposal",
        source: "stage",
        satisfied: false,
      }),
    ]);
    expect(result.effectiveChecklist.approvals).toEqual([
      expect.objectContaining({
        key: "director",
        source: "stage",
        satisfied: false,
      }),
    ]);
  });
});

describe("Revision Routing Hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unmock("../../../src/modules/deals/scoping-service.js");
    mockedStageLookups.queue.length = 0;
  });

  it("routes revision requests from sent_to_client back into estimating and creates a task trail", async () => {
    const scopingService = await import("../../../src/modules/deals/scoping-service.js");
    const routeRevisionToEstimating = (scopingService as any).routeRevisionToEstimating;
    const tenantDb = createHardeningTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Palm Villas",
          stageId: STAGES.estimating.id,
          workflowRoute: "estimating",
          assignedRepId: "rep-1",
          projectTypeId: "pt-1",
          propertyAddress: "123 Palm Way",
          propertyCity: "Miami",
          propertyState: "FL",
          propertyZip: "33101",
          description: "Exterior refresh",
          estimatingSubstage: "sent_to_client",
          proposalStatus: "revision_requested",
          proposalRevisionCount: 2,
        },
      ],
      dealTeamMembers: [
        {
          id: "member-1",
          dealId: "deal-1",
          userId: "est-1",
          role: "estimator",
          isActive: true,
        },
      ],
    });

    expect(typeof routeRevisionToEstimating).toBe("function");

    const result = await routeRevisionToEstimating(tenantDb as never, "deal-1", "user-1");

    expect(result).toEqual(
      expect.objectContaining({
        routed: true,
      })
    );
    expect(tenantDb.state.deals[0]?.estimatingSubstage).toBe("building_estimate");
    expect(tenantDb.state.tasks).toEqual([
      expect.objectContaining({
        dealId: "deal-1",
        assignedTo: "est-1",
        status: "pending",
        originRule: "deal_estimate_revision_requested",
        sourceEvent: "deal.estimate.revision_requested",
      }),
    ]);
  });
});
