import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assignIntervention,
  buildAdminInterventionQuery,
  buildInterventionAnalyticsPath,
  buildInterventionWorkspacePath,
  batchAssignInterventions,
  batchEscalateInterventions,
  batchResolveInterventions,
  batchSnoozeInterventions,
  escalateIntervention,
  hasInterventionMutationErrors,
  resolveIntervention,
  snoozeIntervention,
  localDateTimeInputToIso,
  type InterventionMutationResult,
  summarizeInterventionMutationResult,
  toLocalDateTimeInput,
} from "./use-admin-interventions";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", () => ({
  api: apiMock,
}));

describe("buildAdminInterventionQuery", () => {
  it("omits the all status filter from the query string", () => {
    expect(buildAdminInterventionQuery({ page: 1, pageSize: 50, status: "all" })).toBe("?page=1&limit=50");
  });

  it("includes an explicit status filter when selected", () => {
    expect(buildAdminInterventionQuery({ page: 2, pageSize: 25, status: "snoozed" })).toBe(
      "?page=2&limit=25&status=snoozed"
    );
  });

  it("includes workspace view and cluster filters when present", () => {
    expect(
      buildAdminInterventionQuery({
        page: 1,
        pageSize: 50,
        status: "open",
        view: "aging",
        clusterKey: "follow_through_gap",
      })
    ).toBe("?page=1&limit=50&status=open&view=aging&clusterKey=follow_through_gap");
  });

  it("includes caseId and source filters when present", () => {
    expect(
      buildAdminInterventionQuery({
        page: 1,
        pageSize: 50,
        view: "overdue",
        caseId: "case-1",
        companyId: "company-1",
      })
    ).toBe("?page=1&limit=50&view=overdue&caseId=case-1&companyId=company-1");
  });

  it("returns an empty string when no params are provided", () => {
    expect(buildAdminInterventionQuery({})).toBe("");
  });
});

describe("buildInterventionWorkspacePath", () => {
  it("omits the default open view", () => {
    expect(buildInterventionWorkspacePath({ view: "open" })).toBe("/admin/interventions");
  });

  it("builds a workspace path with view and cluster filters", () => {
    expect(buildInterventionWorkspacePath({ view: "aging", clusterKey: "execution_stall" })).toBe(
      "/admin/interventions?view=aging&clusterKey=execution_stall"
    );
  });

  it("builds intervention workspace paths with caseId and source filters", () => {
    expect(
      buildInterventionWorkspacePath({
        view: "snooze-breached",
        companyId: "company-1",
        caseId: "case-1",
      })
    ).toBe("/admin/interventions?view=snooze-breached&companyId=company-1&caseId=case-1");
  });
});

describe("buildInterventionAnalyticsPath", () => {
  it("returns the analytics workspace path", () => {
    expect(buildInterventionAnalyticsPath()).toBe("/admin/intervention-analytics");
  });
});

describe("datetime helpers", () => {
  it("formats an ISO string for a datetime-local input", () => {
    expect(toLocalDateTimeInput("2026-04-16T15:45:00.000Z")).toMatch(/^2026-04-16T\d{2}:\d{2}$/);
  });

  it("converts a datetime-local string into an ISO timestamp", () => {
    expect(localDateTimeInputToIso("2026-04-16T10:45")).toMatch(/^2026-04-16T\d{2}:45:00.000Z$/);
  });
});

describe("intervention mutation summaries", () => {
  it("summarizes a clean success result", () => {
    expect(
      summarizeInterventionMutationResult({
        updatedCount: 4,
        skippedCount: 0,
        errors: [],
      })
    ).toEqual({
      tone: "success",
      message: "Updated 4 intervention cases",
    });
  });

  it("summarizes a mixed partial result with skipped rows", () => {
    expect(
      summarizeInterventionMutationResult({
        updatedCount: 2,
        skippedCount: 1,
        errors: [],
      })
    ).toEqual({
      tone: "warning",
      message: "Updated 2 intervention cases. 1 case skipped.",
    });
  });

  it("summarizes a full failure result with error messages", () => {
    expect(
      summarizeInterventionMutationResult({
        updatedCount: 0,
        skippedCount: 2,
        errors: [
          { caseId: "case-1", message: "Case not found" },
          { caseId: "case-2", message: "Case locked by another operator" },
        ],
      })
    ).toEqual({
      tone: "error",
      message:
        "No intervention cases were updated. 2 cases skipped. Errors: case-1: Case not found; case-2: Case locked by another operator",
    });
  });

  it("detects whether a mutation result contains errors", () => {
    expect(hasInterventionMutationErrors({ updatedCount: 1, skippedCount: 0, errors: [] })).toBe(false);
    expect(
      hasInterventionMutationErrors({
        updatedCount: 0,
        skippedCount: 0,
        errors: [{ caseId: "case-1", message: "Case not found" }],
      })
    ).toBe(true);
  });
});

describe("intervention mutation helpers", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("preserves structured errors for batch assign responses", async () => {
    const response: InterventionMutationResult = {
      updatedCount: 1,
      skippedCount: 1,
      errors: [{ caseId: "case-2", message: "Cannot assign a resolved case" }],
    };
    apiMock.mockResolvedValueOnce(response);

    const result = await batchAssignInterventions({
      caseIds: ["case-1", "case-2"],
      assignedTo: "manager-2",
      notes: "Rebalance queue",
    });

    expect(apiMock).toHaveBeenCalledWith("/ai/ops/interventions/batch-assign", {
      method: "POST",
      json: {
        caseIds: ["case-1", "case-2"],
        assignedTo: "manager-2",
        notes: "Rebalance queue",
      },
    });
    expect(result).toEqual(response);
  });

  it.each([
    [
      "batchSnoozeInterventions",
      batchSnoozeInterventions,
      "/ai/ops/interventions/batch-snooze",
      {
        caseIds: ["case-1", "case-2"],
        snoozedUntil: "2026-04-20T00:00:00.000Z",
        notes: "Waiting on customer reply",
      },
    ],
    [
      "batchResolveInterventions",
      batchResolveInterventions,
      "/ai/ops/interventions/batch-resolve",
      {
        caseIds: ["case-1", "case-2"],
        resolutionReason: "owner_aligned",
        notes: "Owner already aligned on next step",
      },
    ],
    [
      "batchEscalateInterventions",
      batchEscalateInterventions,
      "/ai/ops/interventions/batch-escalate",
      {
        caseIds: ["case-1", "case-2"],
        notes: "Needs leadership review",
      },
    ],
  ])(
    "preserves structured errors for %s responses",
    async (_label, mutation, path, input) => {
      const response: InterventionMutationResult = {
        updatedCount: 1,
        skippedCount: 1,
        errors: [{ caseId: "case-2", message: "Mutation skipped" }],
      };
      apiMock.mockResolvedValueOnce(response);

      const result = await mutation(input as never);

      const expectedJson =
        path === "/ai/ops/interventions/batch-snooze"
          ? {
              caseIds: ["case-1", "case-2"],
              snoozedUntil: "2026-04-20T00:00:00.000Z",
              notes: "Waiting on customer reply",
            }
          : path === "/ai/ops/interventions/batch-resolve"
            ? {
                caseIds: ["case-1", "case-2"],
                resolutionReason: "owner_aligned",
                notes: "Owner already aligned on next step",
              }
            : {
                caseIds: ["case-1", "case-2"],
                notes: "Needs leadership review",
              };

      expect(apiMock).toHaveBeenCalledWith(path, {
        method: "POST",
        json: expectedJson,
      });
      expect(result).toEqual(response);
    }
  );

  it.each([
    [
      "assignIntervention",
      assignIntervention,
      "/ai/ops/interventions/case-1/assign",
      { assignedTo: "manager-2", notes: "Direct owner change" },
    ],
    [
      "snoozeIntervention",
      snoozeIntervention,
      "/ai/ops/interventions/case-1/snooze",
      { snoozedUntil: "2026-04-20T00:00:00.000Z", notes: "Waiting for reply" },
    ],
    [
      "resolveIntervention",
      resolveIntervention,
      "/ai/ops/interventions/case-1/resolve",
      { resolutionReason: "task_completed", notes: "Task is complete" },
    ],
    [
      "escalateIntervention",
      escalateIntervention,
      "/ai/ops/interventions/case-1/escalate",
      { notes: "Director visibility needed" },
    ],
  ])(
    "preserves structured errors for %s responses",
    async (_label, mutation, path, input) => {
      const response: InterventionMutationResult = {
        updatedCount: 0,
        skippedCount: 1,
        errors: [{ caseId: "case-1", message: "Mutation skipped" }],
      };
      apiMock.mockResolvedValueOnce(response);

      const result = await mutation("case-1", input as never);

      expect(apiMock).toHaveBeenCalledWith(
        path,
        path === "/ai/ops/interventions/case-1/snooze"
          ? {
              method: "POST",
              json: {
                snoozedUntil: "2026-04-20T00:00:00.000Z",
                notes: "Waiting for reply",
              },
            }
          : path === "/ai/ops/interventions/case-1/assign"
            ? {
                method: "POST",
                json: {
                  assignedTo: "manager-2",
                  notes: "Direct owner change",
                },
              }
            : path === "/ai/ops/interventions/case-1/resolve"
              ? {
                  method: "POST",
                  json: {
                    resolutionReason: "task_completed",
                    notes: "Task is complete",
                  },
                }
              : {
                  method: "POST",
                  json: {
                    notes: "Director visibility needed",
                  },
                }
      );
      expect(result).toEqual(response);
    }
  );
});
