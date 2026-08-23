import fs from "fs";
import path from "path";
import * as ts from "typescript";
import {
  WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS,
  WEEKLY_REPORT_SEND_STALL_MINUTES,
  runWeeklyReportCorrection,
  runWeeklyReportRetry,
  weeklyReportCanCorrect,
  weeklyReportCanRetryDelivery,
  weeklyReportDeliveryDetail,
  weeklyReportDeliveryErrorMessage,
  weeklyReportDeliveryLabel,
  weeklyReportDeliveryState,
  weeklyReportRetryIsProviderDeduped,
  weeklyReportRetryNeedsAcknowledgement,
  weeklyReportUndeliveredSummary,
  type WeeklyReportCorrectionPort,
  type WeeklyReportRetryPort,
} from "../delivery";
import type { WeeklyReportDetailView } from "../../api/types";

/**
 * What the PM is told about a client email after they pressed Send, and the two ways back.
 *
 * EVERY TIME FIXTURE BELOW IS ABSOLUTE. Not one of them is computed from the constant it exercises, which
 * is the trap this feature has already walked into once: a `now` written as `sentAt + (WINDOW_HOURS + 1)`
 * moves with the constant and can never fail, so the test goes on passing while the behaviour it was
 * written to pin changes underneath it. If the window or the stall threshold is ever re-chosen, these are
 * SUPPOSED to break and be re-reasoned rather than silently follow.
 *
 * The reference send: committed 2026-08-13 at 20:00 UTC.
 */
const SENT_AT = "2026-08-13T20:00:00.000Z";

/** 11 hours after the send — comfortably inside a 24-hour provider window. */
const NOW_INSIDE_WINDOW = new Date("2026-08-14T07:00:00.000Z");
/** 48 hours after the send — comfortably outside it. */
const NOW_OUTSIDE_WINDOW = new Date("2026-08-15T20:00:00.000Z");

/** 5 minutes after the last activity — a queued job, not a problem. */
const NOW_JUST_SENT = new Date("2026-08-13T20:05:00.000Z");
/** 60 minutes after it — past any plausible delivery. */
const NOW_LONG_AFTER = new Date("2026-08-13T21:00:00.000Z");

const UNDELIVERED = {
  sentAt: SENT_AT,
  sendDeliveredAt: null,
  sendError: null,
  sendAttempts: 0,
  sendLastAttemptAt: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// READING THE FOUR COLUMNS
// ─────────────────────────────────────────────────────────────────────────────

describe("what happened to the client's email", () => {
  it("calls a send the provider accepted DELIVERED — the control", () => {
    // The control that makes every assertion below mean something. A classifier that answered "failed" for
    // everything would satisfy the failure cases on its own, and this is also the case the PM's hub list
    // must never show: a delivered week is finished work.
    expect(
      weeklyReportDeliveryState(
        { ...UNDELIVERED, sendDeliveredAt: "2026-08-13T20:00:30.000Z" },
        NOW_LONG_AFTER,
      ),
    ).toBe("delivered");
  });

  it("calls a recorded error FAILED, however recent the attempt", () => {
    expect(
      weeklyReportDeliveryState(
        { ...UNDELIVERED, sendError: "The recipient address is invalid", sendAttempts: 1 },
        NOW_JUST_SENT,
      ),
    ).toBe("failed");
  });

  it("calls a fresh undelivered send SENDING rather than a fault", () => {
    // A queued job is not a problem, and colouring it as one teaches the PM to ignore the colour.
    expect(weeklyReportDeliveryState(UNDELIVERED, NOW_JUST_SENT)).toBe("sending");
  });

  it("calls a silent undelivered send STUCK once it is older than a delivery plausibly takes", () => {
    // THE CASE WITH NO ERROR MESSAGE, and the dangerous one. The delivery job records its outcome in the
    // same database whose unavailability is the likeliest reason it failed, so a job that dead-letters
    // writes nothing at all: no error, no delivery, zero attempts. Only the clock can tell that row from a
    // send queued five seconds ago, and without this the app would say "Sending…" for ever about a client
    // who is never going to receive anything.
    expect(weeklyReportDeliveryState(UNDELIVERED, NOW_LONG_AFTER)).toBe("stuck");
  });

  it("ages a RETRIED send from the retry, not from the original commit", () => {
    // `sentAt` is stamped once and never moves, so ageing off it alone would make every legitimate retry
    // read as a failure: a send committed at 20:00 and retried at 20:58 is still "an hour old" by that
    // measure. The chip would flip straight from "Send failed" to "Send stuck", the PM would get no
    // acknowledgement that their tap did anything, and past the provider's dedupe window a PM who had just
    // accepted the duplicate risk, saw nothing change and tapped again would put a second real copy in a
    // client's inbox.
    const retried = { ...UNDELIVERED, sendAttempts: 3, sendLastAttemptAt: "2026-08-13T20:58:00.000Z" };
    expect(weeklyReportDeliveryState(retried, NOW_LONG_AFTER)).toBe("sending");
    // …and it goes back to stuck once the RETRY is itself old, which is what stops the stamp hiding a
    // failure for ever.
    expect(weeklyReportDeliveryState(retried, new Date("2026-08-13T22:00:00.000Z"))).toBe("stuck");
  });

  it("leaves a row with no timestamps alone rather than inventing a failure for it", () => {
    // `sent` guarantees `sent_at`; a row without one is corrupt, and a chip nobody can act on is worse
    // than none. Same choice the CRM board makes.
    expect(
      weeklyReportDeliveryState({ ...UNDELIVERED, sentAt: null }, NOW_LONG_AFTER),
    ).toBe("sending");
  });

  it("treats an undelivered row with no `sendDeliveredAt` key at all as undelivered", () => {
    // The hub's list row genuinely omits the field — the server's predicate for that list is
    // `send_delivered_at IS NULL` — so `undefined` has to read the same as null or every row on the PM's
    // most important list would classify as delivered and the section would render as finished work.
    const listRow = { sentAt: SENT_AT, sendError: null, sendAttempts: 0, sendLastAttemptAt: null };
    expect(weeklyReportDeliveryState(listRow, NOW_LONG_AFTER)).toBe("stuck");
  });
});

describe("the words on the chip", () => {
  it("uses the CRM board's vocabulary, so one feature does not speak two ways", () => {
    expect(weeklyReportDeliveryLabel("delivered")).toBe("Delivered");
    expect(weeklyReportDeliveryLabel("failed")).toBe("Send failed");
    expect(weeklyReportDeliveryLabel("stuck")).toBe("Send stuck");
    expect(weeklyReportDeliveryLabel("sending")).toBe("Sending…");
  });

  it("gives the four states four DIFFERENT sentences", () => {
    // An assertion on a label that is identical in both states proves nothing. This pins that the four
    // readings are actually distinguishable to somebody looking at the screen.
    const sentences = new Set(
      (["delivered", "failed", "stuck", "sending"] as const).map((state) =>
        weeklyReportDeliveryDetail({ ...UNDELIVERED, sendError: "Refused" }, state),
      ),
    );
    expect(sentences.size).toBe(4);
  });

  it("shows the provider's own sentence on a failure, which is the actionable part", () => {
    const detail = weeklyReportDeliveryDetail(
      { ...UNDELIVERED, sendError: "The recipient address is invalid", sendAttempts: 2 },
      "failed",
    );
    expect(detail).toContain("The recipient address is invalid");
    expect(detail).toContain("2 attempts");
  });

  it("does not claim a delivered report was READ, which nothing here can evidence", () => {
    // There is no bounce webhook anywhere in this platform, so a report addressed to a mistyped domain is
    // accepted, hard-bounces, and reads as delivered for ever. The copy claims acceptance and no more.
    const detail = weeklyReportDeliveryDetail(UNDELIVERED, "delivered");
    expect(detail).toMatch(/accepted/i);
    expect(detail).not.toMatch(/\breceived\b|\bread it\b/i);
  });

  it("does not tell a PM nothing was recorded when attempts have been made", () => {
    // The state a PM most often reads "Send stuck" in is AFTER a retry cleared the error text. Telling
    // them nothing was ever recorded contradicts the attempt count they were looking at a moment earlier.
    const afterRetries = weeklyReportDeliveryDetail({ ...UNDELIVERED, sendAttempts: 3 }, "stuck");
    expect(afterRetries).toContain("3 attempts");
    expect(afterRetries).not.toMatch(/never (attempted|recorded)|no delivery was ever/i);

    const untouched = weeklyReportDeliveryDetail({ ...UNDELIVERED, sendAttempts: 0 }, "stuck");
    expect(untouched).toMatch(/no delivery was ever/i);
  });
});

describe("the hub row's summary line", () => {
  it("mentions the version only when it is not the first, and attempts only when there were any", () => {
    expect(weeklyReportUndeliveredSummary({ version: 1, sendAttempts: 0 }, "Aug 13")).toBe("Week of Aug 13");
    expect(weeklyReportUndeliveredSummary({ version: 2, sendAttempts: 0 }, "Aug 13")).toBe(
      "Week of Aug 13 · v2",
    );
    expect(weeklyReportUndeliveredSummary({ version: 1, sendAttempts: 1 }, "Aug 13")).toBe(
      "Week of Aug 13 · 1 attempt",
    );
    expect(weeklyReportUndeliveredSummary({ version: 3, sendAttempts: 4 }, "Aug 13")).toBe(
      "Week of Aug 13 · v3 · 4 attempts",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DUPLICATE-RISK ACKNOWLEDGEMENT
// ─────────────────────────────────────────────────────────────────────────────

describe("whether a retry needs the duplicate-risk acknowledgement", () => {
  it("does NOT ask inside the provider's window, where a replay is a no-op", () => {
    // Asking here would be crying wolf, and the cost is not zero: a PM taught to click through this
    // confirmation is a PM who clicks through it on the one day it is real.
    expect(weeklyReportRetryIsProviderDeduped(SENT_AT, NOW_INSIDE_WINDOW)).toBe(true);
    expect(
      weeklyReportRetryNeedsAcknowledgement({ sentAt: SENT_AT, sendError: null }, NOW_INSIDE_WINDOW),
    ).toBe(false);
  });

  it("DOES ask outside it when the record is SILENT, where a replay is a genuinely second email", () => {
    // Silent, not failed. No delivery stamp and no error is the state that cannot distinguish "the job
    // never ran" from "the provider accepted it and the process died before the stamp" — and in the
    // second the client already has the report.
    expect(weeklyReportRetryIsProviderDeduped(SENT_AT, NOW_OUTSIDE_WINDOW)).toBe(false);
    expect(
      weeklyReportRetryNeedsAcknowledgement({ sentAt: SENT_AT, sendError: null }, NOW_OUTSIDE_WINDOW),
    ).toBe(true);
  });

  it("does NOT ask when the provider recorded why it refused, however old the send", () => {
    // A recorded error is positive evidence of refusal, so there is no first copy to duplicate. The CRM
    // and the server now both take this branch; the phone must not be the surface that still warns.
    expect(
      weeklyReportRetryNeedsAcknowledgement(
        { sentAt: SENT_AT, sendError: "Invalid `to` field" },
        NOW_OUTSIDE_WINDOW,
      ),
    ).toBe(false);
  });

  it("treats a blank error as no evidence of refusal", () => {
    // `send_error` is cleared to NULL on every retry, so blank is a state this really reaches.
    expect(
      weeklyReportRetryNeedsAcknowledgement({ sentAt: SENT_AT, sendError: "   " }, NOW_OUTSIDE_WINDOW),
    ).toBe(true);
  });

  it("asks when the send has no timestamp, or an unreadable one", () => {
    // Conservative on purpose, and matching the shared implementation: being wrong this way costs one
    // extra confirmation, being wrong the other way costs a client a duplicate email.
    expect(
      weeklyReportRetryNeedsAcknowledgement({ sentAt: null, sendError: null }, NOW_INSIDE_WINDOW),
    ).toBe(true);
    expect(
      weeklyReportRetryNeedsAcknowledgement({ sentAt: "not a date", sendError: null }, NOW_INSIDE_WINDOW),
    ).toBe(true);
  });
});

function retryPort(overrides: Partial<WeeklyReportRetryPort> = {}): {
  port: WeeklyReportRetryPort;
  confirms: Array<{ title: string; message: string }>;
  retries: boolean[];
  retried: WeeklyReportDetailView[];
} {
  const confirms: Array<{ title: string; message: string }> = [];
  const retries: boolean[] = [];
  const retried: WeeklyReportDetailView[] = [];
  return {
    confirms,
    retries,
    retried,
    port: {
      confirm: async (prompt) => {
        confirms.push(prompt);
        return true;
      },
      retry: async (acknowledge) => {
        retries.push(acknowledge);
        return { id: "report-1" } as WeeklyReportDetailView;
      },
      onRetried: (report) => {
        retried.push(report);
      },
      ...overrides,
    },
  };
}

describe("running the retry", () => {
  it("posts WITHOUT the acknowledgement, and without asking, inside the window", async () => {
    const { port, confirms, retries, retried } = retryPort();

    const outcome = await runWeeklyReportRetry({ sentAt: SENT_AT, now: NOW_INSIDE_WINDOW }, port);

    expect(outcome).toBe("retried");
    expect(confirms).toEqual([]);
    // FALSE, not merely "not true". The flag is what the server keys its refusal on, and a client that
    // always sent `true` would turn a deliberate act into an accidental one and strip the last defence.
    expect(retries).toEqual([false]);
    expect(retried).toHaveLength(1);
  });

  it("asks first outside the window, and passes the acknowledgement it was given", async () => {
    const { port, confirms, retries } = retryPort();

    const outcome = await runWeeklyReportRetry({ sentAt: SENT_AT, now: NOW_OUTSIDE_WINDOW }, port);

    expect(outcome).toBe("retried");
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.message).toMatch(/second copy/i);
    expect(retries).toEqual([true]);
  });

  it("asks NOTHING outside the window when the provider recorded why it refused", async () => {
    // The failed-send case, end to end through the port: no dialog, and — just as important — no
    // acknowledgement posted. Sending `true` here would switch off a server gate that was never in the
    // way, on a report where nothing was ever delivered to duplicate.
    const { port, confirms, retries, retried } = retryPort();

    const outcome = await runWeeklyReportRetry(
      { sentAt: SENT_AT, sendError: "Invalid `to` field", now: NOW_OUTSIDE_WINDOW },
      port,
    );

    expect(outcome).toBe("retried");
    expect(confirms).toEqual([]);
    expect(retries).toEqual([false]);
    expect(retried).toHaveLength(1);
  });

  it("posts NOTHING when the PM declines — silence and no are the same answer", async () => {
    // The whole point of the confirmation. Every dismissal path the dialog has — Cancel, the Android back
    // gesture, a sheet that fails to present — resolves false, and false must stop the request rather than
    // fall through to an unacknowledged retry the server would refuse anyway (or, worse, an acknowledged
    // one it would honour).
    const { port, confirms, retries, retried } = retryPort({ confirm: async () => false });

    const outcome = await runWeeklyReportRetry({ sentAt: SENT_AT, now: NOW_OUTSIDE_WINDOW }, port);

    expect(outcome).toBe("cancelled");
    expect(retries).toEqual([]);
    expect(retried).toEqual([]);
    expect(confirms).toEqual([]);
  });

  it("does not report success when the POST fails", async () => {
    const { port, retried } = retryPort({
      retry: async () => {
        throw Object.assign(new Error("Request failed (503)"), { status: 503 });
      },
    });

    await expect(
      runWeeklyReportRetry({ sentAt: SENT_AT, now: NOW_INSIDE_WINDOW }, port),
    ).rejects.toThrow();
    expect(retried).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CORRECTION
// ─────────────────────────────────────────────────────────────────────────────

function correctionPort(overrides: Partial<WeeklyReportCorrectionPort> = {}): {
  port: WeeklyReportCorrectionPort;
  confirms: Array<{ title: string; message: string }>;
  creates: number;
  created: WeeklyReportDetailView[];
} {
  const confirms: Array<{ title: string; message: string }> = [];
  const created: WeeklyReportDetailView[] = [];
  const state = { creates: 0 };
  const port: WeeklyReportCorrectionPort = {
    confirm: async (prompt) => {
      confirms.push(prompt);
      return true;
    },
    create: async () => {
      state.creates += 1;
      return { id: "correction-1", version: 2 } as WeeklyReportDetailView;
    },
    onCreated: (correction) => {
      created.push(correction);
    },
    ...overrides,
  };
  return {
    port,
    confirms,
    created,
    get creates() {
      return state.creates;
    },
  };
}

describe("running the correction", () => {
  it("confirms, creates the new version, and hands it on", async () => {
    const result = correctionPort();

    const outcome = await runWeeklyReportCorrection({ delivered: false }, result.port);

    expect(outcome).toBe("created");
    expect(result.creates).toBe(1);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.id).toBe("correction-1");
  });

  it("creates nothing when the PM declines", async () => {
    const result = correctionPort({ confirm: async () => false });

    expect(await runWeeklyReportCorrection({ delivered: false }, result.port)).toBe("cancelled");
    expect(result.creates).toBe(0);
    expect(result.created).toEqual([]);
  });

  it("warns that a correction is NOT a re-send when the email never arrived", async () => {
    // The case a PM staring at "Send failed" is most likely to be in, and the reason this wording exists:
    // a correction takes the failure off the board, makes a v2 nobody has sent, and leaves the client with
    // nothing at all if the PM is pulled away before finishing it.
    const undelivered = correctionPort();
    await runWeeklyReportCorrection({ delivered: false }, undelivered.port);
    expect(undelivered.confirms[0]!.message).toMatch(/not a re-send/i);
    expect(undelivered.confirms[0]!.message).toMatch(/Retry/);

    const delivered = correctionPort();
    await runWeeklyReportCorrection({ delivered: true }, delivered.port);
    // The two prompts must actually DIFFER — a single shared sentence would pass a "mentions a correction"
    // assertion in both directions while telling the undelivered PM nothing they need.
    expect(delivered.confirms[0]!.message).not.toBe(undelivered.confirms[0]!.message);
    expect(delivered.confirms[0]!.message).toMatch(/replaces the copy they already have/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHICH BUTTONS BELONG ON THE SCREEN
// ─────────────────────────────────────────────────────────────────────────────

const SENT_REPORT = {
  status: "sent",
  sendDeliveredAt: null,
  supersededById: null,
} as Pick<WeeklyReportDetailView, "status" | "sendDeliveredAt" | "supersededById">;

describe("which actions a report may be offered", () => {
  it("offers both on a sent, undelivered, un-superseded report — the control", () => {
    expect(weeklyReportCanRetryDelivery(SENT_REPORT)).toBe(true);
    expect(weeklyReportCanCorrect(SENT_REPORT)).toBe(true);
  });

  it("never offers a retry on a SUPERSEDED version, whose email must not go out at all", async () => {
    // The ordinary shape: v1 sent Monday and undelivered, corrected, v2 sent and delivered Tuesday. v1 is
    // then still `sent`, still undelivered, and its stored request still carries a LIVE share URL — every
    // predicate a naive retry checks is satisfied. Replaying it emails a paying client the version they
    // were told was replaced, with nothing in the message saying so, pointing at a page that then shows
    // them a superseded notice. The service refuses it and the CRM's button carries the same predicate;
    // this is what stops the app inviting it in the first place.
    const superseded = { ...SENT_REPORT, supersededById: "report-2" };
    expect(weeklyReportCanRetryDelivery(superseded)).toBe(false);
    expect(weeklyReportCanCorrect(superseded)).toBe(false);
  });

  it("never offers a retry once the provider has accepted the message", () => {
    // Re-sending an accepted email is a correction, not a replay — the server says so with a 409.
    const delivered = { ...SENT_REPORT, sendDeliveredAt: "2026-08-13T20:00:30.000Z" };
    expect(weeklyReportCanRetryDelivery(delivered)).toBe(false);
    // …but a correction is still the right move on a delivered report with a wrong figure in it.
    expect(weeklyReportCanCorrect(delivered)).toBe(true);
  });

  it("offers neither before the report has been sent", () => {
    for (const status of ["draft", "pending_review", "approved"] as const) {
      expect(weeklyReportCanRetryDelivery({ ...SENT_REPORT, status })).toBe(false);
      expect(weeklyReportCanCorrect({ ...SENT_REPORT, status })).toBe(false);
    }
  });
});

describe("what to tell a PM whose retry or correction failed", () => {
  it("shows the server's own sentence, which names the version to work on", () => {
    expect(
      weeklyReportDeliveryErrorMessage({
        status: 409,
        message: "Version 3 of this week's report already exists — finish and send that one instead",
      }),
    ).toMatch(/Version 3/);
  });

  it("does NOT tell somebody to try again after a lost connection", () => {
    // A retry request can commit and lose its reply, so "try again" is exactly how one acknowledged replay
    // becomes two real emails in a client's inbox.
    const offline = weeklyReportDeliveryErrorMessage({ status: 0, message: "Network request failed" });
    expect(offline).toMatch(/can’t tell whether that went through/i);
    expect(offline).not.toMatch(/try again now|just try again/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE MIRRORED CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pins the two mirrored constants against the real ones.
 *
 * `mobile/` is a non-workspace Expo app: it can import neither @trock-crm/shared nor the server's source at
 * runtime, so both numbers are restated in delivery.ts. This test runs in node, where those sources are
 * just files on disk — so it reads the REAL declarations and compares, rather than asserting the mobile
 * copy against a second copy of its own literals. A hard-coded expectation here would stay green for ever
 * while the two drifted, and the visible symptom of drift is the phone and the CRM board disagreeing about
 * whether a client's report is stuck.
 */
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const SHARED_EMAIL_SOURCE = path.join(REPO_ROOT, "shared", "src", "lib", "weeklyReportEmail.ts");
// The stall constant moved out of dashboard-service.ts and into shared when the dead-letter sweep landed:
// the board and the sweep both age a send against it, and a sweep announcing a stall the board still
// renders as "Sending…" is the drift that extraction exists to prevent. This test pointing at the old
// location is exactly what the vacuity guard below is for — the reader returned undefined and, without
// that guard, `expect(undefined).toBe(undefined)` would have stayed green while the phone drifted.
const STALL_SOURCE = path.join(REPO_ROOT, "shared", "src", "lib", "weeklyReportSendStall.ts");

/** The numeric value of `export const <name> = <number>;` in a file, or undefined if it is not there. */
function numericConstant(file: string, name: string): number | undefined {
  const source = ts.createSourceFile(
    path.basename(file),
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let found: number | undefined;
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText() === name && node.initializer) {
      if (ts.isNumericLiteral(node.initializer)) {
        // Numeric separators (`3_600_000`) survive into the literal's text.
        found = Number(node.initializer.text.replace(/_/g, ""));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

describe("the mirrored constants match their sources", () => {
  it("found both declarations at all — an unreadable file would pass the comparisons vacuously", () => {
    // The failure mode of a structural test: a moved or renamed constant makes the reader return
    // undefined, and `expect(undefined).toBe(undefined)` is silently green.
    expect(numericConstant(SHARED_EMAIL_SOURCE, "WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS")).toEqual(
      expect.any(Number),
    );
    expect(numericConstant(STALL_SOURCE, "WEEKLY_REPORT_SEND_STALL_MINUTES")).toEqual(
      expect.any(Number),
    );
  });

  it("restates the provider's idempotency window exactly", () => {
    expect(WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS).toBe(
      numericConstant(SHARED_EMAIL_SOURCE, "WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS"),
    );
  });

  it("restates the stall threshold exactly", () => {
    expect(WEEKLY_REPORT_SEND_STALL_MINUTES).toBe(
      numericConstant(STALL_SOURCE, "WEEKLY_REPORT_SEND_STALL_MINUTES"),
    );
  });

  it("agrees with the shared implementation on both sides of the window", () => {
    // The mirror above pins the NUMBER. This pins the RULE, against the same absolute fixtures the app's
    // behaviour is asserted on — a mirrored constant with an inverted comparison would pass the first and
    // fail here.
    const elapsedInside =
      (NOW_INSIDE_WINDOW.getTime() - new Date(SENT_AT).getTime()) / 3_600_000;
    const elapsedOutside =
      (NOW_OUTSIDE_WINDOW.getTime() - new Date(SENT_AT).getTime()) / 3_600_000;
    expect(elapsedInside).toBeLessThan(WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS);
    expect(elapsedOutside).toBeGreaterThan(WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS);
  });
});
