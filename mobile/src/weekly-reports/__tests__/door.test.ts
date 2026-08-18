// The hub's one door onto a report the server knows about, driven end to end.
//
// These are the cases that lived inside a React component nobody's test ever rendered. `mobile/` is not in
// CI and this app has no OTA, so the difference between "the decision module is right" and "the screen
// calls it" is the difference between a correct app and a wrong one on somebody's phone for a week.
//
// Every test here runs the WHOLE sequence — read, reconcile, write — against a fake screen, and several of
// them run it two and three times over, because the failures in this area are all about what the SECOND
// and THIRD open conclude from the first.

import { WEEKLY_REPORT_EMPTY_SIGNATURE, weeklyReportDraftReducer } from "../draft";
import { WEEKLY_REPORT_REFUSAL_READ_PATH, openWeeklyReportDoor } from "../door";
import { weeklyReportFinalAction } from "../status";
import {
  doorServer as ok,
  emptyRow,
  fakeDoorHub as hub,
  seed,
  serverReport,
} from "./fixtures";

describe("the refusal gate, as the screen applies it", () => {
  it("opens NOTHING on a review report that has gone back to the superintendent", async () => {
    // THE COST OF SKIPPING THIS. A PM opens a bounced-back report in review mode, works through it, and
    // taps Approve: the content PATCH lands, the WHOLE-SET photo PUT lands on top of the superintendent's
    // rewrite, and only then does the illegal draft -> approved 409. The transition fails; the mutations
    // stick. The decision module has always been right about this — nothing checked that the screen
    // honoured it.
    const { port, state } = hub({
      server: ok(serverReport({ status: "draft" }), { canEdit: true, canApprove: false }),
    });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "review", local: null },
      port,
    );
    expect(state.events).toEqual(["read", "refuse"]);
    expect(state.refusal!.message).toMatch(/back to the superintendent/i);
    expect(state.committed).toBeNull();
    expect(state.opened).toBeNull();
  });

  it("refuses a sent report even when a local draft names it", async () => {
    const local = seed(serverReport(), "review");
    const { port, state } = hub({
      server: ok(serverReport({ status: "sent" }), { canEdit: false, canApprove: false }),
    });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "review", local },
      port,
    );
    expect(state.committed).toBeNull();
    expect(state.opened).toBeNull();
  });

  it("leaves a READ PATH to unsent writing the owner can no longer file", async () => {
    // THE FINDING. A superintendent has an author draft with a paragraph the server has never seen.
    // Somebody else files that week and the PM approves it — so `canEdit` is now PM-only and this door
    // refuses. The project card reads "waiting", so there is no second way in; refreshing changes nothing;
    // and the ONLY working control left is Discard, whose warning correctly says the writing is deleted
    // for good. The refusal has to hand back something that can still be opened and read.
    const local = weeklyReportDraftReducer(seed(emptyRow(), "author"), {
      type: "setSection",
      key: "workCompleted",
      value: "Framed levels 3 and 4. Roof drain rough-in complete.",
    });
    const { port, state } = hub({
      server: ok(serverReport({ status: "approved" }), { canEdit: false, canApprove: false }),
    });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "author", local },
      port,
    );
    expect(state.refusal!.localCopy).toBe(local);
    expect(state.refusal!.message).toContain(WEEKLY_REPORT_REFUSAL_READ_PATH);
    // Offered, not taken: nothing is opened or written until the user asks for it.
    expect(state.committed).toBeNull();
    expect(state.opened).toBeNull();
  });

  it("offers NO read path onto a bounced-back report, however much is unsent on the phone", async () => {
    // The read path is only safe where the server refuses every write. On a bounced-back report the PM
    // still has `canEdit`, so the wizard it would open is a LIVE one — its final tap PATCHes the content
    // and REPLACES the photo set over the superintendent's rewrite before the illegal draft -> approved
    // 409s, and those mutations stick. Reopening that door for readability would put the gate's own
    // failure back. Nothing is lost by refusing: the project card offers this same week in AUTHOR mode,
    // which the gate deliberately allows.
    const local = weeklyReportDraftReducer(seed(serverReport({ status: "draft" }), "review"), {
      type: "setSection",
      key: "issuesConcerns",
      value: "Client wants the balcony detail revisited.",
    });
    const { port, state } = hub({
      server: ok(serverReport({ status: "draft" }), { canEdit: true, canApprove: false }),
    });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "review", local },
      port,
    );
    expect(state.refusal!.localCopy).toBeNull();
    expect(state.refusal!.message).not.toContain(WEEKLY_REPORT_REFUSAL_READ_PATH);
    expect(state.opened).toBeNull();
    expect(state.committed).toBeNull();
  });

  it("gates on the mode THIS DOOR was opened in, not the one the local draft was saved in", async () => {
    // THE HOLE THE GATE ABOVE CANNOT SEE ON ITS OWN. Every other case here hands the door either no local
    // draft or one whose mode already equals the requested mode, so reading `input.local.mode` instead of
    // `input.mode` passes all of them — and that substitution silently switches the gate off exactly where
    // it is load-bearing.
    //
    // The sequence, all of it ordinary. The PM taps "Open week of Aug 13" while the report is still
    // `draft`; `weeklyReportProjectAction` returns `{kind:"resume", mode:"author"}`, so an AUTHOR-mode
    // draft naming this report is committed to disk. The superintendent submits it, it lands in the PM's
    // queue, the PM sends it back for changes. The PM then taps the STALE queue row, which routes through
    // `openForReview` → mode "review" with no `localDraftId`, so `local` resolves by reportId to that
    // author draft. Reconcile the review door against "author" and `weeklyReportOpenRefusal`'s
    // review + draft clause never fires: the report opens in review mode on a button reading "Approve
    // report", whose tap PATCHes the content and REPLACES the whole photo set over the superintendent's
    // rewrite before the illegal draft → approved 409s. The transition fails; the mutations stick.
    const authorDraft = weeklyReportDraftReducer(seed(serverReport({ status: "draft" }), "author"), {
      type: "setSection",
      key: "workCompleted",
      value: "Poured the north slab. Stripped forms Friday.",
    });
    expect(authorDraft.mode).toBe("author");
    const { port, state } = hub({
      // Bounced back: still `draft`, and a PM keeps `canEdit` here — which is the whole reason an
      // edit-rights check alone is not the gate.
      server: ok(serverReport({ status: "draft" }), { canEdit: true, canApprove: false }),
    });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "review", local: authorDraft },
      port,
    );
    expect(state.events).toEqual(["read", "refuse"]);
    expect(state.refusal!.message).toMatch(/back to the superintendent/i);
    expect(state.committed).toBeNull();
    expect(state.opened).toBeNull();
  });

  it("offers no read path when the local copy holds nothing the server has not got", async () => {
    // A warning that cried wolf here would be ignored where it counts. This draft matches the report it
    // was seeded from, so there is nothing on the phone to salvage.
    const local = seed(serverReport(), "review");
    const { port, state } = hub({
      server: ok(serverReport({ status: "sent" }), { canEdit: false, canApprove: false }),
    });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "review", local },
      port,
    );
    expect(state.refusal!.localCopy).toBeNull();
    expect(state.refusal!.message).not.toContain(WEEKLY_REPORT_REFUSAL_READ_PATH);
  });
});

describe("what the door writes", () => {
  it("re-stamps the kept draft with the SERVER's seed, so the same conflict is not re-asked for ever", async () => {
    // THE FINDING, as the only sequence that can show it: THREE opens. A PM edits a review draft; somebody
    // else changes the report once; the PM is asked and keeps their version. If the kept draft carries its
    // OLD baseline forward, the third open compares against a state the server left long ago and raises
    // the identical conflict — on every open, for ever, until somebody answers it destructively. That is
    // the "prompt nobody reads" failure the whole module was written against.
    const original = serverReport();
    const moved = serverReport({ workCompleted: "Poured the north slab. Stripped forms Friday." });

    // Open 1: nothing local, so the draft is seeded from the report.
    const first = hub({ server: ok(original) });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "review", local: null },
      first.port,
    );
    const edited = weeklyReportDraftReducer(first.state.committed!, {
      type: "setSection",
      key: "issuesConcerns",
      value: "Permit for the east elevation is still with the city.",
    });

    // Open 2: both sides have moved. Asked, and the PM keeps their version.
    const second = hub({ server: ok(moved), answer: "keep-local" });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "review", local: edited },
      second.port,
    );
    expect(second.state.events).toEqual(["read", "choose", "commit"]);
    const kept = second.state.committed!;
    expect(kept.issuesConcerns).toBe("Permit for the east elevation is still with the city.");

    // Open 3: nothing has changed on the server since. There is nothing left to ask about.
    const third = hub({ server: ok(moved) });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "review", local: kept },
      third.port,
    );
    expect(third.state.prompt).toBeNull();
    expect(third.state.committed!.issuesConcerns).toBe(
      "Permit for the east elevation is still with the city.",
    );
  });

  it("writes NOTHING until the conflict has been answered", async () => {
    // Committing first and correcting afterwards makes the prompt decorative: every conflict silently
    // resolves to one side and the dialog is a receipt rather than a question.
    const local = weeklyReportDraftReducer(seed(serverReport(), "review"), {
      type: "setSection",
      key: "issuesConcerns",
      value: "Client wants the balcony detail revisited.",
    });
    const { port, state } = hub({
      server: ok(serverReport({ workCompleted: "Poured the north slab. Balcony reworked per RFI 14." })),
      answer: "cancel",
    });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "review", local },
      port,
    );
    expect(state.events).toEqual(["read", "choose"]);
    expect(state.committed).toBeNull();
    expect(state.opened).toBeNull();
  });

  it("takes the server's copy when that is what the user chose", async () => {
    const local = weeklyReportDraftReducer(seed(serverReport(), "review"), {
      type: "setSection",
      key: "issuesConcerns",
      value: "Client wants the balcony detail revisited.",
    });
    const moved = serverReport({ workCompleted: "Poured the north slab. Balcony reworked per RFI 14." });
    const { port, state } = hub({ server: ok(moved), answer: "use-server" });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "review", local },
      port,
    );
    expect(state.committed!.workCompleted).toContain("RFI 14");
    expect(state.committed!.issuesConcerns).toBe("");
    // Same draft id, so this OVERWRITES the local row rather than leaving two drafts for one report.
    expect(state.committed!.id).toBe(local.id);
  });

  it("keeps a local draft that adopted another device's EMPTY row, and re-stamps it", async () => {
    // The phone typed a whole report without reaching the photos step, so it holds no report id. The iPad
    // reached that step for the same week and created the row. That row is empty, so there is nothing on
    // it to lose — but the draft must come away knowing which row it now is, and what that row held.
    const phone = weeklyReportDraftReducer(
      { ...seed(emptyRow(), "author", "draft-phone"), reportId: null, seededFrom: null },
      { type: "setSection", key: "workCompleted", value: "Framed levels 3 and 4." },
    );
    const { port, state } = hub({ server: ok(emptyRow({ id: "rep-ipad" })) });
    await openWeeklyReportDoor(
      { reportId: "rep-ipad", projectName: "4123 Cedar Springs", mode: "author", local: phone },
      port,
    );
    expect(state.committed).toMatchObject({
      id: "draft-phone",
      reportId: "rep-ipad",
      workCompleted: "Framed levels 3 and 4.",
      serverStatus: "draft",
    });
    // Stamped with what the SERVER held — an EMPTY row — not with what the phone holds. The phone's
    // paragraph is still an unsent local edit, and a baseline that already described it would make the
    // next open believe the server had it.
    expect(state.committed!.seededFrom).toEqual({
      status: "draft",
      signature: WEEKLY_REPORT_EMPTY_SIGNATURE,
    });
  });

  it("re-stamps the kept draft's MODE and STATUS from this door and this read, not from itself", async () => {
    // The companion to the gate above, and the case the EMPTY-row test cannot express: there `input.local`
    // already holds the same mode and the same status the door would stamp, so `toMatchObject` cannot tell
    // which of the two sources produced them. Here they differ on both axes.
    //
    // A one-person job — the assignment payload marks the same user `isSuper` AND `isPm`. They typed the
    // week on their phone (AUTHOR draft, seeded while the row was still `draft`), submitted it from the
    // iPad, then came back to the phone and opened the report from their own review queue. Keep my version
    // must leave a draft that knows it is now a REVIEW of a report sitting in `pending_review`: carry the
    // draft's own `mode` forward and the final button reads "Submit for PM review" on a report already in
    // review, which the ladder has no self-transition for — it 409s, for the rest of that draft's life.
    const local = weeklyReportDraftReducer(seed(serverReport({ status: "draft" }), "author"), {
      type: "setSection",
      key: "issuesConcerns",
      value: "Permit for the east elevation is still with the city.",
    });
    expect(local.mode).toBe("author");
    expect(local.serverStatus).toBe("draft");

    const submitted = serverReport({
      status: "pending_review",
      workCompleted: "Poured the north slab. Stripped forms Friday.",
    });
    const { port, state } = hub({ server: ok(submitted), answer: "keep-local" });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "review", local },
      port,
    );

    const kept = state.committed!;
    expect(kept.issuesConcerns).toBe("Permit for the east elevation is still with the city.");
    expect(kept.mode).toBe("review");
    expect(kept.serverStatus).toBe("pending_review");
    // Which is the whole point of both re-stamps: the button at the end of the wizard.
    expect(weeklyReportFinalAction(kept)).toEqual({
      label: "Approve report",
      transitionTo: "approved",
    });
    // And the question they were asked was the REVIEWER's question, because this door is a review door
    // whatever mode the draft on disk was saved in.
    expect(state.prompt!.message).toMatch(/since you started reviewing it/i);
  });

  it("reseeds from the server when the local draft holds nothing of its own", async () => {
    const stale = seed(emptyRow(), "author");
    const submitted = serverReport({ status: "pending_review", issuesConcerns: "Rebar slipped a week." });
    const { port, state } = hub({ server: ok(submitted) });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "review", local: stale },
      port,
    );
    expect(state.prompt).toBeNull();
    expect(state.committed!.issuesConcerns).toBe("Rebar slipped a week.");
    expect(state.committed!.mode).toBe("review");
  });
});

describe("when the read fails", () => {
  it("opens the local copy UNCHANGED rather than locking somebody out on a jobsite", async () => {
    const local = seed(serverReport(), "author");
    const { port, state } = hub({ server: { fails: true } });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "author", local },
      port,
    );
    expect(state.events).toEqual(["read", "open"]);
    // Opened, never written: this branch has learned nothing about the server, so it may not restamp
    // anything — a baseline invented here would make the NEXT open, the one with a signal, wrong.
    expect(state.committed).toBeNull();
    expect(state.opened).toBe(local);
  });

  it("says so when there is no local copy to fall back on", async () => {
    const { port, state } = hub({ server: { fails: true } });
    await openWeeklyReportDoor(
      { reportId: "rep-1", projectName: "4123 Cedar Springs", mode: "review", local: null },
      port,
    );
    expect(state.unavailable).toBe(true);
    expect(state.opened).toBeNull();
  });
});
