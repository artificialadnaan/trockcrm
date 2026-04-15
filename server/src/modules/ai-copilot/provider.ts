import type { DealCopilotPromptInput, DealCopilotPromptOutput } from "./prompt-contract.js";

export interface AiCopilotProvider {
  generateCopilotPacket(input: DealCopilotPromptInput): Promise<DealCopilotPromptOutput>;
}

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

type ExternalProviderName = "openai" | "anthropic";

interface ProviderConfig {
  provider: "heuristic" | ExternalProviderName;
  openaiApiKey?: string;
  openaiModel?: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
}

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

function buildSystemPrompt() {
  return [
    "You are an AI copilot for a construction CRM.",
    "Use the provided context, signals, and retrieved evidence to produce a single JSON object.",
    "Be grounded in the provided data. Do not invent facts, people, dates, or amounts.",
    "Prioritize immediate next steps, operational blind spots, and task suggestions.",
    "Return valid JSON only with these keys: summary, recommendedNextStep, suggestedTasks, blindSpotFlags, confidence, evidence.",
    "recommendedNextStep must include action, ownerId, dueLabel, rationale.",
    "suggestedTasks must be an array of up to 3 items.",
    "blindSpotFlags must map to observed risk themes from the provided inputs.",
  ].join(" ");
}

function buildUserPrompt(input: DealCopilotPromptInput) {
  return JSON.stringify(
    {
      context: input.context,
      signals: input.signals,
      evidence: input.evidence,
    },
    null,
    2
  );
}

function stripCodeFences(text: string) {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

function extractJsonObject(text: string): string {
  const normalized = stripCodeFences(text);
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Provider response did not contain a JSON object");
  }
  return normalized.slice(start, end + 1);
}

function normalizeProviderOutput(raw: unknown): DealCopilotPromptOutput {
  if (!raw || typeof raw !== "object") {
    throw new Error("Provider response was not an object");
  }

  const parsed = raw as Partial<DealCopilotPromptOutput>;
  if (!parsed.summary || !parsed.recommendedNextStep) {
    throw new Error("Provider response missing required copilot fields");
  }

  return {
    summary: parsed.summary,
    recommendedNextStep: {
      action: parsed.recommendedNextStep.action,
      ownerId: parsed.recommendedNextStep.ownerId ?? null,
      dueLabel: parsed.recommendedNextStep.dueLabel ?? null,
      rationale: parsed.recommendedNextStep.rationale,
    },
    suggestedTasks: (parsed.suggestedTasks ?? []).slice(0, 3),
    blindSpotFlags: parsed.blindSpotFlags ?? [],
    confidence: Number(parsed.confidence ?? 0.5),
    evidence: parsed.evidence ?? [],
  };
}

async function parseOpenAiResponse(response: Response) {
  const json = await response.json();
  const text =
    json.output_text ??
    json.output?.flatMap?.((item: any) => item.content ?? [])?.find?.((item: any) => item.type === "output_text")?.text ??
    json.output?.find?.((item: any) => item.type === "message")?.content?.find?.((item: any) => item.type === "output_text")?.text;

  if (!text || typeof text !== "string") {
    throw new Error("OpenAI response did not include output text");
  }

  return normalizeProviderOutput(JSON.parse(extractJsonObject(text)));
}

async function parseAnthropicResponse(response: Response) {
  const json = await response.json();
  const text = json.content?.find?.((item: any) => item.type === "text")?.text;
  if (!text || typeof text !== "string") {
    throw new Error("Anthropic response did not include text content");
  }
  return normalizeProviderOutput(JSON.parse(extractJsonObject(text)));
}

function getProviderConfig(): ProviderConfig {
  const provider = (process.env.AI_COPILOT_PROVIDER ?? "heuristic").toLowerCase();
  return {
    provider: provider === "openai" || provider === "anthropic" ? provider : "heuristic",
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.AI_COPILOT_OPENAI_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel: process.env.AI_COPILOT_ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
  };
}

function createExternalProvider(
  name: ExternalProviderName,
  config: ProviderConfig,
  fallback: AiCopilotProvider
): AiCopilotProvider {
  return {
    async generateCopilotPacket(input) {
      try {
        if (name === "openai") {
          if (!config.openaiApiKey) return fallback.generateCopilotPacket(input);

          const response = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.openaiApiKey}`,
            },
            body: JSON.stringify({
              model: config.openaiModel,
              input: [
                { role: "developer", content: [{ type: "input_text", text: buildSystemPrompt() }] },
                { role: "user", content: [{ type: "input_text", text: buildUserPrompt(input) }] },
              ],
            }),
          });

          if (!response.ok) {
            throw new Error(`OpenAI provider request failed with ${response.status}`);
          }

          return parseOpenAiResponse(response);
        }

        if (!config.anthropicApiKey) return fallback.generateCopilotPacket(input);

        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.anthropicApiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: config.anthropicModel,
            max_tokens: 1200,
            system: buildSystemPrompt(),
            messages: [{ role: "user", content: buildUserPrompt(input) }],
          }),
        });

        if (!response.ok) {
          throw new Error(`Anthropic provider request failed with ${response.status}`);
        }

        return parseAnthropicResponse(response);
      } catch (error) {
        console.error(`[AI Copilot] ${name} provider failed, falling back to heuristic provider:`, error);
        return fallback.generateCopilotPacket(input);
      }
    },
  };
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

export function resetAiCopilotProviderForTests() {
  cachedProvider = null;
}

export function getAiCopilotProvider(): AiCopilotProvider {
  if (!cachedProvider) {
    const heuristicProvider = createHeuristicProvider();
    const config = getProviderConfig();

    if (config.provider === "openai") {
      cachedProvider = createExternalProvider("openai", config, heuristicProvider);
    } else if (config.provider === "anthropic") {
      cachedProvider = createExternalProvider("anthropic", config, heuristicProvider);
    } else {
      cachedProvider = heuristicProvider;
    }
  }
  return cachedProvider;
}
