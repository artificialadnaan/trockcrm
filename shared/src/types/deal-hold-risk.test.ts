import { describe, expect, it } from "vitest";
import {
  daysUntilCloseTarget,
  isAtRiskSuppressedByCloseTarget,
  isDealEffectivelyOnHold,
  CLOSE_TARGET_HOLD_HORIZON_DAYS,
} from "./deal-hold-risk.js";

// CT (America/Chicago) is UTC-5 in June (CDT). 12:00Z = 07:00 CDT on the same calendar day.
const TODAY = "2026-06-01";
const NOW = new Date("2026-06-01T12:00:00.000Z");

function plusDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("daysUntilCloseTarget", () => {
  it("returns null for a missing or unparseable target", () => {
    expect(daysUntilCloseTarget(null, NOW)).toBeNull();
    expect(daysUntilCloseTarget(undefined, NOW)).toBeNull();
    expect(daysUntilCloseTarget("", NOW)).toBeNull();
    expect(daysUntilCloseTarget("not-a-date", NOW)).toBeNull();
  });

  it("returns null for impossible calendar dates instead of silently rolling them over", () => {
    expect(daysUntilCloseTarget("2026-02-31", NOW)).toBeNull();
    expect(daysUntilCloseTarget("2026-13-01", NOW)).toBeNull();
    expect(daysUntilCloseTarget("2026-04-31", NOW)).toBeNull();
    // a genuine leap day still parses
    expect(daysUntilCloseTarget("2028-02-29", NOW)).not.toBeNull();
  });

  it("counts whole calendar days from CT-today to the target date", () => {
    expect(daysUntilCloseTarget(TODAY, NOW)).toBe(0);
    expect(daysUntilCloseTarget(plusDays(TODAY, 14), NOW)).toBe(14);
    expect(daysUntilCloseTarget(plusDays(TODAY, -7), NOW)).toBe(-7);
  });

  it("accepts a Date target by its UTC calendar day", () => {
    expect(daysUntilCloseTarget(new Date("2026-06-15T00:00:00.000Z"), NOW)).toBe(14);
  });

  it("anchors 'today' to the America/Chicago calendar day, not UTC", () => {
    // 04:30Z on 2026-06-01 is 23:30 the PREVIOUS day in CDT (2026-05-31).
    const lateNightCt = new Date("2026-06-01T04:30:00.000Z");
    expect(daysUntilCloseTarget("2026-05-31", lateNightCt)).toBe(0);
    expect(daysUntilCloseTarget("2026-06-01", lateNightCt)).toBe(1);
  });
});

describe("isAtRiskSuppressedByCloseTarget", () => {
  it("suppresses for any today-or-future close target", () => {
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: TODAY, now: NOW })).toBe(true);
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: plusDays(TODAY, 1), now: NOW })).toBe(true);
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: plusDays(TODAY, 45), now: NOW })).toBe(true);
    // no upper bound: a far-future target still suppresses at-risk. (It is ALSO effectively on hold past
    // the 90-day horizon — see isDealEffectivelyOnHold — but that is a separate, value/badge concern.)
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: plusDays(TODAY, 200), now: NOW })).toBe(true);
  });

  it("does not suppress once the target passes (becomes at risk again)", () => {
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: plusDays(TODAY, -1), now: NOW })).toBe(false);
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: plusDays(TODAY, -30), now: NOW })).toBe(false);
  });

  it("does not suppress for a missing or unparseable target", () => {
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: null, now: NOW })).toBe(false);
    expect(isAtRiskSuppressedByCloseTarget({ expectedCloseDate: "not-a-date", now: NOW })).toBe(false);
  });

  // The estimating branch (2026-07-28). SUPERSEDES the #966 scoping note that the bid due date
  // "deliberately does NOT feed the shorter close-target SLA suppression": in the genuine estimating
  // stage the suppression is now measured from the SAME horizon date the auto-park uses, so a bid that
  // is already due stops being quieted by a comfortable project close date.
  it("measures suppression from the BID due date in the estimating stage", () => {
    // Bid already due, close target still comfortably ahead -> NOT suppressed (was suppressed pre-change).
    expect(
      isAtRiskSuppressedByCloseTarget({
        expectedCloseDate: plusDays(TODAY, 120),
        bidDueDate: plusDays(TODAY, -30),
        isEstimating: true,
        now: NOW,
      })
    ).toBe(false);

    // Bid not due yet, close target already past -> suppressed (was NOT suppressed pre-change).
    expect(
      isAtRiskSuppressedByCloseTarget({
        expectedCloseDate: plusDays(TODAY, -30),
        bidDueDate: plusDays(TODAY, 10),
        isEstimating: true,
        now: NOW,
      })
    ).toBe(true);
  });

  it("suppresses on the bid due date itself (today-or-future, same >= boundary)", () => {
    expect(
      isAtRiskSuppressedByCloseTarget({
        expectedCloseDate: plusDays(TODAY, -30),
        bidDueDate: TODAY,
        isEstimating: true,
        now: NOW,
      })
    ).toBe(true);
    expect(
      isAtRiskSuppressedByCloseTarget({
        expectedCloseDate: plusDays(TODAY, 120),
        bidDueDate: plusDays(TODAY, -1),
        isEstimating: true,
        now: NOW,
      })
    ).toBe(false);
  });

  it("falls back to the close target when the bid due date is null or unparseable", () => {
    // Same conservative fallback the auto-park uses: a null bid date reproduces today's behaviour exactly.
    expect(
      isAtRiskSuppressedByCloseTarget({
        expectedCloseDate: plusDays(TODAY, 10),
        bidDueDate: null,
        isEstimating: true,
        now: NOW,
      })
    ).toBe(true);
    expect(
      isAtRiskSuppressedByCloseTarget({
        expectedCloseDate: plusDays(TODAY, -10),
        bidDueDate: "not-a-date",
        isEstimating: true,
        now: NOW,
      })
    ).toBe(false);
  });

  it("IGNORES the bid due date outside the estimating stage", () => {
    // Every other stage stays on the project close date, whatever the bid date says.
    expect(
      isAtRiskSuppressedByCloseTarget({
        expectedCloseDate: plusDays(TODAY, 10),
        bidDueDate: plusDays(TODAY, -30),
        now: NOW,
      })
    ).toBe(true);
    expect(
      isAtRiskSuppressedByCloseTarget({
        expectedCloseDate: plusDays(TODAY, -10),
        bidDueDate: plusDays(TODAY, 30),
        isEstimating: false,
        now: NOW,
      })
    ).toBe(false);
  });

  it("reads a Date bid due date on its UTC calendar day (matches the SQL AT TIME ZONE 'UTC')", () => {
    // bid_due_date is a timestamptz stamped at UTC midnight; a bare local read would shift the day west
    // of UTC and flip the verdict.
    expect(
      isAtRiskSuppressedByCloseTarget({
        expectedCloseDate: plusDays(TODAY, 120),
        bidDueDate: new Date(`${plusDays(TODAY, -1)}T00:00:00.000Z`),
        isEstimating: true,
        now: NOW,
      })
    ).toBe(false);
    expect(
      isAtRiskSuppressedByCloseTarget({
        expectedCloseDate: plusDays(TODAY, -120),
        bidDueDate: new Date(`${TODAY}T00:00:00.000Z`),
        isEstimating: true,
        now: NOW,
      })
    ).toBe(true);
  });
});

describe("isDealEffectivelyOnHold", () => {
  it("is true when the deal is explicitly on hold (regardless of close date)", () => {
    expect(isDealEffectivelyOnHold({ onHold: true, expectedCloseDate: null, now: NOW })).toBe(true);
    expect(isDealEffectivelyOnHold({ onHold: true, expectedCloseDate: plusDays(TODAY, -30), now: NOW })).toBe(true);
  });

  it("is true when the close target is PAST the 90-day horizon (auto-park)", () => {
    expect(CLOSE_TARGET_HOLD_HORIZON_DAYS).toBe(90);
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, 91), now: NOW })).toBe(true);
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, 200), now: NOW })).toBe(true);
  });

  it("is FALSE exactly at the 90-day boundary (strictly greater-than, mirroring the SQL '> + INTERVAL 90 days')", () => {
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, 90), now: NOW })).toBe(false);
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, 89), now: NOW })).toBe(false);
  });

  it("is false for a near-term, past, null, or unparseable target when not explicitly held", () => {
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, 30), now: NOW })).toBe(false);
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, -10), now: NOW })).toBe(false);
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: null, now: NOW })).toBe(false);
    expect(isDealEffectivelyOnHold({ onHold: null, expectedCloseDate: "not-a-date", now: NOW })).toBe(false);
  });

  it("in ESTIMATING the horizon is the BID due date, not the close target", () => {
    // The whole point of the 2026-07-27 rule: estimating work has to stay near-term, and its bid deadline
    // is usually much sooner than the project close target.
    //
    // near close / FAR bid -> now HELD (this is the direction that removes dollars from reported pipeline)
    expect(
      isDealEffectivelyOnHold({
        onHold: false,
        expectedCloseDate: plusDays(TODAY, 30),
        bidDueDate: plusDays(TODAY, 200),
        isEstimating: true,
        now: NOW,
      })
    ).toBe(true);
    // FAR close / near bid -> now RELEASED (the direction Adnaan asked for: a live bid is not parked)
    expect(
      isDealEffectivelyOnHold({
        onHold: false,
        expectedCloseDate: plusDays(TODAY, 200),
        bidDueDate: plusDays(TODAY, 30),
        isEstimating: true,
        now: NOW,
      })
    ).toBe(false);
    // Same two rows OUTSIDE estimating keep today's close-target rule byte-for-byte.
    expect(
      isDealEffectivelyOnHold({
        onHold: false,
        expectedCloseDate: plusDays(TODAY, 30),
        bidDueDate: plusDays(TODAY, 200),
        now: NOW,
      })
    ).toBe(false);
    expect(
      isDealEffectivelyOnHold({
        onHold: false,
        expectedCloseDate: plusDays(TODAY, 200),
        bidDueDate: plusDays(TODAY, 30),
        now: NOW,
      })
    ).toBe(true);
  });

  it("falls back to the close target when an estimating deal has no bid due date", () => {
    // The NULL policy. bid_due_date is null on ~91% of deals; "no bid due date => never park" would
    // release far-out estimating deals ($4.39M of them on prod) back into reported pipeline. The fallback
    // reproduces today's behaviour exactly for a null-bid row.
    for (const bidDueDate of [null, undefined, "not-a-date"]) {
      expect(
        isDealEffectivelyOnHold({
          onHold: false,
          expectedCloseDate: plusDays(TODAY, 200),
          bidDueDate,
          isEstimating: true,
          now: NOW,
        })
      ).toBe(true);
      expect(
        isDealEffectivelyOnHold({
          onHold: false,
          expectedCloseDate: plusDays(TODAY, 30),
          bidDueDate,
          isEstimating: true,
          now: NOW,
        })
      ).toBe(false);
    }
  });

  it("applies the strict 90-day boundary to the bid due date too, resolved as a UTC calendar day", () => {
    // Mirrors the SQL's `(bid_due_date AT TIME ZONE 'UTC')::date > CT_today + INTERVAL '90 days'`:
    // strictly greater-than, and the timestamp's UTC day (bid_due_date is stored at UTC midnight).
    const boundary = plusDays(TODAY, 90);
    const pastBoundary = plusDays(TODAY, 91);
    expect(
      isDealEffectivelyOnHold({
        onHold: false,
        expectedCloseDate: null,
        bidDueDate: `${boundary}T00:00:00.000Z`,
        isEstimating: true,
        now: NOW,
      })
    ).toBe(false);
    expect(
      isDealEffectivelyOnHold({
        onHold: false,
        expectedCloseDate: null,
        bidDueDate: new Date(`${pastBoundary}T00:00:00.000Z`),
        isEstimating: true,
        now: NOW,
      })
    ).toBe(true);
  });

  it("a TERMINAL deal is never auto-parked by a far-out BID due date either", () => {
    // A Bid Board-owned deal can be won/lost in its mirror while its CRM stage still reads estimating.
    // Its value is realized, so the estimating horizon must sit INSIDE the terminal exemption, not beside
    // it — otherwise a BB-won estimating deal would lose its realized revenue.
    expect(
      isDealEffectivelyOnHold({
        onHold: false,
        expectedCloseDate: plusDays(TODAY, 30),
        bidDueDate: plusDays(TODAY, 200),
        isEstimating: true,
        isTerminal: true,
        now: NOW,
      })
    ).toBe(false);
  });

  it("a TERMINAL (won/lost) deal is NOT auto-parked by a far-out target, but its stored flag still holds", () => {
    // early-won or stale-lost deal with a far-future forecast date -> NOT held (value realized/preserved).
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, 200), now: NOW, isTerminal: true })).toBe(false);
    // an explicitly held terminal deal is still held (stored flag wins over the terminal exemption)
    expect(isDealEffectivelyOnHold({ onHold: true, expectedCloseDate: plusDays(TODAY, 200), now: NOW, isTerminal: true })).toBe(true);
    // the same far-out target on an OPEN deal IS auto-held (contrast)
    expect(isDealEffectivelyOnHold({ onHold: false, expectedCloseDate: plusDays(TODAY, 200), now: NOW, isTerminal: false })).toBe(true);
  });
});
