import { describe, expect, it } from "vitest";
import {
  bidDueDateToDateOnly,
  dateOnlyToUtcMidnightIso,
  resolveDealBidDueDate,
  resolveDealBidDueDateForRead,
} from "../../../src/modules/deals/bid-due-date.js";

/**
 * The PURE half of the Bid Board due-date read-back. This resolver decides which of three columns supplies
 * a deal's bid due date — and since 2026-07-27 that date is the auto-park horizon for estimating deals, so
 * getting the precedence or the calendar day wrong moves reported dollars. Everything here is DB-free and
 * flag-explicit (the wrapper takes an `env`), so the rules are pinned without a fixture in the way.
 */

const FLAG_ON = { BID_BOARD_DUE_DATE_READBACK: "true" } as NodeJS.ProcessEnv;
const FLAG_OFF = {} as NodeJS.ProcessEnv;

describe("bidDueDateToDateOnly", () => {
  it("returns an exact date-only string verbatim (the lead + Bid Board mirror column shape)", () => {
    expect(bidDueDateToDateOnly("2026-09-01")).toBe("2026-09-01");
  });

  it("reads a UTC-midnight timestamptz Date as its UTC calendar day — no off-by-one", () => {
    // deals.bid_due_date is a timestamptz pinned to UTC midnight (migration 0132) and the SQL twin reads it
    // back with AT TIME ZONE 'UTC'. A local-time read would land on Aug 31 anywhere west of UTC and flip
    // an estimating deal's park verdict, and therefore its value.
    expect(bidDueDateToDateOnly(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09-01");
  });

  it("reads a NON-UTC-offset timestamp string by its UTC day, NOT by slicing the prefix", () => {
    // 2026-08-31T19:00:00-05:00 IS 2026-09-01T00:00:00Z. Prefix-slicing would say Aug 31.
    expect(bidDueDateToDateOnly("2026-08-31T19:00:00-05:00")).toBe("2026-09-01");
  });

  it("returns null for absent, blank and unparseable values", () => {
    expect(bidDueDateToDateOnly(null)).toBeNull();
    expect(bidDueDateToDateOnly(undefined)).toBeNull();
    expect(bidDueDateToDateOnly("   ")).toBeNull();
    expect(bidDueDateToDateOnly("not a date")).toBeNull();
    expect(bidDueDateToDateOnly(new Date("nonsense"))).toBeNull();
  });
});

describe("dateOnlyToUtcMidnightIso", () => {
  it("produces the UTC-midnight instant every deals.bid_due_date writer stores", () => {
    expect(dateOnlyToUtcMidnightIso("2026-09-01")).toBe("2026-09-01T00:00:00.000Z");
    // …and round-trips back to the same calendar day the hold rule reads.
    expect(bidDueDateToDateOnly(new Date(dateOnlyToUtcMidnightIso("2026-09-01")))).toBe("2026-09-01");
  });
});

describe("resolveDealBidDueDate — precedence (pure, flag-free)", () => {
  it("1. the Bid Board mirror wins over both the lead and the deal column", () => {
    const resolved = resolveDealBidDueDate({
      bidBoardDueDate: "2026-09-01",
      hasSourceLead: true,
      leadBidDueDate: "2026-06-01",
      dealBidDueDate: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(resolved).toEqual({ day: "2026-09-01", raw: "2026-09-01", source: "bid_board" });
  });

  it("2. with no mirror, a lead-backed deal takes the LEAD's value over its own column", () => {
    const resolved = resolveDealBidDueDate({
      bidBoardDueDate: null,
      hasSourceLead: true,
      leadBidDueDate: "2026-06-01",
      dealBidDueDate: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(resolved).toEqual({ day: "2026-06-01", raw: "2026-06-01", source: "lead" });
  });

  it("3. a lead-backed deal's CLEARED lead value still beats a stale deal column", () => {
    // The lead OWNS this field (DEAL_FIELD_OWNERSHIP.bidDueDate === "lead"); the deal column is only a
    // compatibility snapshot. Falling back to it here would mask a deliberate clear behind a
    // pre-write-through value — the documented behaviour of both existing read sites, and a regression
    // this test exists to prevent.
    const resolved = resolveDealBidDueDate({
      bidBoardDueDate: null,
      hasSourceLead: true,
      leadBidDueDate: null,
      dealBidDueDate: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(resolved).toEqual({ day: null, raw: null, source: "lead" });
  });

  it("4. a deal with NO source lead falls back to its own column, normalized to a calendar day", () => {
    const dealValue = new Date("2026-07-01T00:00:00.000Z");
    const resolved = resolveDealBidDueDate({
      bidBoardDueDate: null,
      hasSourceLead: false,
      leadBidDueDate: null,
      dealBidDueDate: dealValue,
    });
    // `.day` is normalized for the resolved-fields consumers; `.raw` preserves the stored shape so the
    // deal-detail response keeps publishing the same bytes it always has.
    expect(resolved.day).toBe("2026-07-01");
    expect(resolved.raw).toBe(dealValue);
    expect(resolved.source).toBe("deal");
  });

  it("returns null (not a fabricated date) when every source is empty", () => {
    expect(resolveDealBidDueDate({ hasSourceLead: false })).toEqual({ day: null, raw: null, source: "deal" });
    expect(resolveDealBidDueDate({ hasSourceLead: true })).toEqual({ day: null, raw: null, source: "lead" });
  });

  it("falls THROUGH an unparseable mirror value rather than resolving to null", () => {
    // A mirror the resolver cannot read is not an answer — the lead/deal chain must still apply, or one
    // corrupt column would blank the bid date on every surface at once.
    const resolved = resolveDealBidDueDate({
      bidBoardDueDate: "garbage",
      hasSourceLead: true,
      leadBidDueDate: "2026-06-01",
    });
    expect(resolved).toEqual({ day: "2026-06-01", raw: "2026-06-01", source: "lead" });
  });

  it("normalizes the mirror to a calendar day even when handed a timestamp", () => {
    const resolved = resolveDealBidDueDate({
      bidBoardDueDate: new Date("2026-09-01T00:00:00.000Z"),
      hasSourceLead: false,
    });
    expect(resolved).toEqual({ day: "2026-09-01", raw: "2026-09-01", source: "bid_board" });
  });
});

describe("resolveDealBidDueDateForRead — the flag gate", () => {
  const input = {
    bidBoardDueDate: "2026-09-01",
    hasSourceLead: true,
    leadBidDueDate: "2026-06-01",
    dealBidDueDate: new Date("2026-07-01T00:00:00.000Z"),
  };

  it("flag ON: the Bid Board mirror wins", () => {
    expect(resolveDealBidDueDateForRead(input, FLAG_ON)).toEqual({
      day: "2026-09-01",
      raw: "2026-09-01",
      source: "bid_board",
    });
  });

  // ★ THE PARITY TEST. bid_board_due_date is ALREADY populated on prod, so if the read precedence shipped
  // ungated every deal carrying a mirror value would have its banner date — and, through
  // attachAtRiskResult, its at-risk verdict and effective VALUE — change on deploy, with the
  // write-through still off. Flag off must be indistinguishable from the mirror not existing.
  it("flag OFF: identical to the same input with NO mirror value at all", () => {
    expect(resolveDealBidDueDateForRead(input, FLAG_OFF)).toEqual(
      resolveDealBidDueDate({ ...input, bidBoardDueDate: null })
    );
    expect(resolveDealBidDueDateForRead(input, FLAG_OFF)).toEqual({
      day: "2026-06-01",
      raw: "2026-06-01",
      source: "lead",
    });
  });

  it("flag OFF for a deal with no lead: the deal's own column, unchanged", () => {
    const dealValue = new Date("2026-07-01T00:00:00.000Z");
    expect(
      resolveDealBidDueDateForRead(
        { bidBoardDueDate: "2026-09-01", hasSourceLead: false, dealBidDueDate: dealValue },
        FLAG_OFF
      )
    ).toEqual({ day: "2026-07-01", raw: dealValue, source: "deal" });
  });

  it("treats any value other than the exact string \"true\" as OFF", () => {
    for (const value of ["false", "1", "TRUE", "yes", ""]) {
      expect(
        resolveDealBidDueDateForRead(input, { BID_BOARD_DUE_DATE_READBACK: value } as NodeJS.ProcessEnv).source
      ).toBe("lead");
    }
  });
});
