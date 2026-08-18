// What happens when a local weekly-report draft meets the server copy of the same report.
//
// Every case here is a SEQUENCE — seed, edit, somebody else edits, reopen — because that is the shape of
// every bug this module closes. The end state on its own is ambiguous: "the local draft differs from the
// server" is a lost rewrite in one order of events and a stale snapshot about to be filed over somebody
// else's work in the other, and the old code could not tell them apart because it kept no record of what
// the draft had been seeded from.
//
// The tests drive the same composition the hub screen does — seed a draft with `weeklyReportDraftFromDetail`,
// sign both sides with `weeklyReportDraftSignature`, ask `weeklyReportReconcile` — so a change that breaks
// the screen's use of these parts breaks these too.

import {
  weeklyReportDraftFromDetail,
  weeklyReportDraftReducer,
  weeklyReportDraftSignature,
  weeklyReportSeedStateFromDetail,
  type WeeklyReportDraft,
  type WeeklyReportSeedableReport,
} from "../draft";
import {
  WEEKLY_REPORT_WEEK_EXISTS_CODE,
  isWeeklyReportWeekTakenError,
  weeklyReportDiscardWarning,
  weeklyReportOpenRefusal,
  weeklyReportReconcile,
  weeklyReportWeekRowIsUntouched,
  weeklyReportWeekTakenMessage,
} from "../reconcile";

const ALL_ALLOWED = { canEdit: true, canApprove: true };

function serverReport(overrides: Partial<WeeklyReportSeedableReport> = {}): WeeklyReportSeedableReport {
  return {
    id: "rep-1",
    weeklyReportProjectId: "wrp-1",
    dealId: "deal-1",
    weekOf: "2026-08-13",
    status: "pending_review",
    workCompleted: "Poured the north slab.",
    nextWeekLookAhead: "Start unit framing.",
    issuesConcerns: null,
    completionPercent: 12.5,
    weatherDelayDays: 2,
    photos: [
      {
        fileId: "file-a",
        caption: "North slab",
        originalDescription: "slab",
        takenAt: "2026-08-11T15:00:00Z",
        thumbnailUrl: "https://example.test/a.jpg?sig=one",
      },
      {
        fileId: "file-b",
        caption: "Balcony mock-up",
        originalDescription: null,
        takenAt: "2026-08-12T15:00:00Z",
        thumbnailUrl: "https://example.test/b.jpg?sig=one",
      },
    ],
    ...overrides,
  };
}

/** An empty row, exactly as `POST /reports` leaves it when a device reaches the photos step. */
function emptyRow(overrides: Partial<WeeklyReportSeedableReport> = {}): WeeklyReportSeedableReport {
  return serverReport({
    status: "draft",
    workCompleted: null,
    nextWeekLookAhead: null,
    issuesConcerns: null,
    completionPercent: null,
    weatherDelayDays: null,
    photos: [],
    ...overrides,
  });
}

function seed(report: WeeklyReportSeedableReport, mode: "author" | "review", id = "draft-1") {
  return weeklyReportDraftFromDetail({
    id,
    clientSubmissionId: `sub-${id}`,
    projectName: "4123 Cedar Springs",
    mode,
    report,
    now: 1_000,
  });
}

/**
 * One tap on a door: read the report, sign both sides, ask for a decision. Mirrors `openReconciled` in
 * app/(app)/reports/index.tsx.
 */
function openDoor(input: {
  mode: "author" | "review";
  report: WeeklyReportSeedableReport;
  permissions?: { canEdit: boolean; canApprove: boolean };
  local: WeeklyReportDraft | null;
}) {
  const seeded = seed(input.report, input.mode, input.local?.id ?? "draft-new");
  return {
    seeded,
    decision: weeklyReportReconcile({
      mode: input.mode,
      server: {
        status: input.report.status,
        signature: weeklyReportDraftSignature(seeded),
        permissions: input.permissions ?? ALL_ALLOWED,
      },
      local: input.local
        ? { seededFrom: input.local.seededFrom, signature: weeklyReportDraftSignature(input.local) }
        : null,
    }),
  };
}

describe("a PM who edits a review draft and comes back to it", () => {
  it("keeps the un-submitted rewrite when the server has not moved", () => {
    // THE FINDING. The PM opens a report for review, rewrites Issues and fixes a caption — all autosaved
    // locally, nothing sent until Approve — backs out, and taps the "Resume" link on the In-progress row.
    // Every successful re-read used to overwrite the draft unconditionally, so the rework was thrown away
    // by the act of resuming. No prompt, no diff, and the row that promised "Resume" is what deleted it.
    const report = serverReport();
    const opened = openDoor({ mode: "review", report, local: null });
    expect(opened.decision.kind).toBe("reseed");

    let draft = opened.seeded;
    draft = weeklyReportDraftReducer(draft, {
      type: "setSection",
      key: "issuesConcerns",
      value: "Permit for the east elevation is still with the city.",
    });
    draft = weeklyReportDraftReducer(draft, {
      type: "setPhotoCaption",
      key: "file-b",
      caption: "Balcony mock-up, approved by the architect",
    });

    // Back out, tap Resume. The server is exactly where it was.
    const resumed = openDoor({ mode: "review", report, local: draft });
    expect(resumed.decision.kind).toBe("keep-local");
    // And the assertion means something: reseeding really would have destroyed both edits.
    expect(resumed.seeded.issuesConcerns).toBe("");
    expect(resumed.seeded.photos[1]!.caption).toBe("Balcony mock-up");
  });

  it("reseeds silently when the PM changed nothing, however far the server has moved", () => {
    const opened = openDoor({ mode: "review", report: serverReport(), local: null });
    const moved = serverReport({
      workCompleted: "Poured the north slab. Stripped forms Friday.",
      issuesConcerns: "Rebar delivery slipped a week.",
    });
    const resumed = openDoor({ mode: "review", report: moved, local: opened.seeded });
    expect(resumed.decision.kind).toBe("reseed");
    expect(resumed.seeded.issuesConcerns).toBe("Rebar delivery slipped a week.");
  });

  it("asks, rather than choosing, when BOTH sides changed", () => {
    const report = serverReport({ status: "draft" });
    const opened = openDoor({ mode: "review", report, local: null });
    const edited = weeklyReportDraftReducer(opened.seeded, {
      type: "setSection",
      key: "issuesConcerns",
      value: "Client wants the balcony detail revisited.",
    });
    // The superintendent rewrote it and resubmitted while the PM held their copy.
    const resubmitted = serverReport({
      status: "pending_review",
      workCompleted: "Poured the north slab. Balcony detail reworked per RFI 14.",
    });

    const resumed = openDoor({ mode: "review", report: resubmitted, local: edited });
    expect(resumed.decision.kind).toBe("conflict");
    if (resumed.decision.kind !== "conflict") throw new Error("unreachable");
    // Both costs have to be on screen: either answer replaces somebody's writing, and a dialog that named
    // only one of them would just move the silent loss to the other button.
    expect(resumed.decision.message).toMatch(/replaces theirs/);
    expect(resumed.decision.message).toMatch(/gone/);
    expect(resumed.decision.keepLocalLabel).not.toBe(resumed.decision.useServerLabel);
  });

  it("does not invent a conflict out of a submit whose writes landed and whose transition did not", () => {
    // The most common retry path there is. Approve PATCHes the content and PUTs the photo set, then the
    // transition fails — so the SERVER now holds exactly what the phone holds, while the draft's baseline
    // still describes what it was seeded from. Both sides have "moved", to the same place. Prompting here
    // would put a two-way conflict dialog in front of every failed submit, which is how people learn to
    // dismiss the dialog unread.
    const opened = openDoor({ mode: "review", report: serverReport(), local: null });
    const edited = weeklyReportDraftReducer(opened.seeded, {
      type: "setSection",
      key: "issuesConcerns",
      value: "Permit still with the city.",
    });
    const afterTheWritesLanded = serverReport({ issuesConcerns: "Permit still with the city." });
    const resumed = openDoor({ mode: "review", report: afterTheWritesLanded, local: edited });
    expect(resumed.decision.kind).toBe("keep-local");
  });

  it("does not call a re-issued preview URL a server change", () => {
    // Presigned thumbnails are re-signed on every read. If they counted toward the fingerprint, a PM with
    // any local edit would be asked to resolve a conflict every single time they opened the report, and
    // the prompt would stop meaning anything.
    const opened = openDoor({ mode: "review", report: serverReport(), local: null });
    const edited = weeklyReportDraftReducer(opened.seeded, {
      type: "setSection",
      key: "issuesConcerns",
      value: "Nothing outstanding.",
    });
    const resigned = serverReport({
      photos: serverReport().photos.map((photo) => ({
        ...photo,
        thumbnailUrl: `${photo.thumbnailUrl!.split("?")[0]}?sig=two`,
      })),
    });
    expect(openDoor({ mode: "review", report: resigned, local: edited }).decision.kind).toBe("keep-local");
  });
});

describe("a stale AUTHOR draft the PM left behind", () => {
  /** The PM's card reads "With super", so "Open week of Aug 13" seeds an AUTHOR draft from the empty row. */
  function pmOpensTheSupersDraft() {
    const opened = openDoor({ mode: "author", report: emptyRow(), local: null });
    expect(opened.decision.kind).toBe("reseed");
    expect(opened.seeded.mode).toBe("author");
    expect(opened.seeded.serverStatus).toBe("draft");
    return opened.seeded;
  }

  it("opens what the superintendent actually submitted, not the PM's snapshot of an empty week", () => {
    // THE FINDING, as the sequence that produced it. The stale-draft guard keyed on `mode === "review"`,
    // so this author-mode draft took `resume-local` — no server read at all. The wizard then showed the
    // Aug-13-at-step-2 content with "Submit for PM review" on the button, and the submit PATCHed that
    // stale text and PUT that stale photo set over the report the super had since filed.
    const pmDraft = pmOpensTheSupersDraft();

    const submitted = serverReport({
      status: "pending_review",
      workCompleted: "Poured the north slab. Stripped forms Friday. Punchlist for level 2 closed.",
      issuesConcerns: "Rebar delivery slipped a week.",
    });
    const reopened = openDoor({ mode: "review", report: submitted, local: pmDraft });

    expect(reopened.decision.kind).toBe("reseed");
    expect(reopened.seeded.workCompleted).toContain("Punchlist for level 2 closed");
    expect(reopened.seeded.issuesConcerns).toBe("Rebar delivery slipped a week.");
    expect(reopened.seeded.photos).toHaveLength(2);
  });

  it("asks instead of silently reverting when the PM HAD typed into their stale copy", () => {
    const pmDraft = weeklyReportDraftReducer(pmOpensTheSupersDraft(), {
      type: "setSection",
      key: "workCompleted",
      value: "Nothing much this week.",
    });
    const submitted = serverReport({ status: "pending_review" });
    expect(openDoor({ mode: "review", report: submitted, local: pmDraft }).decision.kind).toBe("conflict");
  });
});

describe("the refusal gate, applied by every door", () => {
  it("refuses a review row that has gone back to the superintendent — with or without a local draft", () => {
    // The gate lived in one of the three doors. The review door taken when the PM has NO local draft
    // checked `canEdit` alone, and a PM still has canEdit on a `draft` report — so it opened review mode,
    // walked them through captions and photos, and the final tap PATCHed content and REPLACED the photo
    // set before the illegal draft -> approved transition 409'd. The mutations stick; only the transition
    // fails.
    const bounced = serverReport({ status: "draft" });
    const permissions = { canEdit: true, canApprove: false };
    for (const local of [null, seed(bounced, "review")]) {
      const { decision } = openDoor({ mode: "review", report: bounced, permissions, local });
      expect(decision.kind).toBe("refuse");
      if (decision.kind !== "refuse") throw new Error("unreachable");
      expect(decision.message).toMatch(/back to the superintendent/i);
    }
  });

  it("lets the AUTHOR door open the same draft report", () => {
    // Same row, same permissions — but a superintendent filling in their own draft is exactly who it is
    // for, and refusing here would take the week away from the only person who can file it.
    const { decision } = openDoor({
      mode: "author",
      report: emptyRow(),
      permissions: { canEdit: true, canApprove: false },
      local: null,
    });
    expect(decision.kind).toBe("reseed");
  });

  it("still opens an APPROVED report for the PM, whose action is Save changes rather than Approve", () => {
    // canApprove is false at `approved` because the ladder has no self-transition. Gating on it would lock
    // the PM out of the approved-but-unsent reports this queue deliberately carries.
    const { decision } = openDoor({
      mode: "review",
      report: serverReport({ status: "approved" }),
      permissions: { canEdit: true, canApprove: false },
      local: null,
    });
    expect(decision.kind).toBe("reseed");
  });

  it("refuses anything unwritable, whatever the mode or the local state", () => {
    for (const mode of ["author", "review"] as const) {
      const { decision } = openDoor({
        mode,
        report: serverReport({ status: "sent" }),
        permissions: { canEdit: false, canApprove: false },
        local: seed(serverReport(), mode),
      });
      expect(decision.kind).toBe("refuse");
    }
  });

  it("is the same function both doors call", () => {
    expect(
      weeklyReportOpenRefusal({ mode: "review", status: "draft", permissions: { canEdit: true, canApprove: false } }),
    ).not.toBeNull();
    expect(
      weeklyReportOpenRefusal({ mode: "author", status: "draft", permissions: { canEdit: true, canApprove: false } }),
    ).toBeNull();
  });
});

describe("a week that got a report row from another device", () => {
  /** The phone typed the whole report but never reached the photos step, so it holds no report id. */
  function phoneDraft() {
    let draft = seed(emptyRow(), "author", "draft-phone");
    // What the phone actually holds: a purely local draft. `seededFrom` is null because nothing on the
    // server has ever corresponded to it.
    draft = { ...draft, reportId: null, seededFrom: null };
    return weeklyReportDraftReducer(draft, {
      type: "setSection",
      key: "workCompleted",
      value: "Framed levels 3 and 4. Roof drain rough-in complete.",
    });
  }

  it("adopts the other device's EMPTY row and keeps everything typed on this phone", () => {
    // THE FINDING. The iPad reached the photos step for the same week, so the row exists under the iPad's
    // clientSubmissionId. The phone's create then missed on submission id, hit on week, and answered 409
    // "A report already exists for this week" — forever, with Discard as the only exit and its copy giving
    // no hint the text was unrecoverable.
    //
    // The iPad's row is EMPTY (content is only PATCHed at submit), so there is nothing on it to lose and
    // the phone's draft can simply take it over.
    const local = phoneDraft();
    const { decision } = openDoor({
      mode: "author",
      report: emptyRow({ id: "rep-ipad" }),
      local,
    });
    expect(decision.kind).toBe("keep-local");
  });

  it("asks before overwriting a row the other device has already written to", () => {
    const local = phoneDraft();
    const { decision } = openDoor({
      mode: "author",
      report: serverReport({ id: "rep-ipad", status: "draft" }),
      local,
    });
    expect(decision.kind).toBe("conflict");
  });

  it("takes the other device's row wholesale when this phone has typed nothing", () => {
    const untouched = { ...seed(emptyRow(), "author", "draft-phone"), reportId: null, seededFrom: null };
    const { decision } = openDoor({
      mode: "author",
      report: serverReport({ id: "rep-ipad", status: "draft" }),
      local: untouched,
    });
    expect(decision.kind).toBe("reseed");
  });

  it("knows an untouched row from one that has been written to", () => {
    expect(weeklyReportWeekRowIsUntouched(weeklyReportSeedStateFromDetail(emptyRow()))).toBe(true);
    // Content on it — somebody's writing.
    expect(
      weeklyReportWeekRowIsUntouched(weeklyReportSeedStateFromDetail(serverReport({ status: "draft" }))),
    ).toBe(false);
    // Empty, but already submitted: past `draft` it is not this phone's to take over silently.
    expect(
      weeklyReportWeekRowIsUntouched(weeklyReportSeedStateFromDetail(emptyRow({ status: "pending_review" }))),
    ).toBe(false);
    // A single selected photo is enough to make it somebody's work.
    expect(
      weeklyReportWeekRowIsUntouched(
        weeklyReportSeedStateFromDetail(emptyRow({ photos: serverReport().photos.slice(0, 1) })),
      ),
    ).toBe(false);
  });

  it("tells the two 409s that POST /reports can answer apart", () => {
    // "Weekly reporting is paused for this project" is also a 409 and is NOT recoverable by adopting a
    // row. Conflating them would send the wizard hunting for a report that does not exist.
    const taken = Object.assign(new Error("A report already exists for this week"), {
      status: 409,
      code: WEEKLY_REPORT_WEEK_EXISTS_CODE,
    });
    expect(isWeeklyReportWeekTakenError(taken)).toBe(true);
    // An API build that predates the code: the prose is the fallback.
    expect(
      isWeeklyReportWeekTakenError(
        Object.assign(new Error("A report already exists for this week"), { status: 409 }),
      ),
    ).toBe(true);
    expect(
      isWeeklyReportWeekTakenError(
        Object.assign(new Error("Weekly reporting is paused for this project"), { status: 409 }),
      ),
    ).toBe(false);
    expect(isWeeklyReportWeekTakenError(Object.assign(new Error("nope"), { status: 403 }))).toBe(false);
    expect(isWeeklyReportWeekTakenError(new Error("A report already exists for this week"))).toBe(false);
  });

  it("warns, before Discard, that unsent writing is being deleted for good", () => {
    // Discard is this screen's only destructive action and its dialog talked only about imported photos
    // surviving in the gallery — which reads like it is removing a shortcut. That mattered most exactly
    // here, where the 409 used to leave Discard as the only exit.
    const local = phoneDraft();
    expect(
      weeklyReportDiscardWarning({
        seededFrom: local.seededFrom,
        signature: weeklyReportDraftSignature(local),
      }),
    ).toMatch(/not been sent/i);

    // …and stays quiet when the local copy matches what the server already holds, so it is not noise.
    const inStep = seed(serverReport(), "review");
    expect(
      weeklyReportDiscardWarning({
        seededFrom: inStep.seededFrom,
        signature: weeklyReportDraftSignature(inStep),
      }),
    ).toBeNull();
  });

  it("says what happened, that nothing has been sent, and where to go next", () => {
    // The old surface was the raw server sentence on every retry, with a Discard dialog that never said
    // the text was unrecoverable.
    for (const reachable of [true, false]) {
      const message = weeklyReportWeekTakenMessage("Aug 13", reachable);
      expect(message).toContain("Aug 13");
      expect(message).toMatch(/another device/i);
      expect(message).toMatch(/nothing you typed here has been sent/i);
      expect(message).toMatch(/reports/i);
    }
  });
});
