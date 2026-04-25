import { afterEach, describe, expect, it, vi } from "vitest";
import { transitionLeadStage } from "./use-leads";

describe("transitionLeadStage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
      resolution: "detail",
      missing: [
        {
          key: "qualificationPayload.existing_customer_status",
          label: "qualificationPayload.existing_customer_status",
          resolution: "detail",
        },
      ],
    });
  });
});
