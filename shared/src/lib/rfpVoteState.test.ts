import { describe, it, expect } from "vitest";
import {
  computeRfpVoteState,
  type RfpVoteRecord,
} from "./rfpVoteState.js";

const t = (iso: string) => new Date(iso);

function vote(
  decision: "approve" | "reject",
  createdAt: Date,
  voterEmail = "voter@trock.com",
): RfpVoteRecord {
  return { voterUserId: voterEmail, voterEmail, decision, reason: null, createdAt };
}

describe("computeRfpVoteState", () => {
  it("empty -> pending, no decidedAt", () => {
    expect(computeRfpVoteState([])).toEqual({
      approvals: 0,
      rejections: 0,
      outcome: "pending",
      decidedAt: null,
    });
  });

  it("1 approve -> pending", () => {
    const r = computeRfpVoteState([vote("approve", t("2026-07-02T10:00:00Z"), "a@t.com")]);
    expect(r.approvals).toBe(1);
    expect(r.rejections).toBe(0);
    expect(r.outcome).toBe("pending");
    expect(r.decidedAt).toBeNull();
  });

  it("2 approve -> approved; decidedAt = the 2nd approve's createdAt (sorted asc)", () => {
    const first = t("2026-07-02T10:00:00Z");
    const second = t("2026-07-02T11:30:00Z");
    const r = computeRfpVoteState([
      vote("approve", first, "a@t.com"),
      vote("approve", second, "b@t.com"),
    ]);
    expect(r.approvals).toBe(2);
    expect(r.outcome).toBe("approved");
    expect(r.decidedAt).toEqual(second);
  });

  it("decidedAt uses createdAt ORDER, not array order", () => {
    const early = t("2026-07-02T10:00:00Z");
    const late = t("2026-07-02T12:00:00Z");
    // Passed late-first; the threshold-th vote by createdAt is still `late`.
    const r = computeRfpVoteState([
      vote("approve", late, "b@t.com"),
      vote("approve", early, "a@t.com"),
    ]);
    expect(r.outcome).toBe("approved");
    expect(r.decidedAt).toEqual(late);
  });

  it("2 reject -> rejected; decidedAt = the 2nd reject's createdAt", () => {
    const first = t("2026-07-02T09:00:00Z");
    const second = t("2026-07-02T09:15:00Z");
    const r = computeRfpVoteState([
      vote("reject", first, "a@t.com"),
      vote("reject", second, "b@t.com"),
    ]);
    expect(r.rejections).toBe(2);
    expect(r.outcome).toBe("rejected");
    expect(r.decidedAt).toEqual(second);
  });

  it("approve, reject, approve -> approved at the 2nd approve (mixed ordering)", () => {
    const a1 = t("2026-07-02T10:00:00Z");
    const rj = t("2026-07-02T10:30:00Z");
    const a2 = t("2026-07-02T11:00:00Z");
    const r = computeRfpVoteState([
      vote("approve", a1, "a@t.com"),
      vote("reject", rj, "b@t.com"),
      vote("approve", a2, "c@t.com"),
    ]);
    expect(r.approvals).toBe(2);
    expect(r.rejections).toBe(1);
    expect(r.outcome).toBe("approved");
    expect(r.decidedAt).toEqual(a2);
  });

  it("honors a threshold override (threshold: 1 decides on the first matching vote)", () => {
    const only = t("2026-07-02T10:00:00Z");
    const r = computeRfpVoteState([vote("reject", only, "a@t.com")], { threshold: 1 });
    expect(r.outcome).toBe("rejected");
    expect(r.decidedAt).toEqual(only);
  });

  it("ignores extra votes past the decision (decidedAt stays the threshold-crossing vote)", () => {
    const a1 = t("2026-07-02T10:00:00Z");
    const a2 = t("2026-07-02T10:05:00Z");
    const a3 = t("2026-07-02T10:59:00Z");
    const r = computeRfpVoteState([
      vote("approve", a1, "a@t.com"),
      vote("approve", a2, "b@t.com"),
      vote("approve", a3, "c@t.com"),
    ]);
    expect(r.approvals).toBe(3);
    expect(r.outcome).toBe("approved");
    expect(r.decidedAt).toEqual(a2); // the 2nd approve decided it; the 3rd doesn't move decidedAt
  });

  it("accepts ISO-string createdAt as well as Date", () => {
    const r = computeRfpVoteState([
      { voterUserId: null, voterEmail: "a@t.com", decision: "approve", reason: null, createdAt: "2026-07-02T10:00:00Z" },
      { voterUserId: null, voterEmail: "b@t.com", decision: "approve", reason: null, createdAt: "2026-07-02T11:00:00Z" },
    ]);
    expect(r.outcome).toBe("approved");
    expect(r.decidedAt).toEqual(new Date("2026-07-02T11:00:00Z"));
  });
});
