// Filing a report, as the sequence it is: three writes, a durable marker, and what the NEXT open makes of
// whatever half of it landed.
//
// The pure pieces are covered elsewhere (transition.ts, reconcile.ts, draft.ts). What is covered here is
// that the wizard drives them in order and records what the server said between them — the part that lived
// in a React component nothing executed, where three separate mutations changed no test at all.
//
// The phone below runs the REAL reducer for everything the wizard would dispatch, so "the marker reached
// state" is a claim about storage rather than about a policy re-stated in the test.

import {
  weeklyReportDraftReducer,
  weeklyReportDraftSignature,
  weeklyReportDraftToPatch,
  weeklyReportSeedStateFromDetail,
  type WeeklyReportDraft,
  type WeeklyReportSeedableReport,
} from "../draft";
import type { WeeklyReportStatusValue } from "../../api/types";
import { openWeeklyReportDoor } from "../door";
import {
  WeeklyReportWeekTakenError,
  weeklyReportReconcile,
} from "../reconcile";
import { WeeklyReportOvertakenError } from "../transition";
import { adoptWeeklyReportWeekRow, runWeeklyReportSubmit, type WeeklyReportSubmitPort } from "../submit";
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
 * The wizard, reduced to the effects the submit asks it for — with the REAL reducer behind every dispatch,
 * so the marker and the provenance really do have to survive the reducer to be read by the next attempt.
 */
function phone(initial: WeeklyReportDraft, server: ReturnType<typeof fakeServer>) {
  let draft = initial;
  const calls: string[] = [];
  let failure: Failure | null = null;
  const port: WeeklyReportSubmitPort = {
    ensureReport: async () => {
      calls.push("ensureReport");
      return "rep-1";
    },
    updateContent: async (_id, patch) => {
      calls.push("patch");
      if (failure?.at === "patch") throw failure.error;
      return server.patch(patch as never);
    },
    replacePhotos: async (_id, photos) => {
      calls.push("photos");
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
    transition: async (_id, to) => {
      calls.push("transition");
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
