import { beforeEach, describe, expect, it, vi } from "vitest";

const registerJobHandlerMock = vi.fn();
const handlers = new Map<string, (payload: any, officeId: string | null) => Promise<unknown>>();
const runAiRefreshCopilotMock = vi.fn();
const runAiGenerateDealCopilotMock = vi.fn();

vi.mock("../../src/queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/queue.js")>();
  return {
    ...actual,
    registerJobHandler: registerJobHandlerMock.mockImplementation((jobType: string, handler: any) => {
      handlers.set(jobType, handler);
    }),
  };
});

vi.mock("../../src/jobs/ai-refresh-copilot.js", () => ({
  runAiRefreshCopilot: runAiRefreshCopilotMock,
}));

vi.mock("../../src/jobs/ai-generate-deal-copilot.js", () => ({
  runAiGenerateDealCopilot: runAiGenerateDealCopilotMock,
}));

const { deadJob } = await import("../../src/queue.js");
const { registerAllJobs } = await import("../../src/jobs/index.js");

describe("copilot job handler registration", () => {
  beforeEach(() => {
    registerJobHandlerMock.mockClear();
    handlers.clear();
    runAiRefreshCopilotMock.mockReset();
    runAiGenerateDealCopilotMock.mockReset();

    registerAllJobs();
  });

  it("propagates dead ai_refresh_copilot results from the registered handler", async () => {
    const deadResult = deadJob("missing requestedBy");
    runAiRefreshCopilotMock.mockResolvedValue(deadResult);

    const handler = handlers.get("ai_refresh_copilot");
    expect(handler).toBeDefined();

    await expect(handler?.({ dealId: "deal-1" }, "office-1")).resolves.toEqual(deadResult);
    expect(runAiRefreshCopilotMock).toHaveBeenCalledWith({ dealId: "deal-1" }, "office-1");
  });

  it("propagates dead ai_generate_deal_copilot results from the registered handler", async () => {
    const deadResult = deadJob("missing requestedBy");
    runAiGenerateDealCopilotMock.mockResolvedValue(deadResult);

    const handler = handlers.get("ai_generate_deal_copilot");
    expect(handler).toBeDefined();

    await expect(handler?.({ dealId: "deal-1" }, "office-1")).resolves.toEqual(deadResult);
    expect(runAiGenerateDealCopilotMock).toHaveBeenCalledWith({ dealId: "deal-1" }, "office-1");
  });
});
