import { describe, expect, it } from "vitest";
import { normalizeAssigneeSelection } from "./ownership-reassign-selection";

describe("normalizeAssigneeSelection", () => {
  it("keeps the current assignee when it is valid for the selected office", () => {
    expect(
      normalizeAssigneeSelection("user-2", [
        { id: "user-1", displayName: "User One" },
        { id: "user-2", displayName: "User Two" },
      ])
    ).toBe("user-2");
  });

  it("resets a stale assignee when the office changes and the user is no longer available", () => {
    expect(
      normalizeAssigneeSelection("user-2", [{ id: "user-3", displayName: "User Three" }])
    ).toBe("user-3");
  });

  it("returns an empty selection when no assignees are available", () => {
    expect(normalizeAssigneeSelection("user-2", [])).toBe("");
  });
});
