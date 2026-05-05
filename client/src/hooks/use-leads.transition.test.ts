/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { transitionLeadStage } from "./use-leads";

describe("transitionLeadStage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.cookie = "csrf_token=; Max-Age=0; path=/";
  });

  it("sends X-CSRF-Token from the csrf_token cookie", async () => {
    document.cookie = "csrf_token=test-csrf-token; path=/";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, lead: { id: "lead-1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await transitionLeadStage("lead-1", {
      targetStageId: "stage-qualified-lead",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/leads/lead-1/stage-transition",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-CSRF-Token": "test-csrf-token",
        }),
      })
    );
  });

  it("normalizes LEAD_STAGE_REQUIREMENTS_UNMET error envelopes into blocked move results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            message: "Complete the lead intake fields before moving this lead to Qualified Lead.",
            code: "LEAD_STAGE_REQUIREMENTS_UNMET",
            missingRequirements: {
              prerequisiteFields: ["qualificationPayload.existing_customer_status"],
              qualificationFields: [],
              projectTypeQuestionIds: [],
            },
          },
        }),
      })
    );

    await expect(
      transitionLeadStage("lead-1", {
        targetStageId: "stage-qualified-lead",
      })
    ).resolves.toEqual({
      ok: false,
      reason: "missing_requirements",
      targetStageId: "stage-qualified-lead",
      resolution: "inline",
      missing: [
        {
          key: "qualificationPayload.existing_customer_status",
          label: "qualificationPayload.existing_customer_status",
          resolution: "inline",
        },
      ],
    });
  });

  it("returns successful transition responses", async () => {
    const payload = {
      ok: true as const,
      lead: { id: "lead-1", stageId: "stage-qualified-lead" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => payload,
      })
    );

    await expect(
      transitionLeadStage("lead-1", {
        targetStageId: "stage-qualified-lead",
      })
    ).resolves.toEqual(payload);
  });

  it("throws API messages for non-stage-gate failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: { message: "Server exploded" } }),
      })
    );

    await expect(
      transitionLeadStage("lead-1", {
        targetStageId: "stage-qualified-lead",
      })
    ).rejects.toThrow("Server exploded");
  });
});
