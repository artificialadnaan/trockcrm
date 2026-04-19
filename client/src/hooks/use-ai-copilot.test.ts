import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const hookState = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  reset() {
    this.values = [];
    this.index = 0;
  },
  rewind() {
    this.index = 0;
  },
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");

  return {
    ...actual,
    useState: (initialValue: unknown) => {
      const index = hookState.index++;
      if (hookState.values[index] === undefined) {
        hookState.values[index] = initialValue;
      }

      const setState = (value: unknown) => {
        hookState.values[index] =
          typeof value === "function"
            ? (value as (previous: unknown) => unknown)(hookState.values[index])
            : value;
      };

      return [hookState.values[index], setState] as const;
    },
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useRef: (initialValue: unknown) => ({ current: initialValue }),
    useEffect: (effect: () => void | Promise<void>) => {
      void effect();
    },
  };
});

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

const { useInterventionCopilot } = await import("./use-ai-copilot");

function buildCopilotView() {
  return {
    packet: {
      id: "packet-1",
      scopeType: "intervention_case" as const,
      scopeId: "case-1",
      packetKind: "intervention_case" as const,
      status: "ready",
      snapshotHash: "hash-1",
      modelName: "heuristic",
      summaryText: "Owner alignment is likely required.",
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
    riskFlags: [],
    similarCases: [],
    recommendedAction: {
      action: "assign" as const,
      rationale: "The task owner does not match the case owner.",
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
      level: "medium" as const,
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
    viewerFeedbackValue: null,
  };
}

describe("useInterventionCopilot", () => {
  beforeEach(() => {
    apiMock.mockReset();
    hookState.reset();
  });

  it("fetches the current intervention copilot view", async () => {
    apiMock.mockResolvedValueOnce(buildCopilotView());

    hookState.rewind();
    const initial = useInterventionCopilot("case-1");
    expect(initial.loading).toBe(true);

    await Promise.resolve();

    hookState.rewind();
    const result = useInterventionCopilot("case-1");

    expect(result.data?.packet.summaryText).toBe("Owner alignment is likely required.");
    expect(apiMock).toHaveBeenCalledWith("/ai/ops/interventions/case-1/copilot");
  });

  it("posts the regenerate route and refreshes the current view", async () => {
    apiMock.mockResolvedValueOnce(buildCopilotView());

    hookState.rewind();
    useInterventionCopilot("case-1");
    await Promise.resolve();

    hookState.rewind();
    const result = useInterventionCopilot("case-1");

    apiMock.mockResolvedValueOnce({
      queued: false,
      packetId: "packet-2",
      packetGeneratedAt: "2026-04-19T12:05:00.000Z",
      requestedBy: "director-1",
    });
    apiMock.mockResolvedValueOnce({
      ...buildCopilotView(),
      packetGeneratedAt: "2026-04-19T12:05:00.000Z",
    });

    await result.regenerate();

    expect(apiMock).toHaveBeenCalledWith("/ai/ops/interventions/case-1/copilot/regenerate", {
      method: "POST",
    });
    expect(apiMock).toHaveBeenLastCalledWith("/ai/ops/interventions/case-1/copilot");
  });

  it("posts packet feedback and refreshes the view", async () => {
    apiMock.mockResolvedValueOnce(buildCopilotView());

    hookState.rewind();
    useInterventionCopilot("case-1");
    await Promise.resolve();

    hookState.rewind();
    const result = useInterventionCopilot("case-1");

    apiMock.mockResolvedValueOnce({});
    apiMock.mockResolvedValueOnce({
      ...buildCopilotView(),
      viewerFeedbackValue: "positive",
    });

    await result.submitFeedback({
      targetType: "packet",
      targetId: "packet-1",
      feedbackType: "intervention_case_copilot",
      feedbackValue: "positive",
    });

    expect(apiMock).toHaveBeenCalledWith("/ai/feedback", {
      method: "POST",
      json: {
        targetType: "packet",
        targetId: "packet-1",
        feedbackType: "intervention_case_copilot",
        feedbackValue: "positive",
        comment: null,
      },
    });
    expect(apiMock).toHaveBeenLastCalledWith("/ai/ops/interventions/case-1/copilot");
  });
});
