import { describe, expect, it } from "vitest";
import {
  WEEKLY_REPORT_SEND_OUTCOME_REJECTED,
  WEEKLY_REPORT_SEND_OUTCOME_UNKNOWN,
  weeklyReportSendErrorIsProvableRejection,
} from "@trock-crm/shared/lib/weeklyReportEmail";
import { weeklyReportSendFailureMessage } from "../../src/jobs/weekly-report-send.js";

// THE PRODUCER HALF OF THE `send_error` CONTRACT, which had no test at all.
//
// `classifySendFailure` is covered in tests/lib/system-email.test.ts — it decides `rejected` vs `unknown`.
// What was never covered is the step that turns that verdict into the STRING stored in `send_error`, and
// that string is what the retry dialog reads back to decide whether it can tell a PM an attempt sent
// nothing (`weeklyReportSendErrorIsProvableRejection`).
//
// The gap mattered because it fails SAFE and therefore silently. Drop the prefix — reformat the sentence,
// reorder the parts, translate it — and every consumer classifies every failure as ambiguous. Nothing
// throws, no suite goes red, the dashboard is unchanged; the dialog simply stops ever reassuring anybody,
// on the one surface built to be quoted to a client. A regression with no symptom is the kind this
// feature has shipped before.
//
// So these assert the ROUND TRIP rather than the literal text: whatever the producer writes, the consumer
// must classify it the way the outcome says. That survives rewording, and fails on the change that
// actually breaks the feature.

/** The two shapes `sendSystemEmailWithMetadata` returns for a failure. */
const rejected = { success: false as const, outcome: "rejected" as const, reason: "validation_error (422): Invalid `to` field" };
const unknown = { success: false as const, outcome: "unknown" as const, reason: "application_error: fetch failed" };

describe("weeklyReportSendFailureMessage", () => {
  it("writes a message the consumer reads back as a PROVABLE REJECTION", () => {
    const stored = weeklyReportSendFailureMessage(rejected);
    expect(weeklyReportSendErrorIsProvableRejection(stored)).toBe(true);
  });

  it("writes a message the consumer reads back as AMBIGUOUS on an unknown outcome", () => {
    // The control, and the one that matters most: `unknown` covers a swallowed fetch, a 5xx, a 408 and an
    // in-flight idempotency 409 — every one of which may have left the message enqueued. Classifying one
    // of those as a provable rejection is how a PM gets told an attempt sent nothing when it may not have.
    const stored = weeklyReportSendFailureMessage(unknown);
    expect(weeklyReportSendErrorIsProvableRejection(stored)).toBe(false);
  });

  it("defaults to ambiguous when the outcome field is absent", () => {
    // A stub, an older build, or a transport that never set it. Being wrong this way costs a confirmation
    // the PM did not strictly need; the other way costs a duplicate client email.
    expect(
      weeklyReportSendErrorIsProvableRejection(
        weeklyReportSendFailureMessage({ success: false, reason: "something went wrong" } as never),
      ),
    ).toBe(false);
  });

  it("leads with the outcome word itself, which is what the consumer anchors on", () => {
    // One assertion on the literal shape, because the round-trip tests above would both still pass if the
    // producer and the consumer agreed on some OTHER encoding — and `send_error` is also read by humans,
    // in a tooltip on the board, where the first word is the whole diagnosis.
    expect(weeklyReportSendFailureMessage(rejected).startsWith(`${WEEKLY_REPORT_SEND_OUTCOME_REJECTED}:`)).toBe(true);
    expect(weeklyReportSendFailureMessage(unknown).startsWith(`${WEEKLY_REPORT_SEND_OUTCOME_UNKNOWN}:`)).toBe(true);
  });

  it("carries the provider's own words through, which is the actionable half", () => {
    // The reason this stopped being a single constant: three different fixes — correct the address, wait,
    // set an env var — used to sit behind one indistinguishable string.
    expect(weeklyReportSendFailureMessage(rejected)).toContain("Invalid `to` field");
    expect(weeklyReportSendFailureMessage(unknown)).toContain("fetch failed");
  });

  it("still classifies correctly when the provider gave no reason at all", () => {
    // `reason` is optional; a message that degrades to just the prefix must still be readable by the
    // consumer, or a failure with no detail would quietly become ambiguous.
    const stored = weeklyReportSendFailureMessage({ success: false, outcome: "rejected" } as never);
    expect(weeklyReportSendErrorIsProvableRejection(stored)).toBe(true);
  });
});
