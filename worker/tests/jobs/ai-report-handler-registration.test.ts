import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The REGISTRATION, not the handler.
 *
 * ai-report-generation.test.ts calls handleAiReportGeneration directly with an explicit attempt context, so
 * it passed happily while the registered wrapper was `(payload) => handleAiReportGeneration(payload)` —
 * dropping the context and making the dead-letter reconciliation unreachable in production. A unit test of a
 * function cannot see how that function is wired up; this file exists to cover that seam.
 */

const registerJobHandlerMock = vi.fn();
const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();

vi.mock("../../src/queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/queue.js")>();
  return {
    ...actual,
    registerJobHandler: registerJobHandlerMock.mockImplementation((jobType: string, handler: any) => {
      handlers.set(jobType, handler);
    }),
  };
});

const shimMock = vi.fn(async () => undefined);
vi.mock("../../src/jobs/ai-report-generation.js", () => ({ handleAiReportGeneration: shimMock }));

const { registerAllJobs } = await import("../../src/jobs/index.js");

describe("ai_report_generation handler registration", () => {
  beforeEach(() => {
    registerJobHandlerMock.mockClear();
    handlers.clear();
    shimMock.mockReset();
    shimMock.mockResolvedValue(undefined);
    registerAllJobs();
  });

  it("forwards the attempt context the shim needs to reconcile a dead delivery", async () => {
    const handler = handlers.get("ai_report_generation");
    expect(handler).toBeDefined();

    const ctx = { attempt: 3, maxAttempts: 3, isFinalAttempt: true };
    await handler!({ runId: "run-1" }, "office-1", undefined, ctx);

    // The fourth argument is the whole point: without it the shim's ctx is undefined and it never writes the
    // terminal state onto a run whose delivery is about to be dead-lettered.
    expect(shimMock).toHaveBeenCalledWith({ runId: "run-1" }, "office-1", undefined, ctx);
  });

  it("returns the shim's result rather than discarding it", async () => {
    // A run held by a live attempt comes back as a deferral, which must reschedule the delivery instead of
    // being recorded as completed.
    const deferral = { status: "pending", error: "held by an earlier attempt", runAfterSeconds: 300 };
    shimMock.mockResolvedValue(deferral as never);

    const handler = handlers.get("ai_report_generation");
    await expect(handler!({ runId: "run-1" }, "office-1", undefined, undefined)).resolves.toEqual(deferral);
  });
});
