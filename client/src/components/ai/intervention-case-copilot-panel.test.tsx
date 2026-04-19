import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { InterventionCaseCopilotPanel } from "./intervention-case-copilot-panel";

const hookMocks = vi.hoisted(() => ({
  useInterventionCopilot: vi.fn(),
}));

vi.mock("@/hooks/use-ai-copilot", () => ({
  useInterventionCopilot: hookMocks.useInterventionCopilot,
}));

describe("InterventionCaseCopilotPanel", () => {
  it("renders the copilot summary, recommendation, and similar-case links inside the detail panel surface", () => {
    hookMocks.useInterventionCopilot.mockReturnValue({
      data: {
        packet: {
          id: "packet-1",
          scopeType: "intervention_case",
          scopeId: "case-1",
          packetKind: "intervention_case",
          status: "ready",
          snapshotHash: "hash-1",
          modelName: "heuristic",
          summaryText: "Owner alignment is likely required before this case will clear.",
          nextStepJson: null,
          blindSpotsJson: [],
          evidenceJson: [],
          confidence: 0.82,
          generatedAt: "2026-04-19T12:00:00.000Z",
          expiresAt: null,
          createdAt: "2026-04-19T12:00:00.000Z",
          updatedAt: "2026-04-19T12:00:00.000Z",
        },
        evidence: [],
        riskFlags: [
          {
            flagType: "owner_mismatch",
            title: "Generated task needs owner alignment",
            severity: "medium",
            details: "Current task owner differs from the case owner.",
          },
        ],
        similarCases: [
          {
            caseId: "case-2",
            businessKey: "office-1:missing_next_task:deal-2",
            disconnectType: "missing_next_task",
            clusterKey: "follow_up_gap",
            assigneeAtConclusion: "Director User",
            conclusionKind: "resolve",
            reasonCode: "owner_assigned_and_confirmed",
            durableClose: true,
            reopened: false,
            daysToDurableClosure: 2,
            queueLink: "/admin/interventions?view=repeat&disconnectType=missing_next_task",
          },
        ],
        recommendedAction: {
          action: "assign",
          rationale: "The generated task owner does not match the case owner.",
          suggestedOwnerId: "user-2",
          suggestedOwner: "Director User",
        },
        rootCause: {
          label: "Likely root cause",
          explanation: "Generated task drift",
        },
        blockerOwner: {
          id: "user-2",
          name: "Director User",
        },
        reopenRisk: {
          level: "medium",
          rationale: "This case has reopened before.",
        },
        currentAssignee: {
          id: "user-1",
          name: "Admin User",
        },
        isRefreshPending: false,
        isStale: false,
        latestCaseChangedAt: "2026-04-19T11:59:00.000Z",
        packetGeneratedAt: "2026-04-19T12:00:00.000Z",
        viewerFeedbackValue: "positive",
      },
      loading: false,
      error: null,
      regenerating: false,
      refreshQueuedAt: null,
      submittingFeedback: false,
      refetch: vi.fn(),
      regenerate: vi.fn(),
      submitFeedback: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InterventionCaseCopilotPanel caseId="case-1" />
      </MemoryRouter>
    );

    expect(html).toContain("Case Copilot");
    expect(html).toContain("Owner alignment is likely required before this case will clear.");
    expect(html).toContain("Recommended Action");
    expect(html).toContain("Assign");
    expect(html).toContain("Generated task needs owner alignment");
    expect(html).toContain("Similar Historical Cases");
    expect(html).toContain("Open similar cases");
    expect(html).toContain("Helpful");
  });

  it("renders an empty-state prompt before any packet has been generated", () => {
    hookMocks.useInterventionCopilot.mockReturnValue({
      data: {
        packet: {
          id: null,
          scopeType: null,
          scopeId: null,
          packetKind: null,
          status: null,
          snapshotHash: null,
          modelName: null,
          summaryText: null,
          nextStepJson: null,
          blindSpotsJson: null,
          evidenceJson: null,
          confidence: null,
          generatedAt: null,
          expiresAt: null,
          createdAt: null,
          updatedAt: null,
        },
        evidence: [],
        riskFlags: [],
        similarCases: [],
        recommendedAction: null,
        rootCause: null,
        blockerOwner: null,
        reopenRisk: null,
        currentAssignee: null,
        isRefreshPending: false,
        isStale: false,
        latestCaseChangedAt: null,
        packetGeneratedAt: null,
        viewerFeedbackValue: null,
      },
      loading: false,
      error: null,
      regenerating: false,
      refreshQueuedAt: null,
      submittingFeedback: false,
      refetch: vi.fn(),
      regenerate: vi.fn(),
      submitFeedback: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InterventionCaseCopilotPanel caseId="case-1" />
      </MemoryRouter>
    );

    expect(html).toContain("No copilot packet has been generated for this case yet.");
    expect(html).toContain("Generate");
  });
});
