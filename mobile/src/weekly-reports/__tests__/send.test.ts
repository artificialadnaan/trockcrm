import fs from "fs";
import path from "path";
import * as ts from "typescript";
import {
  WEEKLY_REPORT_SEND_LIMITS,
  WeeklyReportSendInputError,
  runWeeklyReportSend,
  weeklyReportSendErrorMessage,
  weeklyReportSendPreviewNote,
  weeklyReportSendRecipients,
  weeklyReportSendValidationError,
  type WeeklyReportSendOutcome,
  type WeeklyReportSendPort,
} from "../send";
import type { WeeklyReportDetailView } from "../../api/types";

/**
 * The phone's half of the client send.
 *
 * Everything here is either (a) a refusal that saves a jobsite round trip, (b) a fact about what the app
 * may render, or (c) a guard on the one-time client link. None of it decides what the email says — that is
 * composed server-side precisely so the CRM's dialog and this screen cannot drift into two emails.
 */

const REPORT: WeeklyReportDetailView = {
  id: "report-1",
  weeklyReportProjectId: "project-1",
  dealId: "deal-1",
  weekOf: "2026-08-13",
  version: 1,
  status: "sent",
  workCompleted: "Framing complete on levels 3 and 4.",
  nextWeekLookAhead: null,
  issuesConcerns: null,
  completionPercent: 42,
  weatherDelayDays: null,
  remainingWeeks: null,
  projectedDurationWeeks: null,
  authoredByName: "Steve Sanchez",
  submittedAt: "2026-08-13T18:00:00.000Z",
  reviewedAt: "2026-08-13T19:00:00.000Z",
  sentAt: "2026-08-13T20:00:00.000Z",
  supersededById: null,
  sendError: null,
  sendAttempts: 0,
  sendDeliveredAt: null,
  sendLastAttemptAt: null,
  photos: [],
};

/** A real base64url token shape (43 chars), so a leak test is looking for the thing that actually leaks. */
const RAW_TOKEN = "Ab3xY_zQ8kLmNoPqRsTuVwXyZ0123456789abcdefgh";
const SHARE_URL = `https://reports.trockcam.com/wr/${RAW_TOKEN}`;

describe("resolving the recipient list", () => {
  it("includes an address that was typed but never added", () => {
    // The trap: the keyboard covers the Add button, so typing the client's new contact and tapping Send is
    // the natural gesture. Dropping it would mean the person the PM had just added never receives the
    // report, on a request that reports success.
    const { recipients, error } = weeklyReportSendRecipients({
      selected: ["jay@example.com"],
      pending: " melissa@example.com ",
    });
    expect(error).toBeNull();
    expect(recipients).toEqual(["jay@example.com", "melissa@example.com"]);
  });

  it("leaves the list alone when nothing is pending", () => {
    const { recipients, error } = weeklyReportSendRecipients({
      selected: ["jay@example.com"],
      pending: "   ",
    });
    expect(error).toBeNull();
    expect(recipients).toEqual(["jay@example.com"]);
  });

  it("does not duplicate an address already on the list, whatever its case", () => {
    const { recipients } = weeklyReportSendRecipients({
      selected: ["Jay@Example.com"],
      pending: "jay@example.com",
    });
    expect(recipients).toEqual(["Jay@Example.com"]);
  });

  it("refuses a malformed pending address rather than silently dropping it", () => {
    // Rejecting is the same choice the server makes: the honest outcomes are "this went where you asked"
    // and "fix this", never "this went to some of them".
    const { recipients, error } = weeklyReportSendRecipients({
      selected: ["jay@example.com"],
      pending: "melissa@",
    });
    expect(error).toMatch(/email address/i);
    expect(recipients).toEqual(["jay@example.com"]);
  });
});

describe("refusing a send before it costs a round trip", () => {
  const valid = {
    recipients: ["jay@example.com"],
    subject: "Weekly Progress Report",
    contextParagraph: "Week 3 update attached.",
  };

  it("passes a well-formed send — the control", () => {
    // Without this, a validator that refused everything would satisfy every case below.
    expect(weeklyReportSendValidationError(valid)).toBeNull();
  });

  it("refuses an empty recipient list", () => {
    expect(weeklyReportSendValidationError({ ...valid, recipients: [] })).toMatch(/at least one/i);
  });

  it("refuses a blank subject", () => {
    expect(weeklyReportSendValidationError({ ...valid, subject: "   " })).toMatch(/subject/i);
  });

  it("names the offending address rather than saying the list is bad", () => {
    expect(
      weeklyReportSendValidationError({ ...valid, recipients: ["jay@example.com", "oops"] }),
    ).toContain("oops");
  });

  it("refuses one recipient over the cap and accepts one under it", () => {
    // BOTH SIDES OF THE BOUNDARY. A check written as `>=` passes the over-cap case on its own; only the
    // pair pins the limit itself. The lists are built from the cap so the test describes the boundary
    // rather than a number that has to be re-typed when the cap moves — the cap is pinned separately,
    // against the shared module, by the mirror test below.
    const at = Array.from(
      { length: WEEKLY_REPORT_SEND_LIMITS.maxRecipients },
      (_, i) => `client${i}@example.com`,
    );
    expect(weeklyReportSendValidationError({ ...valid, recipients: at })).toBeNull();
    expect(
      weeklyReportSendValidationError({ ...valid, recipients: [...at, "one-too-many@example.com"] }),
    ).toMatch(/at most/i);
  });

  it("refuses one character over the subject and message ceilings", () => {
    expect(
      weeklyReportSendValidationError({
        ...valid,
        subject: "s".repeat(WEEKLY_REPORT_SEND_LIMITS.maxSubjectChars + 1),
      }),
    ).toMatch(/subject/i);
    expect(
      weeklyReportSendValidationError({
        ...valid,
        contextParagraph: "m".repeat(WEEKLY_REPORT_SEND_LIMITS.maxContextChars + 1),
      }),
    ).toMatch(/message/i);
  });

  it("allows an empty message — a PM who deletes it means it", () => {
    expect(weeklyReportSendValidationError({ ...valid, contextParagraph: "" })).toBeNull();
  });
});

describe("the body preview, when the PM changes who it goes to", () => {
  const draft = { recipients: ["jay@example.com", "melissa@example.com"] };

  it("says nothing while the list is untouched", () => {
    expect(weeklyReportSendPreviewNote(draft, ["jay@example.com", "melissa@example.com"])).toBeNull();
  });

  it("warns once the list differs, because the greeting is chosen from the FINAL list", () => {
    // The server picks the greeting from the recipients it is finally given, while `bodyPreview` was
    // composed from the pre-filled ones. Remove the DOC and the preview says "Hello Jay," for an email
    // that will read "Hello Melissa,". The app says so rather than guessing at the new name: recomputing
    // it would mean a second implementation of a rule the client reads, which is exactly what the shared
    // module exists to prevent.
    expect(weeklyReportSendPreviewNote(draft, ["melissa@example.com"])).toMatch(/greeting/i);
    expect(
      weeklyReportSendPreviewNote(draft, ["jay@example.com", "melissa@example.com", "new@example.com"]),
    ).toMatch(/greeting/i);
  });

  it("ignores a pure case difference, which changes nothing about the email", () => {
    expect(weeklyReportSendPreviewNote(draft, ["JAY@example.com", "Melissa@Example.com"])).toBeNull();
  });

  it("notices a REORDER, because the greeting is taken from the list's first match", () => {
    expect(weeklyReportSendPreviewNote(draft, ["melissa@example.com", "jay@example.com"])).toMatch(
      /greeting/i,
    );
  });
});

describe("what to tell a PM whose send failed", () => {
  it("shows the server's own sentence, which is the actionable one", () => {
    expect(
      weeklyReportSendErrorMessage({
        status: 409,
        message: "This report has already been sent — issue a correction instead",
      }),
    ).toMatch(/already been sent/);
  });

  it("does NOT promise the work is safe on the phone, unlike the wizard's copy", () => {
    // Nothing about a send is held locally, and a lost connection leaves it genuinely unknown whether the
    // email went — the request can commit and lose its reply. Telling somebody to try again would put a
    // second copy in a client's inbox; telling them to go and look is the only honest instruction.
    const offline = weeklyReportSendErrorMessage({ status: 0, message: "Network request failed" });
    expect(offline).not.toMatch(/saved on this phone/i);
    expect(offline).toMatch(/check whether it says Sent|whether the email went/i);
  });

  it("shows a pre-flight refusal verbatim rather than replacing it with offline copy", () => {
    expect(weeklyReportSendErrorMessage(new WeeklyReportSendInputError("Add at least one client address."))).toBe(
      "Add at least one client address.",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE-TIME CLIENT LINK
// ─────────────────────────────────────────────────────────────────────────────

function recordingPort(): {
  port: WeeklyReportSendPort;
  revealed: WeeklyReportSendOutcome[];
  recorded: WeeklyReportDetailView[];
  sends: unknown[];
} {
  const revealed: WeeklyReportSendOutcome[] = [];
  const recorded: WeeklyReportDetailView[] = [];
  const sends: unknown[] = [];
  return {
    revealed,
    recorded,
    sends,
    port: {
      send: async (payload) => {
        sends.push(payload);
        return { report: REPORT, shareUrl: SHARE_URL };
      },
      reveal: (outcome) => {
        revealed.push(outcome);
      },
      recordSent: (report) => {
        recorded.push(report);
      },
    },
  };
}

describe("running the send", () => {
  it("posts exactly what it was given and hands back the link — the control", () => {
    // The control for every leak assertion below. Without it, a `runWeeklyReportSend` that never called
    // its port at all would satisfy "the token is not in `recordSent`" trivially.
    const { port, revealed, recorded, sends } = recordingPort();
    return runWeeklyReportSend(
      {
        recipients: ["jay@example.com"],
        subject: "Weekly Progress Report",
        contextParagraph: "Week 3 update attached.",
        attachPdf: true,
      },
      port,
    ).then((outcome) => {
      expect(sends).toEqual([
        {
          recipients: ["jay@example.com"],
          subject: "Weekly Progress Report",
          contextParagraph: "Week 3 update attached.",
          attachPdf: true,
        },
      ]);
      expect(outcome.shareUrl).toBe(SHARE_URL);
      expect(revealed).toHaveLength(1);
      expect(JSON.stringify(revealed[0])).toContain(RAW_TOKEN);
      expect(recorded).toHaveLength(1);
    });
  });

  it("never gives the raw token to the callback the refresh path runs on", async () => {
    // `recordSent` is what invalidates the hub's query, and it takes the REPORT rather than the outcome
    // for exactly this reason: with a single `onSent(outcome)` every downstream caller would receive the
    // link whether it wanted it or not, and it would reach a query cache, a breadcrumb or a log line the
    // first time somebody logged "sent" with its argument.
    const { port, recorded } = recordingPort();

    await runWeeklyReportSend(
      {
        recipients: ["jay@example.com"],
        subject: "Weekly Progress Report",
        contextParagraph: "",
        attachPdf: true,
      },
      port,
    );

    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded[0])).not.toContain(RAW_TOKEN);
    expect(JSON.stringify(recorded[0])).not.toContain(SHARE_URL);
    // Searched over the whole serialised object rather than a named field, so a link that appears in some
    // future addition to the report payload is caught rather than missed for not being looked for.
    expect(Object.keys(recorded[0]!)).not.toContain("shareUrl");
  });

  it("refuses before anything leaves the phone when the input is unusable", async () => {
    const { port, sends, revealed, recorded } = recordingPort();

    await expect(
      runWeeklyReportSend(
        { recipients: [], subject: "Weekly Progress Report", contextParagraph: "", attachPdf: true },
        port,
      ),
    ).rejects.toBeInstanceOf(WeeklyReportSendInputError);

    // Nothing was posted, so nothing was minted server-side either — the point of validating here at all.
    expect(sends).toHaveLength(0);
    expect(revealed).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("does not reveal or record when the POST fails", async () => {
    // A send whose request failed must not leave the screen showing a link, and must not tell the hub the
    // report moved. Both would be a lie about a client email.
    const revealed: WeeklyReportSendOutcome[] = [];
    const recorded: WeeklyReportDetailView[] = [];
    const port: WeeklyReportSendPort = {
      send: async () => {
        throw Object.assign(new Error("Request failed (503)"), { status: 503 });
      },
      reveal: (outcome) => {
        revealed.push(outcome);
      },
      recordSent: (report) => {
        recorded.push(report);
      },
    };

    await expect(
      runWeeklyReportSend(
        {
          recipients: ["jay@example.com"],
          subject: "Weekly Progress Report",
          contextParagraph: "",
          attachPdf: true,
        },
        port,
      ),
    ).rejects.toThrow();
    expect(revealed).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURAL GUARDS
// ─────────────────────────────────────────────────────────────────────────────

const SEND_MODULE = path.join(__dirname, "..", "send.ts");
const SEND_SCREEN = path.join(__dirname, "..", "..", "..", "app", "(app)", "reports", "send", "[reportId].tsx");
const DELIVERY_MODULE = path.join(__dirname, "..", "delivery.ts");
const DELIVERY_SCREEN = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "app",
  "(app)",
  "reports",
  "delivery",
  "[reportId].tsx",
);

/**
 * EVERY file on the path a client link can travel, not only the one that receives it.
 *
 * The delivery screen never sees a `shareUrl` — the retry answers with the report alone, and a correction
 * answers with a fresh unsent version that has no link yet. It is guarded anyway, for two reasons. It
 * navigates the PM STRAIGHT INTO the send screen after a correction, so it is one edit away from carrying a
 * link through a navigation param, which is exactly the shape that lands in a crash breadcrumb. And it
 * renders `sendError` — a provider string this codebase does not control the contents of — so a `console`
 * call added here for debugging would be the most natural way to put a client's data somewhere nobody is
 * looking. A guard that only covers the file that currently holds the secret stops being a guard the moment
 * the feature grows, which is the point at which it is needed.
 */
const LEAK_GUARDED_FILES = [SEND_MODULE, SEND_SCREEN, DELIVERY_MODULE, DELIVERY_SCREEN];

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    path.basename(file),
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function importSpecifiers(source: ts.SourceFile): string[] {
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

/** Every `x.y(...)` callee text in the file — enough to spot a console or a storage call. */
function callTargets(source: ts.SourceFile): string[] {
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) found.push(node.expression.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

/**
 * PARSED, NOT GREPPED — the rule this repo already learned the hard way on the mobile sweep.
 *
 * A grep for `console.` matches the word inside this very comment and inside any string, so it answers
 * both "there is a log here" and "somebody wrote about logging" identically. These read the AST, so what
 * is asserted is that the CODE does it.
 */
describe("the send and delivery surfaces structurally cannot leak the client link", () => {
  it("imports no storage module, so there is nowhere for the link to be written", () => {
    // The screen holds `shareUrl` in component state that dies with the screen. This is the guard that
    // keeps it that way: `mobile/` is not in CI and the app has no OTA, so a persisted token would ship
    // to phones and live there for days, and nothing would ever revoke it because nothing would know.
    // MATCH THE SPECIFIER, NOT THE BINDING. This list originally carried `SecureStore`, which is the
    // local binding in `import * as SecureStore from "expo-secure-store"` — the string actually tested
    // is the specifier, `expo-secure-store`, lowercase and hyphenated, so that alternative could never
    // fire. `expo-secure-store` is already a dependency and already imported exactly that way in
    // `mobile/src/settings/camera-roll-setting.ts`, i.e. it is the NATURAL way to persist something
    // here and the one the guard was blindest to. Writing the link to the keychain left all 27 tests
    // green. Case-insensitive now, and matching real module names, so a binding/specifier mismatch
    // cannot silently retire an alternative again.
    const STORAGE_MODULES =
      /draft-store|async-storage|expo-secure-store|expo-file-system|expo-sqlite|react-native-mmkv|@react-native-community\/cookies/i;
    for (const file of LEAK_GUARDED_FILES) {
      const specifiers = importSpecifiers(parse(file));
      for (const specifier of specifiers) {
        expect(specifier).not.toMatch(STORAGE_MODULES);
      }
    }
  });

  it("makes no console call, so the link cannot reach a log or crash breadcrumb", () => {
    for (const file of LEAK_GUARDED_FILES) {
      const targets = callTargets(parse(file));
      expect(targets.filter((target) => target.startsWith("console."))).toEqual([]);
    }
  });

  it("found something to inspect — an unreadable file would pass the two checks above vacuously", () => {
    // The failure mode of a structural test: a moved file makes `parse` throw, but a filter over an empty
    // list is silently green. Both files are asserted to be real and non-trivial first.
    for (const file of LEAK_GUARDED_FILES) {
      expect(fs.existsSync(file)).toBe(true);
      expect(importSpecifiers(parse(file)).length).toBeGreaterThan(0);
      expect(callTargets(parse(file)).length).toBeGreaterThan(0);
    }
  });
});

/**
 * Pins the mirrored limits against the real ones.
 *
 * `mobile/` cannot import @trock-crm/shared at runtime, so WEEKLY_REPORT_SEND_LIMITS is restated in
 * send.ts. This test runs in node, where the shared source is just a file on disk — so it reads the real
 * constants and compares, rather than asserting the mobile copy against a second copy of its own
 * literals. A hard-coded expectation here would stay green for ever while the two drifted, and the visible
 * symptom of drift is a PM writing a message the phone accepts and the server 400s at the moment of send.
 */
const SHARED_EMAIL_SOURCE = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "shared",
  "src",
  "lib",
  "weeklyReportEmail.ts",
);

function sharedSendLimits(): Record<string, number> {
  const source = fs.readFileSync(SHARED_EMAIL_SOURCE, "utf8");
  const file = ts.createSourceFile("weeklyReportEmail.ts", source, ts.ScriptTarget.Latest, true);
  const limits: Record<string, number> = {};

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText() === "WEEKLY_REPORT_SEND_LIMITS" &&
      node.initializer
    ) {
      // `as const` wraps the object literal in an AsExpression.
      const literal = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isObjectLiteralExpression(literal)) {
        for (const property of literal.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          if (!ts.isNumericLiteral(property.initializer)) continue;
          // Numeric separators (`4_000`) survive into the literal's text.
          limits[property.name.getText()] = Number(property.initializer.text.replace(/_/g, ""));
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return limits;
}

describe("the send limits mirror the shared module", () => {
  const shared = sharedSendLimits();

  it("found the shared constants at all — an empty read would pass the comparison vacuously", () => {
    expect(Object.keys(shared).sort()).toEqual(["maxContextChars", "maxRecipients", "maxSubjectChars"]);
  });

  it("restates every one of them exactly", () => {
    expect(WEEKLY_REPORT_SEND_LIMITS.maxRecipients).toBe(shared.maxRecipients);
    expect(WEEKLY_REPORT_SEND_LIMITS.maxSubjectChars).toBe(shared.maxSubjectChars);
    expect(WEEKLY_REPORT_SEND_LIMITS.maxContextChars).toBe(shared.maxContextChars);
  });
});
