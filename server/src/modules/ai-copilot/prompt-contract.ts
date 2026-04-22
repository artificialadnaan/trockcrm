import type { DealBlindSpotSignal } from "./signal-service.js";
import type { DealCopilotContext } from "./context-service.js";
import type { DealKnowledgeChunk } from "./retrieval-service.js";

export interface DealCopilotPromptInput {
  context: DealCopilotContext;
  signals: DealBlindSpotSignal[];
  evidence: DealKnowledgeChunk[];
}

export interface DealCopilotPromptOutput {
  summary: string;
  recommendedNextStep: {
    action: string;
    ownerId: string | null;
    dueLabel: string | null;
    rationale: string;
  };
  suggestedTasks: Array<{
    title: string;
    description: string | null;
    suggestedOwnerId: string | null;
    priority: string;
    confidence: number;
    evidence: Array<Record<string, unknown>>;
  }>;
  blindSpotFlags: Array<{
    flagType: string;
    severity: string;
    title: string;
    details: string | null;
    evidence: Array<Record<string, unknown>>;
  }>;
  confidence: number;
  evidence: Array<Record<string, unknown>>;
}

export interface InterventionCopilotPromptInput {
  context: {
    caseId: string;
    disconnectType: string;
    severity: string;
    status: string;
    currentAssigneeId: string | null;
    assignedToName: string | null;
    ownerTeamLabel: string | null;
    generatedTaskOwnerId: string | null;
    generatedTaskOwnerName: string | null;
    generatedTaskStatus: string | null;
    generatedTaskTitle: string | null;
    reopenCount: number;
    escalated: boolean;
    stageKey: string | null;
    stageName: string | null;
  };
  signals: {
    rootCauseHints: string[];
    riskHints: string[];
    similarCaseSummaries: Array<{
      label: string;
      outcome: string;
    }>;
  };
  evidence: Array<Record<string, unknown>>;
}

export interface InterventionCopilotPromptOutput {
  summary: string;
  recommendedAction: {
    action: "assign" | "resolve" | "snooze" | "escalate" | "investigate";
    rationale: string;
    suggestedOwner: string | null;
    suggestedOwnerId: string | null;
  };
  rootCause: { label: string; details: string | null } | null;
  blockerOwner: { label: string; details: string | null } | null;
  reopenRisk: { level: "low" | "medium" | "high"; rationale: string | null } | null;
  blindSpotFlags: Array<{
    flagType: string;
    severity: "low" | "medium" | "high" | "critical";
    title: string;
    details: string | null;
  }>;
  confidence: number;
  evidence: Array<Record<string, unknown>>;
}
