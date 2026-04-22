import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { InterventionDetailPanel, getInterventionDetailMutationOutcome } from "./intervention-detail-panel";

const adminInterventionHooks = vi.hoisted(() => ({
  useAdminInterventionDetail: vi.fn(),
  toLocalDateTimeInput: vi.fn((value: string | null) => value ?? ""),
}));

vi.mock("@/hooks/use-admin-interventions", () => ({
  assignIntervention: vi.fn(),
  escalateIntervention: vi.fn(),
  resolveIntervention: vi.fn(),
  snoozeIntervention: vi.fn(),
  summarizeInterventionMutationResult: vi.fn((result: { updatedCount: number; skippedCount: number; errors: Array<{ caseId: string; message: string }> }) => {
    if (result.updatedCount === 0) {
      return {
        tone: "error" as const,
        message: `No intervention cases were updated. ${result.skippedCount} case skipped. Errors: ${result.errors.map((error) => `${error.caseId}: ${error.message}`).join("; ")}`,
      };
    }
    return {
      tone: result.skippedCount > 0 || result.errors.length > 0 ? ("warning" as const) : ("success" as const),
      message:
        result.skippedCount > 0 || result.errors.length > 0
          ? `Updated ${result.updatedCount} intervention case. ${result.skippedCount} case skipped. Errors: ${result.errors.map((error) => `${error.caseId}: ${error.message}`).join("; ")}`
          : `Updated ${result.updatedCount} intervention case`,
    };
  }),
  useAdminInterventionDetail: adminInterventionHooks.useAdminInterventionDetail,
  toLocalDateTimeInput: adminInterventionHooks.toLocalDateTimeInput,
}));

vi.mock("@/components/ai/intervention-conclusion-form", () => ({
  InterventionConclusionForm: ({ mode }: { mode: string }) => <div>{mode} conclusion form</div>,
}));

vi.mock("@/components/ai/intervention-case-copilot-panel", () => ({
  InterventionCaseCopilotPanel: ({ caseId }: { caseId: string | null }) => <div>Case Copilot Panel {caseId}</div>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe("getInterventionDetailMutationOutcome", () => {
  it("treats a successful detail update as a refresh-and-clear path", () => {
    expect(
      getInterventionDetailMutationOutcome({
        updatedCount: 1,
        skippedCount: 0,
        errors: [],
      })
    ).toEqual({
      summary: {
        tone: "success",
        message: "Updated 1 intervention case",
      },
      shouldRefreshDetail: true,
      shouldClearNotes: true,
    });
  });

  it("keeps the panel state intact when a detail action is skipped", () => {
    expect(
      getInterventionDetailMutationOutcome({
        updatedCount: 0,
        skippedCount: 1,
        errors: [{ caseId: "case-1", message: "Case already resolved" }],
      })
    ).toEqual({
      summary: {
        tone: "error",
        message: "No intervention cases were updated. 1 case skipped. Errors: case-1: Case already resolved",
      },
      shouldRefreshDetail: false,
      shouldClearNotes: false,
    });
  });

  it("marks partial updates as warnings while still refreshing the detail view", () => {
    expect(
      getInterventionDetailMutationOutcome({
        updatedCount: 1,
        skippedCount: 1,
        errors: [{ caseId: "case-2", message: "Case locked by another operator" }],
      })
    ).toEqual({
      summary: {
        tone: "warning",
        message: "Updated 1 intervention case. 1 case skipped. Errors: case-2: Case locked by another operator",
      },
      shouldRefreshDetail: true,
      shouldClearNotes: true,
    });
  });
});

describe("InterventionDetailPanel", () => {
  it("renders the embedded case copilot panel inside the detail sheet", () => {
    adminInterventionHooks.useAdminInterventionDetail.mockReturnValue({
      detail: {
        case: {
          id: "case-1",
          businessKey: "office-1:missing_next_task:deal-1",
          disconnectType: "missing_next_task",
          clusterKey: "follow_up_gap",
          severity: "high",
          status: "open",
          assignedTo: "user-1",
          assignedToName: "Admin User",
          generatedTaskId: "task-1",
          escalated: false,
          snoozedUntil: null,
          reopenCount: 1,
          lastDetectedAt: "2026-04-19T12:00:00.000Z",
          lastIntervenedAt: null,
          resolvedAt: null,
          resolutionReason: null,
          metadataJson: null,
        },
        generatedTask: {
          id: "task-1",
          title: "Follow up with customer",
          status: "pending",
          assignedTo: "user-2",
          assignedToName: "Director User",
        },
        crm: {
          deal: { id: "deal-1", dealNumber: "D-001", name: "Fence Refresh" },
          company: { id: "company-1", name: "Acme" },
        },
        history: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InterventionDetailPanel caseId="case-1" open onOpenChange={vi.fn()} onUpdated={vi.fn(async () => undefined)} />
      </MemoryRouter>
    );

    expect(html).toContain("Case Copilot Panel case-1");
    expect(html).toContain("Direct actions");
  });
});
