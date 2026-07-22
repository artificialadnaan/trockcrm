import { describe, expect, it } from "vitest";
import { assertScorecardEvidenceUploadCard } from "../../../src/modules/field/scorecard-evidence-upload.js";

const card = {
  dealId: "deal-1",
  submittedBy: "user-1",
  status: "submitted",
  formVersion: 2,
  isActive: true,
};

function captureError(candidate: Parameters<typeof assertScorecardEvidenceUploadCard>[0], target = { dealId: "deal-1" }) {
  try {
    assertScorecardEvidenceUploadCard(candidate, { userId: "user-1", target });
    return null;
  } catch (error) {
    return error as { statusCode?: number; code?: string; message?: string };
  }
}

describe("assertScorecardEvidenceUploadCard", () => {
  it("allows the exact submitter to add evidence to the active submitted V2 card's deal", () => {
    expect(captureError(card)).toBeNull();
  });

  it("allows evidence on the open/closed corrective-action states (same editable lifecycle as the edit guard)", () => {
    // The mobile editor opens on these statuses (canEdit), so evidence presign must be permitted here too —
    // else adding a photo to an open/closed corrective card 422s with SCORECARD_EDIT_UNSUPPORTED.
    expect(captureError({ ...card, status: "corrective_action_open" })).toBeNull();
    expect(captureError({ ...card, status: "corrective_action_closed" })).toBeNull();
  });

  it("rejects non-deal, lead, opportunity, and mismatched-deal targets", () => {
    expect(captureError(card, {} as any)?.statusCode).toBe(400);
    expect(captureError(card, { dealId: "deal-1", leadId: "lead-1" } as any)?.statusCode).toBe(400);
    expect(captureError(card, { dealId: "deal-1", opportunityId: "opp-1" } as any)?.statusCode).toBe(400);
    expect(captureError(card, { dealId: "deal-2" })?.statusCode).toBe(422);
  });

  it("rejects an inactive/missing scorecard, a different submitter, and unsupported edit states", () => {
    expect(captureError(null)?.statusCode).toBe(404);
    expect(captureError({ ...card, isActive: false })?.statusCode).toBe(404);
    expect(captureError({ ...card, submittedBy: "user-2" })).toMatchObject({
      statusCode: 403,
      code: "SCORECARD_EDIT_FORBIDDEN",
    });
    expect(captureError({ ...card, status: "draft" })).toMatchObject({
      statusCode: 422,
      code: "SCORECARD_EDIT_UNSUPPORTED",
    });
    expect(captureError({ ...card, formVersion: 1 })).toMatchObject({
      statusCode: 422,
      code: "SCORECARD_EDIT_UNSUPPORTED",
    });
  });
});
