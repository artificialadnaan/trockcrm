import { describe, expect, it } from "vitest";
import { dealTeamMembers } from "../deal-team-members.js";
import { scorecardCorrectiveActionTokens } from "../scorecard-corrective-action-tokens.js";

describe("email-only deal team member columns", () => {
  it("exposes memberName + memberEmail on deal_team_members", () => {
    const cols = Object.keys(dealTeamMembers);
    for (const c of ["memberName", "memberEmail"]) {
      expect(cols).toContain(c);
    }
  });

  it("keeps userId nullable so an email-only member can be stored", () => {
    // Drizzle column config: notNull is false for an email-only-capable user_id.
    expect((dealTeamMembers.userId as { notNull: boolean }).notNull).toBe(false);
  });
});

describe("scorecardCorrectiveActionTokens schema", () => {
  it("exposes the recipient-bound token columns", () => {
    const cols = Object.keys(scorecardCorrectiveActionTokens);
    for (const c of [
      "id",
      "scorecardId",
      "tokenHash",
      "recipientEmail",
      "role",
      "expiresAt",
      "consumedAt",
      "createdAt",
    ]) {
      expect(cols).toContain(c);
    }
  });
});
