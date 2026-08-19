import { describe, expect, it } from "vitest";
import {
  WEEKLY_REPORT_SEND_STALL_MINUTES,
  weeklyReportLastSendActivityAt,
  weeklyReportSendHasStalled,
} from "./weeklyReportSendStall.js";

/**
 * ABSOLUTE FIXTURES, DELIBERATELY.
 *
 * Every timestamp below is written out in full rather than computed from
 * WEEKLY_REPORT_SEND_STALL_MINUTES. A fixture derived from the constant it is testing — the
 * `ageSend(THRESHOLD + 5)` shape — cannot fail: change the constant to 30,000 and the fixture moves with
 * it, the assertion still passes, and the CRM board and the worker sweep both go quiet for three weeks
 * before anyone notices. That defect has already shipped in this feature more than once.
 *
 * These pin the threshold to the interval (29 min, 31 min): 17:29:00 is stalled at 18:00, 17:31:00 is not.
 * Any change to the constant outside that interval turns one of them red.
 */
const NOW = new Date("2026-08-18T18:00:00.000Z");

describe("WEEKLY_REPORT_SEND_STALL_MINUTES", () => {
  it("is 30 minutes", () => {
    // A direct pin, so a change to the number is a change somebody had to make on purpose. The board's
    // chip, the sweep's alert and the wording of both are all written around half an hour.
    expect(WEEKLY_REPORT_SEND_STALL_MINUTES).toBe(30);
  });
});

describe("weeklyReportLastSendActivityAt", () => {
  it("takes the LATER stamp, so a retry moves the clock the commit cannot", () => {
    // `sent_at` is stamped once when the PM commits and never moves. Reading it alone is what made every
    // legitimate retry read as "Send stuck".
    expect(
      weeklyReportLastSendActivityAt({
        sent_at: new Date("2026-08-18T16:00:00.000Z"),
        send_last_attempt_at: new Date("2026-08-18T17:59:00.000Z"),
      })?.toISOString(),
    ).toBe("2026-08-18T17:59:00.000Z");
  });

  it("falls back to the commit when no attempt was ever recorded", () => {
    // THE CASE THE WHOLE MECHANISM EXISTS FOR: the delivery job dead-lettered having written nothing at
    // all, so `send_last_attempt_at` is null and `sent_at` is the only evidence there is. A helper reading
    // the attempt column alone would age nothing here and the report would be lost silently.
    expect(
      weeklyReportLastSendActivityAt({ sent_at: new Date("2026-08-18T17:00:00.000Z") })?.toISOString(),
    ).toBe("2026-08-18T17:00:00.000Z");
  });

  it("accepts the string a driver may hand back instead of a Date", () => {
    expect(weeklyReportLastSendActivityAt({ sent_at: "2026-08-18T17:00:00.000Z" })?.toISOString()).toBe(
      "2026-08-18T17:00:00.000Z",
    );
  });

  it("is null when there is nothing to age, rather than guessing", () => {
    expect(weeklyReportLastSendActivityAt({})).toBeNull();
    expect(weeklyReportLastSendActivityAt({ sent_at: null, send_last_attempt_at: null })).toBeNull();
    expect(weeklyReportLastSendActivityAt({ sent_at: "not a date" })).toBeNull();
  });
});

describe("weeklyReportSendHasStalled", () => {
  it("is TRUE 31 minutes after the last activity", () => {
    expect(weeklyReportSendHasStalled({ sent_at: new Date("2026-08-18T17:29:00.000Z") }, NOW)).toBe(true);
  });

  it("is FALSE 29 minutes after the last activity", () => {
    // The control. A guard that refuses everything passes its own suite; this is what proves the predicate
    // still lets an in-flight send alone.
    expect(weeklyReportSendHasStalled({ sent_at: new Date("2026-08-18T17:31:00.000Z") }, NOW)).toBe(false);
  });

  it("is FALSE exactly on the threshold — strictly LONGER than the window", () => {
    expect(weeklyReportSendHasStalled({ sent_at: new Date("2026-08-18T17:30:00.000Z") }, NOW)).toBe(false);
    expect(weeklyReportSendHasStalled({ sent_at: new Date("2026-08-18T17:29:59.999Z") }, NOW)).toBe(true);
  });

  it("ages against the RETRY, not the commit", () => {
    // The precise bug migration 0226 was written to fix. Committed two hours ago, retried one minute ago:
    // ageing on `sent_at` calls this stuck and tells a director to chase a delivery that is in flight right
    // now — and past the provider's dedupe window that chase puts a second copy in the client's inbox.
    const retriedJustNow = {
      sent_at: new Date("2026-08-18T16:00:00.000Z"),
      send_last_attempt_at: new Date("2026-08-18T17:59:00.000Z"),
    };
    expect(weeklyReportSendHasStalled(retriedJustNow, NOW)).toBe(false);

    // ...and the control, which is what stops the line above being satisfied by a predicate that says
    // "false" to everything with a `send_last_attempt_at`: the same commit, retried an hour ago and silent
    // since, IS stalled.
    const retriedAnHourAgo = {
      sent_at: new Date("2026-08-18T16:00:00.000Z"),
      send_last_attempt_at: new Date("2026-08-18T17:00:00.000Z"),
    };
    expect(weeklyReportSendHasStalled(retriedAnHourAgo, NOW)).toBe(true);
  });

  it("leaves a row with no timestamps alone rather than inventing a failure", () => {
    expect(weeklyReportSendHasStalled({}, NOW)).toBe(false);
  });
});
