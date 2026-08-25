// Filing a report, as the sequence it is: three writes, a durable marker, and what the NEXT open makes of
// whatever half of it landed.
//
// The pure pieces are covered elsewhere (transition.ts, reconcile.ts, draft.ts). What is covered here is
// that the wizard drives them in order and records what the server said between them — the part that lived
// in a React component nothing executed, where three separate mutations changed no test at all.
//
// The phone below runs the REAL reducer for everything the wizard would dispatch, so "the marker reached
// state" is a claim about storage rather than about a policy re-stated in the test.
//
// KNOWN GAPS, named rather than quietly left (deferred, not refuted):
//
//   • `ensureReport` is STUBBED here — it just returns "rep-1". Its real body lives in
//     app/(app)/reports/weekly/[draftId].tsx (~:287): the idempotent create on `clientSubmissionId`, the
//     week-taken 409 and the hand-off to `adoptWeeklyReportWeekRow`. So is the tail of the submit
//     (~:632): stop autosaves, drain `saveChain`, delete the draft, invalidate the assignments query —
//     an ordering with the same shape as the one this file exists to pin down, and with the same cost
//     (a save queued behind the delete resurrects a report that has already been filed).
//   • Neither is untestable from here. Screens in `app/(app)/` ARE rendered by tests in this repo —
//     src/__tests__/walk-screen-unqueued-walks.test.tsx, src/__tests__/profile-recovery-project-picker
//     .test.tsx, and src/__tests__/reports-hub-concurrent-open.test.tsx, which renders the reports hub
//     itself. Extracting them the way door.ts and submit.ts were extracted is the cheaper route; the
//     render technique is there either way.

import {
  weeklyReportDraftReducer,
  weeklyReportDraftSignature,
  weeklyReportDraftToPatch,
  weeklyReportSeedStateFromDetail,
  type WeeklyReportContentPatch,
  type WeeklyReportDraft,
  type WeeklyReportSeedableReport,
} from "../draft";
import type { WeeklyReportStatusValue } from "../../api/types";
import { openWeeklyReportDoor } from "../door";
import {
  WeeklyReportWeekTakenError,
  weeklyReportReconcile,
} from "../reconcile";
import { weeklyReportFinalAction } from "../status";
import { WeeklyReportOvertakenError } from "../transition";
import { WEEKLY_REPORT_SUBMISSION_DELETED_CODE } from "../reconcile";
import {
  adoptWeeklyReportWeekRow,
  createWeeklyReportWithRenewedSubmission,
  resolveWeeklyReportDraftRow,
  runWeeklyReportSubmit,
  type WeeklyReportSubmitPort,
} from "../submit";
import { ALL_ALLOWED, doorServer, emptyRow, fakeDoorHub, seed, serverReport } from "./fixtures";

function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

/** The row on the server, mutated by the writes exactly as the API mutates it. */
function fakeServer(initial: WeeklyReportSeedableReport) {
  let row = initial;
  return {
    get row() {
      return row;
    },
    patch(patch: {
      workCompleted: string | null;
      nextWeekLookAhead: string | null;
      issuesConcerns: string | null;
      completionPercent: number | null;
      weatherDelayDays: number | null;
    }) {
      row = { ...row, ...patch };
      return row;
    },
    replacePhotos(photos: Array<{ fileId: string; caption: string | null }>) {
      row = {
        ...row,
        photos: photos.map((photo) => ({
          fileId: photo.fileId,
          caption: photo.caption,
          originalDescription: null,
          takenAt: null,
          // Re-signed on every read, which is precisely why it is not in the fingerprint.
          thumbnailUrl: `https://example.test/${photo.fileId}.jpg?sig=fresh`,
        })),
      };
      return row;
    },
    transition(to: WeeklyReportStatusValue) {
      row = { ...row, status: to };
      return to;
    },
  };
}

type Failure = { at: "patch" | "photos" | "transition"; error: unknown };

/**
 * What each write asked the server for, kept alongside the call order.
 *
 * The order was covered and the ARGUMENTS were not, which is half of what submit.ts exists to pin down.
 * A fake that destructures its port arguments to `_id` cannot tell a submit that writes to the report
 * `ensureReport` returned from one that writes to a different row, cannot tell "Submit for PM review"
 * from a silent `approved`, and cannot see a photo payload arrive stripped of its captions or in the
 * wrong order — four mutations that changed nothing in a green run.
 */
type Write =
  | { op: "patch"; reportId: string; patch: WeeklyReportContentPatch }
  | { op: "photos"; reportId: string; photos: Array<{ fileId: string; caption: string | null }> }
  | { op: "transition"; reportId: string; to: WeeklyReportStatusValue };

/**
 * The wizard, reduced to the effects the submit asks it for — with the REAL reducer behind every dispatch,
 * so the marker and the provenance really do have to survive the reducer to be read by the next attempt.
 */
function phone(initial: WeeklyReportDraft, server: ReturnType<typeof fakeServer>) {
  let draft = initial;
  const calls: string[] = [];
  const writes: Write[] = [];
  let failure: Failure | null = null;
  const port: WeeklyReportSubmitPort = {
    ensureReport: async () => {
      calls.push("ensureReport");
      return "rep-1";
    },
    updateContent: async (reportId, patch) => {
      calls.push("patch");
      writes.push({ op: "patch", reportId, patch });
      if (failure?.at === "patch") throw failure.error;
      return server.patch(patch as never);
    },
    replacePhotos: async (reportId, photos) => {
      calls.push("photos");
      writes.push({ op: "photos", reportId, photos });
      if (failure?.at === "photos") throw failure.error;
      return server.replacePhotos(photos);
    },
    recordSeed: (seededFrom) => {
      calls.push("recordSeed");
      draft = weeklyReportDraftReducer(draft, { type: "setSeededFrom", seededFrom });
    },
    markPendingTransition: async (to) => {
      calls.push(`mark:${to ?? "null"}`);
      draft = weeklyReportDraftReducer(draft, { type: "setPendingTransition", to });
    },
    transition: async (reportId, to) => {
      calls.push("transition");
      writes.push({ op: "transition", reportId, to });
      if (failure?.at === "transition") throw failure.error;
      return server.transition(to);
    },
    readStatus: async () => {
      calls.push("readStatus");
      return server.row.status;
    },
    recordStatus: (status) => {
      calls.push("recordStatus");
      draft = weeklyReportDraftReducer(draft, { type: "setServerStatus", status });
    },
  };
  return {
    calls,
    writes,
    get draft() {
      return draft;
    },
    failAt(next: Failure | null) {
      failure = next;
    },
    submit(transitionTo: WeeklyReportStatusValue | null) {
      return runWeeklyReportSubmit(
        { draft, patch: weeklyReportDraftToPatch(draft)!, transitionTo },
        port,
      );
    },
  };
}

/** A superintendent's draft for a week whose (empty) row already exists: text typed, two photos picked. */
function supersDraft(): WeeklyReportDraft {
  let draft = weeklyReportDraftReducer(seed(emptyRow(), "author"), {
    type: "setSection",
    key: "workCompleted",
    value: "Framed levels 3 and 4.",
  });
  for (const [fileId, caption] of [
    ["file-a", "North slab"],
    ["file-b", "Balcony mock-up"],
  ] as const) {
    draft = weeklyReportDraftReducer(draft, {
      type: "addPhoto",
      photo: {
        key: fileId,
        fileId,
        caption,
        originalDescription: null,
        remoteUrl: `https://example.test/${fileId}.jpg?sig=one`,
        localUri: null,
        takenAt: null,
      },
    });
  }
  return draft;
}

/** What the hub would decide on the next open, given the row the server is actually holding. */
function nextOpen(draft: WeeklyReportDraft, row: WeeklyReportSeedableReport) {
  return weeklyReportReconcile({
    mode: draft.mode,
    server: { ...weeklyReportSeedStateFromDetail(row), permissions: ALL_ALLOWED },
    local: { seededFrom: draft.seededFrom, signature: weeklyReportDraftSignature(draft) },
  });
}

describe("a submit that only half landed", () => {
  it("re-stamps the baseline from the PATCH, so the photo PUT dying is not read as a colleague", async () => {
    // THE FINDING. The super types the week up, picks two photos, taps Submit. The PATCH lands and LTE
    // drops before the photo PUT. The server now holds the text and no photos; the phone holds the text
    // AND the photos. Without re-stamping, the baseline still describes the EMPTY row it was seeded from,
    // so the next open sees "I have local edits" and "the server moved" and raises a two-way conflict
    // reading "Somebody else has changed this report since you started it". Nobody else touched it — and
    // "Load theirs", the conscientious answer, drops both photos and their captions.
    const server = fakeServer(emptyRow());
    const wizard = phone(supersDraft(), server);
    wizard.failAt({ at: "photos", error: apiError(0, "Network request failed") });

    await expect(wizard.submit("pending_review")).rejects.toMatchObject({ status: 0 });

    expect(wizard.draft.seededFrom).toEqual(weeklyReportSeedStateFromDetail(server.row));
    expect(server.row.workCompleted).toBe("Framed levels 3 and 4.");
    expect(server.row.photos).toHaveLength(0);
    expect(nextOpen(wizard.draft, server.row).kind).toBe("keep-local");
  });

  it("re-stamps from the photo PUT too, so ONE keystroke after a failed transition is not a conflict", async () => {
    // The variant that defeats the `server.signature === local.signature` shortcut, and the likelier one:
    // both writes land, the transition does not, the banner says try again with a signal, the super fixes
    // a word and comes back. With a stale baseline that single keystroke is enough to raise the same false
    // dialog on the most common retry path there is — which is exactly how people learn to dismiss it
    // unread.
    const server = fakeServer(emptyRow());
    const wizard = phone(supersDraft(), server);
    wizard.failAt({ at: "transition", error: apiError(0, "Network request failed") });

    await expect(wizard.submit("pending_review")).rejects.toMatchObject({ status: 0 });
    expect(server.row.photos).toHaveLength(2);
    expect(wizard.draft.seededFrom).toEqual(weeklyReportSeedStateFromDetail(server.row));

    const corrected = weeklyReportDraftReducer(wizard.draft, {
      type: "setSection",
      key: "workCompleted",
      value: "Framed levels 3 and 4 (east wing).",
    });
    expect(nextOpen(corrected, server.row).kind).toBe("keep-local");
  });

  it("keeps the photos through the hub, rather than offering to delete them", async () => {
    // The same half-submit, taken all the way to the door the user actually taps. The destructive button
    // must not be on screen at all: there is nothing to choose between, and the phone holds the only copy
    // of two photos and their captions.
    const server = fakeServer(emptyRow());
    const wizard = phone(supersDraft(), server);
    wizard.failAt({ at: "photos", error: apiError(0, "Network request failed") });
    await expect(wizard.submit("pending_review")).rejects.toMatchObject({ status: 0 });

    const { port, state } = fakeDoorHub({ server: doorServer(server.row) });
    await openWeeklyReportDoor(
      {
        reportId: "rep-1",
        projectName: "4123 Cedar Springs",
        mode: "author",
        local: wizard.draft,
      },
      port,
    );
    expect(state.prompt).toBeNull();
    expect(state.committed!.photos.map((photo) => photo.fileId)).toEqual(["file-a", "file-b"]);
    expect(state.committed!.photos.map((photo) => photo.caption)).toEqual([
      "North slab",
      "Balcony mock-up",
    ]);
  });
});

describe("the arguments each write carries, not only the order they go in", () => {
  // submit.ts exists to pin down that the wizard calls these ports IN THIS ORDER, WITH THESE ARGUMENTS.
  // The order was held; the arguments were not, and four independent mutations to them changed nothing in
  // a green run. Each one is a silent wrong-write on a document a client keeps as the record of the week,
  // and `mobile/` is neither compiled nor run by CI, so nothing else would have caught any of them.

  it("aims every write at the report ensureReport resolved, and asks for the move the button offered", async () => {
    const server = fakeServer(emptyRow());
    const wizard = phone(supersDraft(), server);
    const outcome = await wizard.submit("pending_review");

    expect(wizard.writes.map((write) => write.op)).toEqual(["patch", "photos", "transition"]);
    // ONE row, and it is the one `ensureReport` resolved — which is the only thing on this path that knows
    // which report this draft is filing. A write aimed anywhere else lands on another week, or another
    // project's week, and the PATCH and the whole-set photo PUT both take it silently.
    expect(wizard.writes.map((write) => write.reportId)).toEqual([
      outcome.reportId,
      outcome.reportId,
      outcome.reportId,
    ]);
    // …and the content really is the draft's, not an empty patch the server would accept just as quietly.
    expect(wizard.writes[0]).toMatchObject({
      op: "patch",
      patch: { workCompleted: "Framed levels 3 and 4." },
    });

    // The move the FINAL BUTTON asked for. A super's "Submit for PM review" that sent `approved` instead
    // is refused for a plain superintendent — but ACCEPTED where the same person is both the assigned
    // super and the PM, and there the week skips review entirely and reaches the client unread by anyone.
    expect(wizard.writes[2]).toEqual({
      op: "transition",
      reportId: outcome.reportId,
      to: "pending_review",
    });
    expect(outcome.status).toBe("pending_review");
    expect(server.row.status).toBe("pending_review");
  });

  it("sends the captions the super typed, in the order they arranged them", async () => {
    // Both halves of the photo payload are client-facing and neither is recoverable from the phone once
    // the whole-set PUT has replaced the set: captions are the only text under each photo on the report
    // the client reads, and the arrangement is the order those photos print in. A payload built from
    // anything but this draft's photos — captions dropped, order reversed — files a report that looks
    // finished and is wrong, and the super has no way to see it from here.
    let draft = supersDraft();
    // The super dragged the balcony shot to the front, so the ARRANGED order is deliberately not the
    // order the photos were picked in — otherwise "in order" and "as they happened to be added" are the
    // same assertion and neither is being tested.
    draft = weeklyReportDraftReducer(draft, { type: "movePhoto", key: "file-b", direction: -1 });
    expect(draft.photos.map((photo) => photo.fileId)).toEqual(["file-b", "file-a"]);

    const server = fakeServer(emptyRow());
    const wizard = phone(draft, server);
    await wizard.submit("pending_review");

    expect(wizard.writes[1]).toEqual({
      op: "photos",
      reportId: "rep-1",
      photos: [
        { fileId: "file-b", caption: "Balcony mock-up" },
        { fileId: "file-a", caption: "North slab" },
      ],
    });
    // And the row the server is left holding says the same thing, which is what the client sees.
    expect(server.row.photos.map((photo) => [photo.fileId, photo.caption])).toEqual([
      ["file-b", "Balcony mock-up"],
      ["file-a", "North slab"],
    ]);
  });
});

describe("the lost-reply marker", () => {
  it("reaches storage BEFORE the transition is fired", async () => {
    // The two attempts it connects are normally separated by a dead connection or an app kill, so a marker
    // written after the request — or not written at all — recovers nothing.
    const server = fakeServer(emptyRow());
    const wizard = phone(supersDraft(), server);
    await wizard.submit("pending_review");
    expect(wizard.calls.indexOf("mark:pending_review")).toBeGreaterThanOrEqual(0);
    expect(wizard.calls.indexOf("mark:pending_review")).toBeLessThan(wizard.calls.indexOf("transition"));
  });

  it("recovers the IN-SESSION retry, where nothing but reducer state carries the marker", async () => {
    // Submit, the transition commits, the reply dies on LTE, and the super taps Submit again in the same
    // session — no app kill, which is the common case. The second attempt's 409 is only legible as "my own
    // reply came back late" if the marker survived in the state this attempt reads.
    const server = fakeServer(emptyRow());
    const wizard = phone(supersDraft(), server);

    wizard.failAt({ at: "transition", error: apiError(0, "Network request failed") });
    await expect(wizard.submit("pending_review")).rejects.toMatchObject({ status: 0 });
    expect(wizard.draft.pendingTransitionTo).toBe("pending_review");

    // The move HAD committed; only the reply was lost.
    server.transition("pending_review");
    wizard.failAt({
      at: "transition",
      error: apiError(409, "A pending_review report cannot move to pending_review"),
    });
    const outcome = await wizard.submit("pending_review");
    expect(outcome.status).toBe("pending_review");
    expect(wizard.draft.serverStatus).toBe("pending_review");
  });

  it("refuses to call SOMEBODY ELSE's transition a success", async () => {
    // No move outstanding, so reaching the target proves nothing this phone did. Reading the 409 as a
    // success here deletes the draft on top of a report whose content this submit has just overwritten.
    const server = fakeServer(serverReport({ status: "pending_review" }));
    const wizard = phone(supersDraft(), server);
    wizard.failAt({
      at: "transition",
      error: apiError(409, "A pending_review report cannot move to pending_review"),
    });
    await expect(wizard.submit("pending_review")).rejects.toBeInstanceOf(WeeklyReportOvertakenError);
    // …and disarmed, so tapping again cannot launder the same 409 either.
    expect(wizard.draft.pendingTransitionTo).toBeNull();
  });

  it("disarms on an answer the server gave definitively", async () => {
    const server = fakeServer(emptyRow());
    const wizard = phone(supersDraft(), server);
    wizard.failAt({ at: "transition", error: apiError(403, "You are not assigned to this project") });
    await expect(wizard.submit("pending_review")).rejects.toMatchObject({ status: 403 });
    expect(wizard.calls).toContain("mark:null");
    expect(wizard.draft.pendingTransitionTo).toBeNull();
  });

  it("records where the report LANDED, never where it was asked to go", async () => {
    // THE ORDERING CLAIM IN submit.ts, as the only thing that can hold it: `recordStatus` runs AFTER the
    // transition resolves, and stamping it any earlier is TERMINAL rather than merely premature.
    //
    // `serverStatus` is the single input `weeklyReportFinalAction` reads. Stamp it with the status this
    // attempt ASKED for and a super whose transition 403s — reassigned off the project mid-draft — or
    // whose transition dies on LTE comes back to a draft that believes it is already in the PM's queue.
    // The final button becomes "Save changes" with `transitionTo: null`, so the retry re-PATCHes the
    // content and never re-fires the move: the report can never be filed from this phone again and the
    // only control left is Discard, which deletes the week for good.
    //
    // Both failure shapes, because they leave by different doors — a definite refusal disarms the marker
    // and an unknown outcome deliberately does not, and neither may leave a status behind.
    for (const error of [
      apiError(403, "You are not assigned to this project"),
      apiError(0, "Network request failed"),
    ]) {
      const server = fakeServer(emptyRow());
      const wizard = phone(supersDraft(), server);
      wizard.failAt({ at: "transition", error });
      await expect(wizard.submit("pending_review")).rejects.toBe(error);

      expect(wizard.calls).not.toContain("recordStatus");
      // Not the asked-for status, and not a guess: the row never moved.
      expect(wizard.draft.serverStatus).toBe("draft");
      expect(server.row.status).toBe("draft");
      // Which is the part that matters: the button the super comes back to still FIRES the transition.
      expect(weeklyReportFinalAction(wizard.draft)).toEqual({
        label: "Submit for PM review",
        transitionTo: "pending_review",
      });
    }
  });

  it("does not arm or fire anything when the report is already where the button would send it", async () => {
    // A PM fixing a caption on an approved report. The ladder has no self-transition, so asking would 409
    // on work that saved perfectly well.
    const server = fakeServer(serverReport({ status: "approved" }));
    const wizard = phone({ ...seed(serverReport({ status: "approved" }), "review") }, server);
    const outcome = await wizard.submit(null);
    expect(outcome.status).toBeNull();
    expect(wizard.calls).toEqual(["ensureReport", "patch", "recordSeed", "photos", "recordSeed"]);
  });
});

describe("adopting the row another device created for this week", () => {
  function adoptPort(input: {
    findServerReportId: () => Promise<string | null>;
    read?: (reportId: string) => Promise<WeeklyReportSeedableReport>;
  }) {
    const adopted: Array<{ reportId: string; signature: string }> = [];
    return {
      adopted,
      port: {
        findServerReportId: input.findServerReportId,
        read:
          input.read ??
          (async () => {
            throw apiError(0, "Network request failed");
          }),
        adopt: (reportId: string, seededFrom: { signature: string }) =>
          adopted.push({ reportId, signature: seededFrom.signature }),
      },
    };
  }

  it("takes over a row that is still EMPTY", async () => {
    const { port, adopted } = adoptPort({
      findServerReportId: async () => "rep-ipad",
      read: async () => emptyRow({ id: "rep-ipad" }),
    });
    await expect(adoptWeeklyReportWeekRow({ weekLabel: "Aug 13" }, port)).resolves.toBe("rep-ipad");
    expect(adopted).toEqual([
      { reportId: "rep-ipad", signature: weeklyReportSeedStateFromDetail(emptyRow()).signature },
    ]);
  });

  it("refuses to PATCH over a row somebody has already written to", async () => {
    // Silent adoption of a row with content on it is the same silent revert this area exists to prevent:
    // this phone's copy would go straight over somebody else's week.
    const { port, adopted } = adoptPort({
      findServerReportId: async () => "rep-ipad",
      read: async () => serverReport({ id: "rep-ipad", status: "draft" }),
    });
    await expect(adoptWeeklyReportWeekRow({ weekLabel: "Aug 13" }, port)).rejects.toThrow(
      /has work on it/i,
    );
    expect(adopted).toEqual([]);
  });

  it("refuses a row that is empty but already SUBMITTED", async () => {
    const { port, adopted } = adoptPort({
      findServerReportId: async () => "rep-ipad",
      read: async () => emptyRow({ id: "rep-ipad", status: "pending_review" }),
    });
    await expect(adoptWeeklyReportWeekRow({ weekLabel: "Aug 13" }, port)).rejects.toBeInstanceOf(
      WeeklyReportWeekTakenError,
    );
    expect(adopted).toEqual([]);
  });

  it("sends the user to the week when the hub names it and this attempt simply could not read it", async () => {
    // KNOWN GAP (deferred, copy-only). `/open that week/i` cannot separate `unreadable` from `has-work`
    // — both sentences contain it — so swapping the outcome at submit.ts:82 survives. The distinction is
    // real (one says a choice is waiting, the other that this attempt could not read the row) but nothing
    // downstream branches on it. Same shape at reconcile.ts:247, where the switch ends in `default:`
    // rather than `case "unlisted":`, so a fourth outcome added later would silently inherit the
    // unlisted copy — which is the one sentence that promises NO route.
    const { port } = adoptPort({ findServerReportId: async () => "rep-ipad" });
    await expect(adoptWeeklyReportWeekRow({ weekLabel: "Aug 13" }, port)).rejects.toThrow(
      /open that week/i,
    );
  });

  it("says the same when the assignments read itself fails — not that the week is unlisted", async () => {
    // Previously this was swallowed into "no id", which produced the copy for a week the hub cannot show.
    // A failed read is a failed read: refreshing is the right advice and makes no claim about the hub.
    const { port } = adoptPort({
      findServerReportId: async () => {
        throw apiError(0, "Network request failed");
      },
    });
    await expect(adoptWeeklyReportWeekRow({ weekLabel: "Aug 13" }, port)).rejects.toThrow(
      /could not read it/i,
    );
  });

  it("does NOT promise a route when the hub has no row for that week at all", async () => {
    // `weeklyReportServerReportId` resolves the current week and the capped outstanding map and nothing
    // else, and the server drops a past week from that map the moment its report moves past `draft`. So
    // "pull down to refresh, then open that week" was a dead end with directions attached.
    const { port } = adoptPort({ findServerReportId: async () => null });
    const error = await adoptWeeklyReportWeekRow({ weekLabel: "Aug 13" }, port).catch((e) => e);
    expect(error).toBeInstanceOf(WeeklyReportWeekTakenError);
    expect(error.message).not.toMatch(/open that week/i);
    expect(error.message).toMatch(/still on this phone/i);
  });
});

describe("creating a report whose submission key the server has retired", () => {
  // THE DEAD END THIS REPLACES: the phone retried a key belonging to a report leadership had deleted,
  // got the same 409 every time, and the only way forward offered was discarding a week's writing.
  function deletedError() {
    return Object.assign(new Error("That report was deleted — start this week again"), {
      status: 409,
      code: WEEKLY_REPORT_SUBMISSION_DELETED_CODE,
    });
  }

  it("mints a fresh key and retries, keeping the caller's draft intact", async () => {
    const seen: string[] = [];
    const renewed: string[] = [];
    const created = await createWeeklyReportWithRenewedSubmission("spent-key", {
      create: async (id) => {
        seen.push(id);
        if (id === "spent-key") throw deletedError();
        return { reportId: "r-new" };
      },
      newClientSubmissionId: () => "fresh-key",
      onRenewed: async (id) => {
        renewed.push(id);
      },
    });

    expect(created).toEqual({ reportId: "r-new" });
    expect(seen).toEqual(["spent-key", "fresh-key"]);
    // The caller is TOLD, so the new key is persisted with the draft. Without this the phone would mint
    // a fresh key on every attempt and lose the idempotency the key exists to provide.
    expect(renewed).toEqual(["fresh-key"]);
  });

  it("does not retry under the replacement key until that key is durable", async () => {
    // This is intentionally a gate, not a callback-spy assertion. Removing `await port.onRenewed(...)`
    // starts the fresh POST while this promise is still held, so this exact test fails before a fake
    // "disk write" has completed.
    const seen: string[] = [];
    const renewed: string[] = [];
    let releaseDurability!: () => void;
    const durable = new Promise<void>((resolve) => {
      releaseDurability = resolve;
    });
    let signalDurabilityStarted!: () => void;
    const durabilityStarted = new Promise<void>((resolve) => {
      signalDurabilityStarted = resolve;
    });

    const created = createWeeklyReportWithRenewedSubmission("spent-key", {
      create: async (id) => {
        seen.push(id);
        if (id === "spent-key") throw deletedError();
        return { reportId: "r-new" };
      },
      newClientSubmissionId: () => "fresh-key",
      onRenewed: async (id) => {
        renewed.push(id);
        signalDurabilityStarted();
        await durable;
      },
    });

    await durabilityStarted;
    expect(renewed).toEqual(["fresh-key"]);
    expect(seen).toEqual(["spent-key"]);

    releaseDurability();
    await expect(created).resolves.toEqual({ reportId: "r-new" });
    expect(seen).toEqual(["spent-key", "fresh-key"]);
  });

  it("does not mint a report under an unpersisted replacement key", async () => {
    const diskFailure = new Error("disk full");
    const seen: string[] = [];

    await expect(
      createWeeklyReportWithRenewedSubmission("spent-key", {
        create: async (id) => {
          seen.push(id);
          if (id === "spent-key") throw deletedError();
          return { reportId: "must-not-create" };
        },
        newClientSubmissionId: () => "fresh-key",
        onRenewed: async () => {
          throw diskFailure;
        },
      }),
    ).rejects.toBe(diskFailure);

    expect(seen).toEqual(["spent-key"]);
  });

  it("retries exactly once, so a server stuck on that answer cannot spin", async () => {
    const seen: string[] = [];
    let n = 0;
    await expect(
      createWeeklyReportWithRenewedSubmission("spent-key", {
        create: async (id) => {
          seen.push(id);
          throw deletedError();
        },
        newClientSubmissionId: () => `fresh-${(n += 1)}`,
        onRenewed: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: WEEKLY_REPORT_SUBMISSION_DELETED_CODE });
    expect(seen).toHaveLength(2);
  });

  it("leaves every other failure alone, including the week-taken conflict", async () => {
    // The week-taken 409 has its own recovery — adopting the row somebody else made — and swallowing it
    // here would take the phone off that path.
    const taken = Object.assign(new Error("A report already exists for this week"), {
      status: 409,
      code: "WEEKLY_REPORT_WEEK_EXISTS",
    });
    const seen: string[] = [];
    await expect(
      createWeeklyReportWithRenewedSubmission("key", {
        create: async (id) => {
          seen.push(id);
          throw taken;
        },
        newClientSubmissionId: () => "unused",
        onRenewed: async () => undefined,
      }),
    ).rejects.toBe(taken);
    expect(seen).toEqual(["key"]);
  });
});

describe("resolving a draft which already holds a report id", () => {
  it("renews a deleted stored report id durably before creating its replacement", async () => {
    // A phone can reach Photos, persist reportId, and then have leadership delete that row. The previous
    // short-circuit returned the old id forever, so every later PATCH and photo PUT 404'd and the retired
    // key could never get to its recovery path.
    const calls: string[] = [];
    let releaseDurability!: () => void;
    const durable = new Promise<void>((resolve) => {
      releaseDurability = resolve;
    });
    let signalDurabilityStarted!: () => void;
    const durabilityStarted = new Promise<void>((resolve) => {
      signalDurabilityStarted = resolve;
    });

    const result = resolveWeeklyReportDraftRow(
      { reportId: "deleted-report", clientSubmissionId: "spent-key" },
      {
        read: async (id) => {
          calls.push(`read:${id}`);
          throw apiError(404, "Weekly report not found");
        },
        create: async (id) => {
          calls.push(`create:${id}`);
          return { reportId: "replacement-report" };
        },
        newClientSubmissionId: () => "fresh-key",
        onRenewed: async (id) => {
          calls.push(`persist:${id}`);
          signalDurabilityStarted();
          await durable;
        },
      },
    );

    await durabilityStarted;
    expect(calls).toEqual(["read:deleted-report", "persist:fresh-key"]);

    releaseDurability();
    await expect(result).resolves.toEqual({ kind: "created", created: { reportId: "replacement-report" } });
    expect(calls).toEqual(["read:deleted-report", "persist:fresh-key", "create:fresh-key"]);
  });

  it("uses an existing stored row without minting or persisting a replacement key", async () => {
    const read = jest.fn(async () => ({ id: "live-report" }));
    const create = jest.fn(async () => ({ reportId: "must-not-create" }));
    const newClientSubmissionId = jest.fn(() => "must-not-mint");
    const onRenewed = jest.fn(async () => undefined);

    await expect(
      resolveWeeklyReportDraftRow(
        { reportId: "live-report", clientSubmissionId: "live-key" },
        { read, create, newClientSubmissionId, onRenewed },
      ),
    ).resolves.toEqual({ kind: "existing", reportId: "live-report" });

    expect(read).toHaveBeenCalledWith("live-report");
    expect(create).not.toHaveBeenCalled();
    expect(newClientSubmissionId).not.toHaveBeenCalled();
    expect(onRenewed).not.toHaveBeenCalled();
  });

  it("does not turn an uncertain read failure into a second report", async () => {
    const offline = apiError(0, "Network request failed");
    const create = jest.fn(async () => ({ reportId: "must-not-create" }));
    const onRenewed = jest.fn(async () => undefined);

    await expect(
      resolveWeeklyReportDraftRow(
        { reportId: "possibly-live-report", clientSubmissionId: "live-key" },
        {
          read: async () => {
            throw offline;
          },
          create,
          newClientSubmissionId: () => "must-not-mint",
          onRenewed,
        },
      ),
    ).rejects.toBe(offline);

    expect(create).not.toHaveBeenCalled();
    expect(onRenewed).not.toHaveBeenCalled();
  });
});
