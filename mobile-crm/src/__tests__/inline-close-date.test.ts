import {
  businessDateInDays,
  businessTodayDateStr,
  isExpectedCloseDateSoleGateBlocker,
  isGateResolvedByInlineCloseDate,
  isUsableCloseDate,
} from "../inline-close-date";

const soleBlocker = {
  missingRequirements: { fields: ["expectedCloseDate"], documents: [], approvals: [] },
  isBackwardMove: false,
  currentStageSlug: "opportunity",
  bidBoardLocked: false,
};

describe("isExpectedCloseDateSoleGateBlocker", () => {
  it("is true when the close date is the only missing field", () => {
    expect(isExpectedCloseDateSoleGateBlocker(soleBlocker)).toBe(true);
  });

  it("is false when another field is missing too", () => {
    expect(
      isExpectedCloseDateSoleGateBlocker({
        ...soleBlocker,
        missingRequirements: { fields: ["expectedCloseDate", "awardedAmount"], documents: [], approvals: [] },
      }),
    ).toBe(false);
  });

  it("is false when a document or approval is outstanding", () => {
    expect(
      isExpectedCloseDateSoleGateBlocker({
        ...soleBlocker,
        missingRequirements: { fields: ["expectedCloseDate"], documents: ["signed_contract"], approvals: [] },
      }),
    ).toBe(false);
    expect(
      isExpectedCloseDateSoleGateBlocker({
        ...soleBlocker,
        missingRequirements: { fields: ["expectedCloseDate"], documents: [], approvals: ["director"] },
      }),
    ).toBe(false);
  });

  /** The three exclusions the inline date cannot clear. Each was rejected by the server, not guessed. */
  it("is false on a backward move — the override is for the direction, not the field", () => {
    expect(isExpectedCloseDateSoleGateBlocker({ ...soleBlocker, isBackwardMove: true })).toBe(false);
  });

  it("is false from close_out, where an override can be required with no missing-field footprint", () => {
    expect(isExpectedCloseDateSoleGateBlocker({ ...soleBlocker, currentStageSlug: "close_out" })).toBe(false);
  });

  it("is false for a Bid Board read-only mirror, which preflight blocks regardless", () => {
    expect(isExpectedCloseDateSoleGateBlocker({ ...soleBlocker, bidBoardLocked: true })).toBe(false);
  });

  it("is false when nothing is missing at all", () => {
    expect(isExpectedCloseDateSoleGateBlocker({ ...soleBlocker, missingRequirements: null })).toBe(false);
  });
});

describe("isUsableCloseDate", () => {
  const today = "2026-07-27";

  it("accepts today and later", () => {
    expect(isUsableCloseDate("2026-07-27", today)).toBe(true);
    expect(isUsableCloseDate("2026-12-01", today)).toBe(true);
  });

  it("rejects the past", () => {
    expect(isUsableCloseDate("2026-07-26", today)).toBe(false);
  });

  it("rejects a date that does not exist rather than rolling it forward", () => {
    // `new Date("2026-02-31")` silently becomes March 3 — the round-trip is what catches it.
    expect(isUsableCloseDate("2026-02-31", today)).toBe(false);
    expect(isUsableCloseDate("2026-13-01", today)).toBe(false);
  });

  it("rejects unpadded input, which would otherwise compare as a string wrongly", () => {
    // "2026-7-9" > "2026-07-27" lexically, so a lax check would accept a date it never validated.
    expect(isUsableCloseDate("2026-7-9", today)).toBe(false);
  });

  it("rejects empty and free text", () => {
    expect(isUsableCloseDate("", today)).toBe(false);
    expect(isUsableCloseDate("next tuesday", today)).toBe(false);
  });
});

describe("isGateResolvedByInlineCloseDate", () => {
  const today = "2026-07-27";

  it("needs BOTH a clearable gate and a usable date", () => {
    expect(isGateResolvedByInlineCloseDate(soleBlocker, "2026-09-01", today)).toBe(true);
    expect(isGateResolvedByInlineCloseDate(soleBlocker, "2026-01-01", today)).toBe(false);
    expect(isGateResolvedByInlineCloseDate({ ...soleBlocker, isBackwardMove: true }, "2026-09-01", today)).toBe(
      false,
    );
  });
});

describe("business date helpers", () => {
  it("reads today in CT, not UTC — 8pm CT is still today even though UTC has rolled over", () => {
    // 2026-07-28T01:30:00Z is 2026-07-27 20:30 CT.
    expect(businessTodayDateStr(new Date("2026-07-28T01:30:00Z"))).toBe("2026-07-27");
  });

  it("offsets from the CT day and stays a real calendar date across a month end", () => {
    expect(businessDateInDays(0, new Date("2026-07-28T01:30:00Z"))).toBe("2026-07-27");
    expect(businessDateInDays(30, new Date("2026-07-28T01:30:00Z"))).toBe("2026-08-26");
    expect(businessDateInDays(5, new Date("2026-02-25T12:00:00Z"))).toBe("2026-03-02");
  });
});
