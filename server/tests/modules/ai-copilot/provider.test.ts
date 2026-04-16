import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerModule = await import("../../../src/modules/ai-copilot/provider.js");
const { getAiCopilotProvider, resetAiCopilotProviderForTests } = providerModule;

const baseInput = {
  context: {
    deal: {
      id: "deal-1",
      name: "Alpha Plaza",
      stageName: "Estimating",
      assignedRepId: "user-1",
      proposalStatus: "revision_requested",
    },
    recentActivities: [],
    recentEmails: [],
    taskSummary: {
      openTaskCount: 1,
      overdueTaskCount: 0,
    },
  },
  signals: [
    {
      signalType: "missing_next_task",
      severity: "warning",
      summary: "Deal has no active follow-up task",
      evidence: [],
      isBlocking: false,
    },
  ],
  evidence: [],
} as any;

describe("AI copilot provider", () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetAiCopilotProviderForTests();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    resetAiCopilotProviderForTests();
  });

  it("uses the heuristic provider by default", async () => {
    delete process.env.AI_COPILOT_PROVIDER;

    const provider = getAiCopilotProvider();
    const result = await provider.generateCopilotPacket(baseInput);

    expect(result.summary).toContain("Alpha Plaza");
    expect(result.suggestedTasks.length).toBeGreaterThan(0);
  });

  it("uses the OpenAI provider when configured and parses JSON output", async () => {
    process.env.AI_COPILOT_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.AI_COPILOT_OPENAI_MODEL = "gpt-test";

    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            summary: "LLM summary",
            recommendedNextStep: {
              action: "Call customer",
              ownerId: "user-1",
              dueLabel: "Today",
              rationale: "Recent inbound message needs a reply.",
            },
            suggestedTasks: [],
            blindSpotFlags: [],
            confidence: 0.91,
            evidence: [],
          }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as any;

    const provider = getAiCopilotProvider();
    const result = await provider.generateCopilotPacket(baseInput);

    expect(result.summary).toBe("LLM summary");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("falls back to heuristic output when the external provider fails", async () => {
    process.env.AI_COPILOT_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    global.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as any;

    const provider = getAiCopilotProvider();
    const result = await provider.generateCopilotPacket(baseInput);

    expect(result.summary).toContain("Alpha Plaza");
    expect(result.recommendedNextStep.action.length).toBeGreaterThan(0);
  });
});
