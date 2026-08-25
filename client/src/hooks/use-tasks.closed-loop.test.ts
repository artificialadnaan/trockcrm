// `taskHasUnreadReply` is the client's copy of the server's "needs attention" predicate, and the two
// have to agree: the server decides what is IN the bucket, this decides what the row LOOKS like, and a
// row rendered as read inside a bucket of unread tasks is the card/aggregate divergence this repo
// keeps re-learning.
//
// The `<` comparison is the part worth pinning. Under a design that CLEARED the acknowledgement on
// every new reply it would be unreachable — an ack only ever writes a timestamp at least as new as the
// reply it acknowledges — so every re-raise would run through the IS NULL branch and the comparison
// could be deleted with the suite still green. The acknowledgement here is monotonic, so the third
// case below genuinely exercises it.
import { describe, expect, it } from "vitest";
import { taskHasUnreadReply } from "./use-tasks";

describe("taskHasUnreadReply", () => {
  it("is false for a task nobody has replied to", () => {
    expect(taskHasUnreadReply({ lastReplyAt: null, assignerAckAt: null })).toBe(false);
    expect(taskHasUnreadReply({ lastReplyAt: null, assignerAckAt: "2026-05-01T10:00:00Z" })).toBe(false);
  });

  it("is true for a reply that has never been acknowledged", () => {
    expect(taskHasUnreadReply({ lastReplyAt: "2026-05-01T10:00:00Z", assignerAckAt: null })).toBe(true);
  });

  // THE REACHABLE COMPARISON. The acknowledgement survives the new reply (it is monotonic), so this
  // case is decided by `assignerAckAt < lastReplyAt` and by nothing else.
  it("re-raises a task when a reply lands after an acknowledgement", () => {
    expect(
      taskHasUnreadReply({
        lastReplyAt: "2026-05-01T11:00:00Z",
        assignerAckAt: "2026-05-01T10:00:00Z",
      })
    ).toBe(true);
  });

  it("is false once the acknowledgement has caught up to the newest reply", () => {
    expect(
      taskHasUnreadReply({
        lastReplyAt: "2026-05-01T10:00:00Z",
        assignerAckAt: "2026-05-01T10:00:00Z",
      })
    ).toBe(false);
  });

  it("is false when the acknowledgement runs ahead of the newest reply", () => {
    expect(
      taskHasUnreadReply({
        lastReplyAt: "2026-05-01T10:00:00Z",
        assignerAckAt: "2026-05-01T23:00:00Z",
      })
    ).toBe(false);
  });

  // Compared as instants, not as strings: two encodings of the same moment must not disagree.
  it("compares instants rather than the raw strings", () => {
    expect(
      taskHasUnreadReply({
        lastReplyAt: "2026-05-01T11:00:00.000Z",
        assignerAckAt: "2026-05-01T06:00:00.000-05:00", // === 11:00:00Z
      })
    ).toBe(false);
  });
});
