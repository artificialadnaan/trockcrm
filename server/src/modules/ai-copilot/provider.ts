import type { DealCopilotPromptInput, DealCopilotPromptOutput } from "./prompt-contract.js";

export interface AiCopilotProvider {
  generateCopilotPacket(input: DealCopilotPromptInput): Promise<DealCopilotPromptOutput>;
}

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

function snippet(text: string | null | undefined, max = 180) {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}...`;
}

function buildSuggestedTasks(input: DealCopilotPromptInput): DealCopilotPromptOutput["suggestedTasks"] {
  const tasks: DealCopilotPromptOutput["suggestedTasks"] = [];
  const highestSignal = [...input.signals].sort(
    (left, right) => (SEVERITY_WEIGHT[right.severity] ?? 0) - (SEVERITY_WEIGHT[left.severity] ?? 0)
  )[0];

  const pushTask = (task: DealCopilotPromptOutput["suggestedTasks"][number]) => {
    if (!tasks.some((existing) => existing.title === task.title)) {
      tasks.push(task);
    }
  };

  for (const signal of input.signals) {
    if (signal.signalType === "recent_inbound_no_followup") {
      pushTask({
        title: "Reply to the latest inbound customer thread",
        description: "Customer communication is waiting without a logged follow-up. Send a response and log the outcome.",
        suggestedOwnerId: input.context.deal.assignedRepId,
        priority: "high",
        confidence: 0.82,
        evidence: signal.evidence,
      });
    }

    if (signal.signalType === "missing_next_task") {
      pushTask({
        title: "Create a dated next-step task for this deal",
        description: "The deal has no open task. Add a concrete follow-up with an owner and due date.",
        suggestedOwnerId: input.context.deal.assignedRepId,
        priority: "high",
        confidence: 0.88,
        evidence: signal.evidence,
      });
    }

    if (signal.signalType === "revision_without_owner_movement") {
      pushTask({
        title: "Assign revision ownership and schedule customer follow-up",
        description: "A revision was requested but the workflow has not visibly moved. Assign the owner and set a response checkpoint.",
        suggestedOwnerId: input.context.deal.assignedRepId,
        priority: "urgent",
        confidence: 0.91,
        evidence: signal.evidence,
      });
    }

    if (signal.signalType === "estimating_gate_gap") {
      pushTask({
        title: "Close the missing estimating inputs",
        description: "Required estimating documents appear incomplete. Confirm what is missing and request the remaining inputs.",
        suggestedOwnerId: input.context.deal.assignedRepId,
        priority: "urgent",
        confidence: 0.9,
        evidence: signal.evidence,
      });
    }

    if (signal.signalType === "stale_stage") {
      pushTask({
        title: `Re-open momentum in ${input.context.deal.stageName}`,
        description: "This deal is beyond the stage threshold. Lock the next customer touchpoint and document the outcome.",
        suggestedOwnerId: input.context.deal.assignedRepId,
        priority: "high",
        confidence: 0.78,
        evidence: signal.evidence,
      });
    }
  }

  if (tasks.length === 0 && highestSignal) {
    pushTask({
      title: "Review deal health and set the next checkpoint",
      description: highestSignal.summary,
      suggestedOwnerId: input.context.deal.assignedRepId,
      priority: "normal",
      confidence: 0.68,
      evidence: highestSignal.evidence,
    });
  }

  if (tasks.length === 0) {
    pushTask({
      title: "Confirm the next customer touchpoint",
      description: "The deal has no urgent blind spots, but it still needs a dated next step to maintain momentum.",
      suggestedOwnerId: input.context.deal.assignedRepId,
      priority: "normal",
      confidence: 0.64,
      evidence: [{ dealId: input.context.deal.id }],
    });
  }

  return tasks.slice(0, 3);
}

function buildSummary(input: DealCopilotPromptInput, suggestedTasks: DealCopilotPromptOutput["suggestedTasks"]) {
  const sentences: string[] = [];
  const { deal, taskSummary, recentEmails, recentActivities } = input.context;

  sentences.push(
    `${deal.name} is in ${deal.stageName} with ${taskSummary.openTaskCount} open task${taskSummary.openTaskCount === 1 ? "" : "s"}.`
  );

  if (deal.proposalStatus) {
    sentences.push(`Proposal status is ${deal.proposalStatus.replace(/_/g, " ")}.`);
  }

  if (taskSummary.overdueTaskCount > 0) {
    sentences.push(`${taskSummary.overdueTaskCount} task${taskSummary.overdueTaskCount === 1 ? "" : "s"} are overdue.`);
  }

  if (input.signals.length > 0) {
    const topSignal = [...input.signals].sort(
      (left, right) => (SEVERITY_WEIGHT[right.severity] ?? 0) - (SEVERITY_WEIGHT[left.severity] ?? 0)
    )[0];
    sentences.push(topSignal.summary);
  }

  const latestInbound = recentEmails.find((email) => email.direction === "inbound");
  if (latestInbound) {
    const inboundSnippet = snippet(latestInbound.bodyPreview);
    sentences.push(
      inboundSnippet
        ? `Latest inbound email: "${inboundSnippet}"`
        : "There is recent inbound email activity on the deal."
    );
  } else if (recentActivities[0]?.body) {
    const activitySnippet = snippet(recentActivities[0].body);
    if (activitySnippet) {
      sentences.push(`Recent activity notes mention: "${activitySnippet}"`);
    }
  }

  if (suggestedTasks[0]) {
    sentences.push(`Immediate next step: ${suggestedTasks[0].title}.`);
  }

  return sentences.join(" ");
}

function buildEvidence(input: DealCopilotPromptInput, suggestedTasks: DealCopilotPromptOutput["suggestedTasks"]) {
  const signalEvidence = input.signals.flatMap((signal) =>
    signal.evidence.map((entry) => ({
      sourceType: "signal",
      signalType: signal.signalType,
      severity: signal.severity,
      ...entry,
    }))
  );

  const retrievalEvidence = input.evidence.slice(0, 3).map((chunk) => ({
    sourceType: "retrieval_chunk",
    chunkId: chunk.id,
    documentId: chunk.documentId,
    textSnippet: snippet(chunk.text, 220),
    metadata: chunk.metadata,
  }));

  const taskEvidence = suggestedTasks.slice(0, 1).map((task) => ({
    sourceType: "suggested_task",
    title: task.title,
    priority: task.priority,
  }));

  return [...signalEvidence, ...retrievalEvidence, ...taskEvidence];
}

function createHeuristicProvider(): AiCopilotProvider {
  return {
    async generateCopilotPacket(input) {
      const suggestedTasks = buildSuggestedTasks(input);
      const summary = buildSummary(input, suggestedTasks);
      const evidence = buildEvidence(input, suggestedTasks);
      const blindSpotFlags = input.signals.map((signal) => ({
        flagType: signal.signalType,
        severity: signal.severity === "warning" ? "medium" : signal.severity,
        title: signal.summary,
        details: suggestedTasks[0]?.title ?? null,
        evidence: signal.evidence,
      }));

      return {
        summary,
        recommendedNextStep: {
          action: suggestedTasks[0]?.title ?? "Review deal health and document the next checkpoint",
          ownerId: suggestedTasks[0]?.suggestedOwnerId ?? input.context.deal.assignedRepId,
          dueLabel: input.context.taskSummary.overdueTaskCount > 0 ? "Today" : "Next business day",
          rationale: input.signals[0]?.summary ?? "No critical blind spots were detected, but the deal still benefits from a clear next step.",
        },
        suggestedTasks,
        blindSpotFlags,
        confidence: input.signals.length > 0 ? 0.74 : 0.62,
        evidence,
      };
    },
  };
}

let cachedProvider: AiCopilotProvider | null = null;

export function getAiCopilotProvider(): AiCopilotProvider {
  if (!cachedProvider) {
    cachedProvider = createHeuristicProvider();
  }
  return cachedProvider;
}
