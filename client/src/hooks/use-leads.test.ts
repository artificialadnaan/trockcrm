import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: vi.fn(),
  resolveApiBase: () => "/api",
}));

const { transitionLeadStage } = await import("./use-leads");

describe("transitionLeadStage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns missing requirement payloads on 409 responses", async () => {
    const payload = {
      ok: false as const,
      reason: "missing_requirements" as const,
      targetStageId: "stage-qualified",
      resolution: "inline" as const,
      missing: [{ key: "source", label: "Lead Source", resolution: "inline" as const }],
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => payload,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await transitionLeadStage("lead-1", {
      targetStageId: "stage-qualified",
      inlinePatch: { source: "trade-show" },
    });

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/leads/lead-1/stage-transition",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      })
    );
  });

  it("throws API message on non-409 errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Invalid transition" } }),
    }));

    await expect(
      transitionLeadStage("lead-1", {
        targetStageId: "stage-qualified",
      })
    ).rejects.toThrow("Invalid transition");
  });

  it("treats missing requirement payloads as retryable even when backend uses 400", async () => {
    const payload = {
      ok: false as const,
      reason: "missing_requirements" as const,
      targetStageId: "stage-ready",
      resolution: "inline" as const,
      missing: [{ key: "directorReviewDecision", label: "Director decision", resolution: "inline" as const }],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => payload,
    }));

    const result = await transitionLeadStage("lead-1", {
      targetStageId: "stage-ready",
    });

    expect(result).toEqual(payload);
  });
});
