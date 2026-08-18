// The provider idempotency window, pinned with absolute dates.
//
// This file exists because the window had NO test that could fail. The server suite aged its fixtures as
// `(WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS ± 1) * 60`, so the fixture moved with the constant;
// the CRM suite's hard-coded `sentAt: "2026-08-01T10:00:00.000Z"` was cited as the real pin, but it sits
// ~424 h in the past and therefore only ever caught values above ~424 — a bound that grows by 24 every
// real day. Changing 24 to 100, or to 400, left every suite in the repo green.
//
// What that mutation switches off is the reason the constant exists. `retryWeeklyReportSend` demands an
// explicit `acknowledgeDuplicateRisk` only once the window has closed, and the board and History only warn
// while it is open. Widen it and a PM retrying a week-old failed send is asked nothing, the provider has
// long forgotten the key, and the "no-op" replay puts a SECOND COPY of the report in a client's inbox —
// the one outcome this feature must never produce by accident.
//
// Absolute `sentAt` AND absolute `now` on both sides, so the assertions do not drift with the clock and do
// not follow the value under test. The literal 24 is asserted directly: if the product re-chooses the
// window, this file is supposed to break and be re-picked deliberately.

import { describe, expect, it } from "vitest";
import {
  WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS,
  weeklyReportRetryIsProviderDeduped,
} from "./weeklyReportEmail.js";

const SENT_AT = "2026-08-01T10:00:00.000Z";
/** 23 h after SENT_AT — inside the window. */
const INSIDE = new Date("2026-08-02T09:00:00.000Z");
/** 25 h after SENT_AT — outside it. */
const OUTSIDE = new Date("2026-08-02T11:00:00.000Z");
/** One minute either side of the boundary itself. */
const JUST_INSIDE = new Date("2026-08-02T09:59:00.000Z");
const JUST_OUTSIDE = new Date("2026-08-02T10:01:00.000Z");

describe("WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS", () => {
  it("is 24 hours, the lifetime Resend documents for an idempotency key", () => {
    // Asserted as a literal on purpose. Every other test here would still pass if the window moved and
    // the fixtures moved with it; this is the one that cannot.
    expect(WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS).toBe(24);
  });
});

describe("weeklyReportRetryIsProviderDeduped", () => {
  it("is deduped 23 hours after the send was committed", () => {
    expect(weeklyReportRetryIsProviderDeduped(SENT_AT, INSIDE)).toBe(true);
  });

  it("is NOT deduped 25 hours after the send was committed", () => {
    // The control for the case above: without it, a predicate that returned false unconditionally would
    // still satisfy every "refuses unacknowledged" test in the server suite.
    expect(weeklyReportRetryIsProviderDeduped(SENT_AT, OUTSIDE)).toBe(false);
  });

  it("flips exactly at the boundary, not near it", () => {
    // A window of 23 or 25 passes both tests above. These two do not.
    expect(weeklyReportRetryIsProviderDeduped(SENT_AT, JUST_INSIDE)).toBe(true);
    expect(weeklyReportRetryIsProviderDeduped(SENT_AT, JUST_OUTSIDE)).toBe(false);
  });

  it("accepts a Date as readily as an ISO string", () => {
    expect(weeklyReportRetryIsProviderDeduped(new Date(SENT_AT), INSIDE)).toBe(true);
    expect(weeklyReportRetryIsProviderDeduped(new Date(SENT_AT), OUTSIDE)).toBe(false);
  });

  it("treats a missing or unparseable stamp as NOT deduped", () => {
    // Fail safe. An unknown send age must demand the acknowledgement rather than skip it — being wrong
    // this way costs a confirmation dialog, being wrong the other way costs a duplicate client email.
    expect(weeklyReportRetryIsProviderDeduped(null, INSIDE)).toBe(false);
    expect(weeklyReportRetryIsProviderDeduped(undefined, INSIDE)).toBe(false);
    expect(weeklyReportRetryIsProviderDeduped("not a date", INSIDE)).toBe(false);
  });

  it("treats a stamp in the future as deduped rather than throwing", () => {
    // Clock skew between the API that stamps sent_at and whoever evaluates this. Elapsed is negative,
    // which is inside the window, and that is the conservative answer: the key was minted moments ago.
    expect(weeklyReportRetryIsProviderDeduped("2026-08-03T10:00:00.000Z", INSIDE)).toBe(true);
  });
});
