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
  weeklyReportRetryNeedsDuplicateRiskAck,
  weeklyReportSendErrorIsProvableRejection,
  WEEKLY_REPORT_SEND_OUTCOME_REJECTED,
  WEEKLY_REPORT_SEND_OUTCOME_UNKNOWN,
} from "./weeklyReportEmail.js";

/** The two shapes the worker actually persists, built the way `weeklyReportSendFailureMessage` builds them. */
const REJECTED_ERROR =
  `${WEEKLY_REPORT_SEND_OUTCOME_REJECTED}: the email provider refused the message and sent nothing — ` +
  "validation_error (422): Invalid `to` field";
const UNKNOWN_ERROR =
  `${WEEKLY_REPORT_SEND_OUTCOME_UNKNOWN}: the email provider never confirmed the message, so it may or ` +
  "may not have gone out — application_error: fetch failed";

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

// The age of the send is only HALF the question, and on its own it asks the wrong PM to think twice.
//
// `weeklyReportRetryIsProviderDeduped` answers "would the provider still swallow a replay of this key".
// What the retry gate actually needs to know is "can a replay put a second copy in the client's inbox",
// and those come apart in the case a PM meets most often: the provider REFUSED the message and said why.
// `send_error` is the record of that refusal, so nothing was delivered and there is nothing to duplicate —
// yet the age gate warned anyway, which talks a PM out of the one retry that is unambiguously correct.
//
// The other direction is the trap, and it is why this predicate is not simply `send_delivered_at IS NULL`.
// `send_delivered_at` is stamped by a SEPARATE statement after the provider call returns
// (worker/src/jobs/weekly-report-send.ts), so a process that dies in between leaves a report the client
// HAS with no stamp and no error — dashboard-service.ts calls that "an ordinary outcome for this worker
// ... the reason the whole idempotency-key design exists". A silent record is therefore not evidence of
// failure, and past the window such a retry sends a real second copy. Absence is not proof here either.
describe("weeklyReportRetryNeedsDuplicateRiskAck", () => {
  it("does not ask when the provider recorded why it refused, however old the send", () => {
    // The whole point. An old send with a recorded error is the "Send failed" chip, and retrying it is
    // exactly what the PM should do — being asked to confirm a duplicate that cannot exist is what made
    // people reach for Send correction instead, which creates a v2 and takes the failure off the board.
    expect(
      weeklyReportRetryNeedsDuplicateRiskAck({ sentAt: SENT_AT, sendError: REJECTED_ERROR }, OUTSIDE),
    ).toBe(false);
  });

  it("STILL asks when the record is silent and the window has closed", () => {
    // The case the old predicate got right and a `send_delivered_at IS NULL` rewrite would get wrong.
    // No error recorded does not mean no email sent: the provider may have accepted it and the process
    // died before the stamp. Past the window a replay is a genuine second email, so it stays a deliberate
    // act. This is the guard that must not be relaxed.
    expect(weeklyReportRetryNeedsDuplicateRiskAck({ sentAt: SENT_AT, sendError: null }, OUTSIDE)).toBe(true);
  });

  it("does not ask inside the provider's window, error or not", () => {
    // Inside the window the key still dedupes, so a replay is a no-op whatever the record says.
    expect(weeklyReportRetryNeedsDuplicateRiskAck({ sentAt: SENT_AT, sendError: null }, INSIDE)).toBe(false);
    expect(
      weeklyReportRetryNeedsDuplicateRiskAck({ sentAt: SENT_AT, sendError: REJECTED_ERROR }, INSIDE),
    ).toBe(false);
  });

  it("flips exactly at the boundary when the record is silent", () => {
    // The same boundary the deduped predicate is pinned on, re-asserted THROUGH this function so a
    // rewrite that stops consulting the window at all cannot stay green.
    expect(
      weeklyReportRetryNeedsDuplicateRiskAck({ sentAt: SENT_AT, sendError: null }, JUST_INSIDE),
    ).toBe(false);
    expect(
      weeklyReportRetryNeedsDuplicateRiskAck({ sentAt: SENT_AT, sendError: null }, JUST_OUTSIDE),
    ).toBe(true);
  });

  it("treats a blank error as no evidence of refusal", () => {
    // Fail safe, and not hypothetical: `send_error` is cleared to NULL on every retry
    // (send-service.ts), so "empty" is a state this column really reaches. An empty string says nothing
    // about what the provider did, so it must not buy the PM out of the confirmation.
    expect(weeklyReportRetryNeedsDuplicateRiskAck({ sentAt: SENT_AT, sendError: "" }, OUTSIDE)).toBe(true);
    expect(weeklyReportRetryNeedsDuplicateRiskAck({ sentAt: SENT_AT, sendError: "   " }, OUTSIDE)).toBe(
      true,
    );
  });

  it("asks when the send has no usable stamp and nothing was recorded", () => {
    // Unknown age, unknown outcome. The conservative answer is the confirmation.
    expect(weeklyReportRetryNeedsDuplicateRiskAck({ sentAt: null, sendError: null }, OUTSIDE)).toBe(true);
    expect(
      weeklyReportRetryNeedsDuplicateRiskAck({ sentAt: "not a date", sendError: null }, OUTSIDE),
    ).toBe(true);
  });

  it("does not ask when the send has no usable stamp but the provider recorded a refusal", () => {
    // Evidence of refusal settles it without needing to know how old the send is.
    expect(
      weeklyReportRetryNeedsDuplicateRiskAck({ sentAt: null, sendError: REJECTED_ERROR }, OUTSIDE),
    ).toBe(false);
  });

  it("STILL asks on an `unknown:` error, which is not evidence of anything", () => {
    // THE CASE THAT MAKES "an error was recorded" THE WRONG QUESTION. `classifySendFailure` writes
    // `unknown` for a swallowed fetch, a 5xx, a 408, and a 409 `concurrent_idempotent_requests` — every
    // one of which is a request that may well have reached a server that enqueued it. The row has a
    // non-blank `send_error` and the client may still have the report.
    //
    // Treating any non-blank error as a refusal is exactly the mistake this whole change exists to
    // correct, made one layer further in.
    expect(
      weeklyReportRetryNeedsDuplicateRiskAck({ sentAt: SENT_AT, sendError: UNKNOWN_ERROR }, OUTSIDE),
    ).toBe(true);
    expect(
      weeklyReportRetryNeedsDuplicateRiskAck({ sentAt: null, sendError: UNKNOWN_ERROR }, OUTSIDE),
    ).toBe(true);
  });

  it("STILL asks on a legacy error written before the outcome prefix existed", () => {
    // Rows already in production carry the old single-constant text. They cannot be classified, so they
    // are ambiguous, so they keep the confirmation — the direction that costs a click rather than a
    // client's second copy.
    expect(
      weeklyReportRetryNeedsDuplicateRiskAck({ sentAt: SENT_AT, sendError: "Resend timed out" }, OUTSIDE),
    ).toBe(true);
  });
});

// The prefix is a CONTRACT between the worker that writes `send_error` and everything that reads it, which
// is why both halves of it are named here rather than spelled out at each end. `weeklyReportSendFailureMessage`
// builds the string from these constants; this predicate takes it apart again.
describe("weeklyReportSendErrorIsProvableRejection", () => {
  it("recognises the rejected prefix the worker writes", () => {
    expect(weeklyReportSendErrorIsProvableRejection(REJECTED_ERROR)).toBe(true);
  });

  it("refuses the unknown prefix", () => {
    expect(weeklyReportSendErrorIsProvableRejection(UNKNOWN_ERROR)).toBe(false);
  });

  it("refuses anything it cannot positively place", () => {
    // Legacy text, blank, absent, and a string that merely CONTAINS the word somewhere — a substring
    // match would call "unknown: ... the address was rejected by the server" a provable rejection.
    expect(weeklyReportSendErrorIsProvableRejection("Resend timed out")).toBe(false);
    expect(weeklyReportSendErrorIsProvableRejection("")).toBe(false);
    expect(weeklyReportSendErrorIsProvableRejection(null)).toBe(false);
    expect(weeklyReportSendErrorIsProvableRejection(undefined)).toBe(false);
    expect(
      weeklyReportSendErrorIsProvableRejection("unknown: the recipient rejected: it was refused"),
    ).toBe(false);
  });

  it("tolerates leading whitespace and casing, since it parses a stored string", () => {
    expect(weeklyReportSendErrorIsProvableRejection("  rejected: refused")).toBe(true);
    expect(weeklyReportSendErrorIsProvableRejection("REJECTED: refused")).toBe(true);
  });

  it("requires the colon, so a longer word starting with the prefix is not a match", () => {
    expect(weeklyReportSendErrorIsProvableRejection("rejectedish: something else")).toBe(false);
  });
});
