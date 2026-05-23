import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

vi.mock("../../src/db.js", () => ({
  pool: {
    query: queryMock,
  },
}));

const { runAiRefreshCopilot } = await import("../../src/jobs/ai-refresh-copilot.js");

describe("ai refresh copilot job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue({ rows: [] });
  });

  it("rejects and logs when requestedBy is missing", async () => {
    const result = await runAiRefreshCopilot(
      {
        dealId: "deal-1",
        reason: "manual_regenerate",
      } as any,
      "office-1"
    );

    expect(result).toEqual({
      status: "dead",
      error: "[Worker:ai-refresh-copilot] Missing requestedBy for dealId=deal-1",
    });
    expect(errorSpy).toHaveBeenCalledWith("[Worker:ai-refresh-copilot] Missing requestedBy for dealId=deal-1");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("preserves requestedBy when queueing the generate job", async () => {
    await runAiRefreshCopilot(
      {
        dealId: "deal-1",
        reason: "manual_regenerate",
        requestedBy: "user-7",
        requestedByRole: "director",
      },
      "office-1"
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(String(queryMock.mock.calls[0]?.[1]?.[0] ?? "")).toContain("\"requestedBy\":\"user-7\"");
    expect(String(queryMock.mock.calls[0]?.[1]?.[0] ?? "")).toContain("\"requestedByRole\":\"director\"");
  });
});
