import { describe, it, expect } from "vitest";
import {
  CORRECTIVE_ACTION_ITEM_STATUSES,
  CORRECTIVE_ACTION_OUTSTANDING_STATUSES,
  CORRECTIVE_ACTION_OUTSTANDING_SQL_LIST,
  isCorrectiveActionAwaitingApproval,
  isCorrectiveActionOutstanding,
} from "../corrective-action-status.js";

describe("corrective-action outstanding set", () => {
  it("counts BOTH open and rejected as outstanding", () => {
    // The whole point: a rejected item is still the responder's to fix. Treating it as done lets a card
    // close with rejected work in it.
    expect(isCorrectiveActionOutstanding("open")).toBe(true);
    expect(isCorrectiveActionOutstanding("rejected")).toBe(true);
  });

  it("does not count submitted or approved as outstanding", () => {
    // `submitted` is the APPROVER's to action, not the responder's.
    expect(isCorrectiveActionOutstanding("submitted")).toBe(false);
    expect(isCorrectiveActionOutstanding("approved")).toBe(false);
    expect(isCorrectiveActionOutstanding(null)).toBe(false);
    expect(isCorrectiveActionOutstanding(undefined)).toBe(false);
    expect(isCorrectiveActionOutstanding("nonsense")).toBe(false);
  });

  it("only submitted awaits approval", () => {
    expect(isCorrectiveActionAwaitingApproval("submitted")).toBe(true);
    for (const status of ["open", "approved", "rejected", "resolved", ""]) {
      expect(isCorrectiveActionAwaitingApproval(status)).toBe(false);
    }
  });

  it("keeps the SQL literal list in step with the outstanding set", () => {
    // Raw SQL (the partial index, the worker's queries) cannot import the array, so this is what stops the
    // two representations drifting.
    expect(CORRECTIVE_ACTION_OUTSTANDING_SQL_LIST).toBe("'open','rejected'");
    for (const status of CORRECTIVE_ACTION_OUTSTANDING_STATUSES) {
      expect(CORRECTIVE_ACTION_OUTSTANDING_SQL_LIST).toContain(`'${status}'`);
    }
  });

  it("every outstanding and awaiting-approval status is a real item status", () => {
    for (const status of CORRECTIVE_ACTION_OUTSTANDING_STATUSES) {
      expect(CORRECTIVE_ACTION_ITEM_STATUSES).toContain(status);
    }
  });

  it("no longer recognises the pre-approval `resolved` name", () => {
    // Migration renames the data; a stray 'resolved' would silently read as neither outstanding nor
    // awaiting approval, stranding the card. This test is the tripwire if the rename is ever reverted.
    expect(CORRECTIVE_ACTION_ITEM_STATUSES).not.toContain("resolved" as never);
  });
});
