import fs from "fs";
import path from "path";
import * as ts from "typescript";
import {
  formatWeekOf,
  weeklyReportCandidateTruncationNote,
  weeklyReportDueLabel,
  weeklyReportFinalAction,
  weeklyReportProjectAction,
  weeklyReportQueueTruncationNote,
  weeklyReportWeekStateLabel,
} from "../status";
import { weeklyReportEditorBusyMessage, weeklyReportStepLabel, weeklyReportSubmitErrorMessage } from "../editor-state";

/**
 * Pins the mirror of shared/src/types/weekly-report.ts.
 *
 * `mobile/` is a non-workspace Expo app and cannot import @trock-crm/shared at RUNTIME, so the labels the
 * CRM, the API and the worker read from one module are restated in status.ts. But this test runs in node,
 * where the shared source is just a file on disk — so it reads the real thing and compares, rather than
 * asserting the mobile module against a second copy of its own literals. A hard-coded expectation here
 * would stay green forever while the two surfaces drifted, which is the entire failure this file exists
 * to prevent.
 */
const SHARED_SOURCE = path.join(__dirname, "..", "..", "..", "..", "shared", "src", "types", "weekly-report.ts");

/** Parse `WEEK_STATE_LABELS` out of the shared module's AST — no eval, no regex over a whole file. */
function sharedWeekStateLabels(): Record<string, string> {
  const source = fs.readFileSync(SHARED_SOURCE, "utf8");
  const file = ts.createSourceFile("weekly-report.ts", source, ts.ScriptTarget.Latest, true);
  const labels: Record<string, string> = {};

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText() === "WEEK_STATE_LABELS" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        if (!ts.isStringLiteral(property.initializer)) continue;
        labels[property.name.getText().replace(/^["']|["']$/g, "")] = property.initializer.text;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return labels;
}

describe("week-state labels mirror the shared module", () => {
  const shared = sharedWeekStateLabels();

  it("found the shared map at all — an empty read would pass the comparison vacuously", () => {
    expect(Object.keys(shared).length).toBeGreaterThan(0);
  });

  it("renders every state exactly as the shared module names it", () => {
    for (const [state, label] of Object.entries(shared)) {
      expect(weeklyReportWeekStateLabel(state as never)).toBe(label);
    }
  });

  it("covers every state the shared module defines, with none invented here", () => {
    // A state added to shared and missed here would fall through to the raw enum value on the phone —
    // "pending_client_ack" rendered verbatim in a chip.
    expect(Object.keys(shared).sort()).toEqual(
      ["approved", "dismissed", "draft", "not_started", "pending_review", "sent"].sort(),
    );
  });

  it("treats an absent state as not started rather than rendering a blank chip", () => {
    expect(weeklyReportWeekStateLabel(null)).toBe("Not started");
    expect(weeklyReportWeekStateLabel(undefined)).toBe("Not started");
  });

  it("falls through to the raw value for a state this build does not know", () => {
    // The server can ship a new state before the app does; showing it beats showing an empty chip.
    expect(weeklyReportWeekStateLabel("something_new" as never)).toBe("something_new");
  });
});

describe("the final button", () => {
  it("submits for review when authoring and approves when reviewing", () => {
    // The PM gate is server-enforced either way — this only decides what the button ASKS for.
    expect(weeklyReportFinalAction({ mode: "author", serverStatus: null })).toEqual({
      label: "Submit for PM review",
      transitionTo: "pending_review",
    });
    expect(weeklyReportFinalAction({ mode: "review", serverStatus: "pending_review" })).toEqual({
      label: "Approve report",
      transitionTo: "approved",
    });
  });

  it("only SAVES when the report is already in the state the button would ask for", () => {
    // The bug this closes: the PM queue includes approved-but-unsent reports, and the ladder has no
    // self-transition — so a PM fixing a caption on one and tapping Approve got a 409 on work that had
    // already saved. Same shape for a superintendent reopening a report they have already submitted.
    expect(weeklyReportFinalAction({ mode: "review", serverStatus: "approved" })).toEqual({
      label: "Save changes",
      transitionTo: null,
    });
    expect(weeklyReportFinalAction({ mode: "author", serverStatus: "pending_review" })).toEqual({
      label: "Save changes",
      transitionTo: null,
    });
  });
});

describe("what a project card offers", () => {
  it("starts a week nobody has touched and resumes one already in draft", () => {
    expect(weeklyReportProjectAction({ currentState: "not_started", isPm: false })).toEqual({
      kind: "start",
      mode: "author",
    });
    expect(weeklyReportProjectAction({ currentState: "draft", isPm: false })).toEqual({
      kind: "resume",
      mode: "author",
    });
  });

  it("offers a submitted week to the PM as a REVIEW and to nobody else at all", () => {
    // Server-side, an approved report is editable only by the PM and a submitted one is their move. A
    // card that offered the action anyway would walk a superintendent into a 403 on a report that is
    // simply not theirs any more.
    expect(weeklyReportProjectAction({ currentState: "pending_review", isPm: true })).toEqual({
      kind: "review",
      mode: "review",
    });
    expect(weeklyReportProjectAction({ currentState: "approved", isPm: true })).toEqual({
      kind: "review",
      mode: "review",
    });
    expect(weeklyReportProjectAction({ currentState: "pending_review", isPm: false })).toEqual({
      kind: "waiting",
    });
    expect(weeklyReportProjectAction({ currentState: "approved", isPm: false })).toEqual({
      kind: "waiting",
    });
  });

  it("offers nothing on a sent or dismissed week", () => {
    // A sent report is immutable for everyone — corrections are a new version, which is PR5's job.
    expect(weeklyReportProjectAction({ currentState: "sent", isPm: true })).toEqual({ kind: "done" });
    expect(weeklyReportProjectAction({ currentState: "dismissed", isPm: true })).toEqual({ kind: "done" });
  });

  it("offers nothing on the current week once reporting has ended", () => {
    // weeklyReportExpectedWeeks clamps to the cadence end date and still returns the historical weeks, so
    // a project with misses stays on the hub — but currentWeekOf is past the end and the server refuses
    // it. Without the flag the card renders a button that always 400s.
    expect(
      weeklyReportProjectAction({ currentState: "not_started", isPm: false, currentWeekFilable: false }),
    ).toEqual({ kind: "done" });
  });

  it("treats a missing filable flag as filable, for an older API build", () => {
    expect(weeklyReportProjectAction({ currentState: "not_started", isPm: false })).toEqual({
      kind: "start",
      mode: "author",
    });
  });
});

describe("date formatting", () => {
  it("parses a date-only string at LOCAL midnight so it never shifts a day westward", () => {
    // `new Date("2026-08-13")` parses as UTC midnight and reads back as the 12th anywhere west of
    // Greenwich — which would print the wrong week on every card in Dallas.
    expect(formatWeekOf("2026-08-13")).toMatch(/Aug\s*13/);
  });

  it("hands back an unparseable value rather than rendering an Invalid Date", () => {
    expect(formatWeekOf("not-a-date")).toBe("not-a-date");
  });

  it("says how late an outstanding week is, and otherwise when it is due", () => {
    expect(weeklyReportDueLabel("2026-08-13", 0)).toMatch(/^Due /);
    expect(weeklyReportDueLabel("2026-08-13", 1)).toBe("1 day late");
    expect(weeklyReportDueLabel("2026-08-13", 3)).toBe("3 days late");
  });
});

describe("the review queue's truncation note", () => {
  it("says nothing when the payload carried the whole queue", () => {
    expect(weeklyReportQueueTruncationNote(4, 4)).toBeNull();
  });

  it("names both the count shown and the count missing when the server capped it", () => {
    // The standing rule: never truncate silently. Without this the PM reads a hundred rows as their whole
    // workload, and — because an approved report stays in the queue until it is SENT from the CRM —
    // anything past the cap would never appear no matter how much they worked through.
    const note = weeklyReportQueueTruncationNote(100, 137)!;
    expect(note).toContain("100 most recent of 137");
    expect(note).toContain("37 older reports");
  });

  it("reads correctly when exactly one report is hidden", () => {
    expect(weeklyReportQueueTruncationNote(100, 101)).toContain("1 older report is");
  });

  it("stays silent when an older API build sends no total", () => {
    // Absent is not "everything is hidden" — the field did not exist before this change.
    expect(weeklyReportQueueTruncationNote(3, undefined)).toBeNull();
  });
});

describe("the photo window's truncation note", () => {
  it("says nothing when the grid holds the whole window", () => {
    expect(weeklyReportCandidateTruncationNote(42, 42)).toBeNull();
  });

  it("names what is missing, and that it is the OLDEST of the window", () => {
    // The window is anchored on the report's week and ordered newest-first, so the cap removes the
    // earliest days of the fortnight — for a report filed late, the days the report is actually about.
    // A refresh cannot change that, so the note points at the device library instead.
    const note = weeklyReportCandidateTruncationNote(300, 412)!;
    expect(note).toContain("300 newest of 412");
    expect(note).toContain("112 oldest");
    expect(note).toContain("import from the device");
  });

  it("reads correctly when exactly one photo is hidden", () => {
    expect(weeklyReportCandidateTruncationNote(300, 301)).toContain("1 oldest is");
  });

  it("stays silent when an older API build sends no total", () => {
    expect(weeklyReportCandidateTruncationNote(300, undefined)).toBeNull();
  });

  it("stays silent when the grid carries MORE than the window reported", () => {
    // Reachable by design: a selection outside the window is merged into the grid, so `shown` can exceed
    // `total`. That is not a truncation and must not render as "-2 oldest are not listed".
    expect(weeklyReportCandidateTruncationNote(12, 10)).toBeNull();
  });
});

describe("editor state", () => {
  it("names the most urgent reason the wizard cannot be left", () => {
    expect(weeklyReportEditorBusyMessage({ submitting: true, importing: true, voiceBusy: true })).toMatch(/Saving/);
    expect(weeklyReportEditorBusyMessage({ submitting: false, importing: true, voiceBusy: true })).toMatch(/Importing/);
    expect(weeklyReportEditorBusyMessage({ submitting: false, importing: false, voiceBusy: true })).toMatch(/dictation/);
    expect(weeklyReportEditorBusyMessage({ submitting: false, importing: false, voiceBusy: false })).toBeNull();
  });

  it("prefers the server's actionable message over a generic failure", () => {
    expect(
      weeklyReportSubmitErrorMessage({
        status: 409,
        message: "A sent report cannot be edited — issue a correction instead",
      }),
    ).toBe("A sent report cannot be edited — issue a correction instead");
  });

  it("says the work is safe when the failure was the network, not the report", () => {
    // ApiError(0)/(408) carry a message about the socket, which is no use to someone on a jobsite.
    expect(weeklyReportSubmitErrorMessage({ status: 0, message: "Network request failed" })).toMatch(
      /saved on this phone/i,
    );
    expect(weeklyReportSubmitErrorMessage({ status: 408, message: "Request timed out" })).toMatch(
      /saved on this phone/i,
    );
  });

  it("discards the client's own placeholder message", () => {
    expect(weeklyReportSubmitErrorMessage({ status: 500, message: "Request failed (500)" })).toMatch(
      /Couldn’t save this report/,
    );
  });

  it("counts steps from one for the human reading them", () => {
    expect(weeklyReportStepLabel(0, 6)).toBe("Step 1 of 6");
    expect(weeklyReportStepLabel(5, 6)).toBe("Step 6 of 6");
  });
});
