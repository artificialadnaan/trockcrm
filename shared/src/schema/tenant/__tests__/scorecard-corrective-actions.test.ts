import { describe, expect, it } from "vitest";
import { scorecardCorrectiveActions } from "../scorecard-corrective-actions.js";

describe("scorecardCorrectiveActions schema", () => {
  it("exposes the tracked-item columns", () => {
    const cols = Object.keys(scorecardCorrectiveActions);
    for (const c of [
      "id",
      "scorecardId",
      "itemType",
      "itemRef",
      "itemLabel",
      "status",
      "responseComment",
      "respondedByUserId",
      "responderName",
      "responderEmail",
      "respondedAt",
    ]) {
      expect(cols).toContain(c);
    }
  });
});
