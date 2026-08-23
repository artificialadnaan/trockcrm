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
  weeklyReportRetryDuplicateRiskPrompt,
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

// WHAT THE DIALOG SAYS — and, by its absence here, what it no longer decides.
//
// An earlier revision of this change made the GATE outcome-aware: a provable rejection skipped the
// confirmation entirely. Three rounds of review produced three counterexamples of the same shape, ending
// with one that no column can rule out — the provider accepts, the delivery-stamp write dies, and NOTHING
// is recorded. `send_error` holds only the latest attempt and a retry clears it while keeping
// `send_attempts`, so "this send definitely never reached anyone" is not a statement these columns can
// support. The gate went back to age alone and the fix moved into the wording, which is where the actual
// complaint was: a PM was told flatly that a retry might double-send, with nothing conceding that the
// attempt in front of them demonstrably sent nothing.
describe("weeklyReportRetryDuplicateRiskPrompt", () => {
  it("says a recorded attempt sent nothing when the provider provably refused it", () => {
    const prompt = weeklyReportRetryDuplicateRiskPrompt(REJECTED_ERROR);
    expect(prompt).toMatch(/was refused, so that attempt sent nothing/i);
  });

  it("does NOT claim the client received nothing — only that THAT attempt sent nothing", () => {
    // The line between what is known and what is being guessed. An earlier attempt may have delivered,
    // and this sentence is the one that stops the dialog overstating the evidence.
    const prompt = weeklyReportRetryDuplicateRiskPrompt(REJECTED_ERROR);
    expect(prompt).toMatch(/outcome of any other attempt is unknown/i);
    expect(prompt).toMatch(/second copy/i);
  });

  it("says nothing about a refusal on an `unknown:` error", () => {
    // The control. A prompt that mentioned the refusal unconditionally would pass the first test above.
    const prompt = weeklyReportRetryDuplicateRiskPrompt(UNKNOWN_ERROR);
    expect(prompt).not.toMatch(/sent nothing/i);
    expect(prompt).toMatch(/second copy/i);
  });

  it("says nothing about a refusal on a silent or legacy record", () => {
    for (const sendError of [null, undefined, "", "   ", "Resend timed out"]) {
      const prompt = weeklyReportRetryDuplicateRiskPrompt(sendError);
      expect(prompt).not.toMatch(/sent nothing/i);
      expect(prompt).toMatch(/second copy/i);
    }
  });

  it("does not name the mail provider as the refuser, because it may not have been", () => {
    // `rejected:` is also written when the deployment guard stops a send BEFORE the provider is called
    // (`WeeklyReportSendRefusedBeforeSending`). On those rows the platform is at its most certain that
    // nothing went out — and "refused by the mail provider" would be flatly false about who did it.
    const prompt = weeklyReportRetryDuplicateRiskPrompt(REJECTED_ERROR);
    expect(prompt).not.toMatch(/refused by the mail provider/i);
    expect(prompt).toMatch(/was refused, so that attempt sent nothing/i);
  });

  it("calls the other attempts UNKNOWN rather than unaccounted for", () => {
    // A row with `send_attempts` of 3 has accounted for three attempts. What it has not kept is what
    // became of two of them, since `send_error` holds one outcome — so "no other attempt is accounted
    // for" reads as a contradiction of the count the same screen shows.
    const prompt = weeklyReportRetryDuplicateRiskPrompt(REJECTED_ERROR);
    expect(prompt).toMatch(/outcome of any other attempt is unknown/i);
    expect(prompt).not.toMatch(/accounted for/i);
  });

  it("never calls the rejection the LATEST attempt, because the column cannot say that", () => {
    // `send_error` is cleared only by the statement that also stamps the delivery, so a rejected attempt
    // followed by a successful one whose stamp write dies leaves `rejected:` on a row the client HAS.
    // Saying "the last attempt" there would be false in exactly the state that matters and would talk a
    // PM into the duplicate this dialog exists to prevent.
    //
    // Asserted as an ABSENCE of the recency words rather than a presence of the current phrasing: a
    // reworded prompt is free to change, but it must not reacquire the claim.
    const prompt = weeklyReportRetryDuplicateRiskPrompt(REJECTED_ERROR);
    expect(prompt).not.toMatch(/\b(last|latest|most recent) attempt\b/i);
    expect(prompt).toMatch(/outcome of any other attempt is unknown/i);
  });

  it("does not then ask about \"the first email\", which contradicts the sentence before it", () => {
    // Coherence, not vocabulary. The default closing asks what happened to "the first email", which is
    // the right phrase when nothing is known — and a contradiction directly after telling the PM that a
    // recorded attempt sent nothing. The rejected branch names the unaccounted-for attempts instead.
    //
    // This was found by PRINTING the finished string and reading it. Every assertion in this file passed
    // while the two halves disagreed, because each checked its own clause and none read the whole.
    const prompt = weeklyReportRetryDuplicateRiskPrompt(REJECTED_ERROR);
    expect(prompt).not.toMatch(/the first email/i);
    expect(prompt).toMatch(/outcome of any other attempt is unknown/i);
    // The default branch keeps it — there, nothing has been claimed about any attempt.
    expect(weeklyReportRetryDuplicateRiskPrompt(UNKNOWN_ERROR)).toMatch(/the first email/i);
  });

  it("says AT LEAST 24 hours, matching the gate's boundary rather than overshooting it", () => {
    // `weeklyReportRetryIsProviderDeduped` is `elapsed < 24`, so at exactly 24 hours the dialog fires —
    // and "more than 24 hours old" is false in that instant. A small thing, and precisely the kind this
    // change exists to stop: the copy must not claim more than the predicate behind it supports.
    for (const sendError of [REJECTED_ERROR, UNKNOWN_ERROR, null]) {
      const prompt = weeklyReportRetryDuplicateRiskPrompt(sendError);
      expect(prompt).toMatch(
        new RegExp(`at least ${WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS} hours old`),
      );
      expect(prompt).not.toMatch(/more than \d+ hours old/);
    }
  });

  it("always carries the duplicate warning, whatever the outcome was", () => {
    // The property that must hold across every branch: this dialog exists to warn, and no outcome
    // removes the warning any more. If a future edit reintroduces a silent path, this fails.
    for (const sendError of [REJECTED_ERROR, UNKNOWN_ERROR, null, "Resend timed out"]) {
      expect(weeklyReportRetryDuplicateRiskPrompt(sendError)).toMatch(
        new RegExp(`${WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS} hours old`),
      );
    }
  });
});
