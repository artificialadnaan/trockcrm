import type { UploadUrlRequest } from "../types";

const ordinaryUpload: UploadUrlRequest = {
  dealId: "deal-1",
  contentType: "image/jpeg",
  sizeBytes: 100,
};

const queuedOrdinaryUpload: UploadUrlRequest = {
  dealId: "deal-1",
  clientUploadId: "queue-1",
  contentType: "image/jpeg",
  sizeBytes: 100,
};

const scorecardEditUpload: UploadUrlRequest = {
  dealId: "deal-1",
  scorecardId: "scorecard-1",
  clientUploadId: "queue-2",
  contentType: "image/jpeg",
  sizeBytes: 100,
};

// @ts-expect-error A scorecard-scoped upload must be durably paired with its queue id.
const unpairedScorecardEditUpload: UploadUrlRequest = {
  dealId: "deal-1",
  scorecardId: "scorecard-1",
  contentType: "image/jpeg",
  sizeBytes: 100,
};

describe("UploadUrlRequest", () => {
  it("keeps ordinary uploads valid while pairing scorecard scope with a queue id", () => {
    expect(ordinaryUpload).not.toHaveProperty("scorecardId");
    expect(queuedOrdinaryUpload.clientUploadId).toBe("queue-1");
    expect(scorecardEditUpload).toMatchObject({
      scorecardId: "scorecard-1",
      clientUploadId: "queue-2",
    });
    expect(unpairedScorecardEditUpload.scorecardId).toBe("scorecard-1");
  });
});
