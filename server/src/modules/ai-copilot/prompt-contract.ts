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
