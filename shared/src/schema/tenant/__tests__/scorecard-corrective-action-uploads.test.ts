import { describe, expect, it } from "vitest";
import { scorecardCorrectiveActionUploads } from "../scorecard-corrective-action-uploads.js";

describe("scorecardCorrectiveActionUploads schema", () => {
  it("exposes the ownership-ledger columns", () => {
    const cols = Object.keys(scorecardCorrectiveActionUploads);
    for (const c of ["fileId", "scorecardId", "createdAt"]) {
      expect(cols).toContain(c);
    }
  });
});
