// The two decisions the Reports screens make that are not visible in any payload: which door into the
// wizard a tapped week opens, and what a refused transition means.
//
// Both used to live inline in `app/(app)/reports/*`, where nothing tested them — every other suite in
// `mobile/` is a pure-module test, and these are exactly the ordering- and freshness-sensitive rules a
// screen is the worst place to keep. They are modules now, so they are checked here.

import {
  weeklyReportOpenTarget,
  weeklyReportServerReportId,
  type WeeklyReportHubDraft,
  type WeeklyReportHubProject,
} from "../hub";
import {
  WeeklyReportOvertakenError,
  transitionWeeklyReportIdempotently,
  weeklyReportStatusReached,
  weeklyReportTransitionOutcomeUnknown,
} from "../transition";
import type { WeeklyReportStatusValue } from "../../api/types";

const PROJECT: WeeklyReportHubProject = {
  weeklyReportProjectId: "wrp-1",
  currentWeekOf: "2026-08-13",
  currentReportId: null,
  outstandingWeekReportIds: {},
};

function localDraft(overrides: Partial<WeeklyReportHubDraft> = {}): WeeklyReportHubDraft {
  return {
    id: "draft-1",
    weeklyReportProjectId: "wrp-1",
    weekOf: "2026-08-13",
    mode: "author",
    reportId: null,
    ...overrides,
  };
}

/** An ApiError as the app's fetcher throws it: a numeric `status` plus the server's message. */
function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

describe("which report id a week carries", () => {
  it("uses the current week's own id", () => {
    expect(
      weeklyReportServerReportId({ ...PROJECT, currentReportId: "rep-current" }, "2026-08-13"),
    ).toBe("rep-current");
  });

  it("resolves an OUTSTANDING week's id from the map, not from the current week's", () => {
    // The bug this closes: the hub passed null for every outstanding week. A missed week whose row
    // already existed could then only be re-created, and once the local draft was gone the week was
    // unreachable from the phone entirely — no card, not in the PM's queue, off `outstandingWeeks`.
    const project = {
      ...PROJECT,
      currentReportId: "rep-current",
      outstandingWeekReportIds: { "2026-07-30": "rep-missed" },
    };
    expect(weeklyReportServerReportId(project, "2026-07-30")).toBe("rep-missed");
    expect(weeklyReportServerReportId(project, "2026-07-23")).toBeNull();
  });

  it("treats an older API build with no map as every week starting fresh", () => {
    const project = { ...PROJECT, outstandingWeekReportIds: undefined };
    expect(weeklyReportServerReportId(project, "2026-07-30")).toBeNull();
  });
});

describe("which door a tapped week opens", () => {
  it("reconciles a REVIEW draft against the server, however fresh the local copy looks", () => {
    // A stale review draft replays a PATCH of explicit nulls and a whole-set photo PUT over work the
    // superintendent rewrote after it was bounced back. The PM then approves something other than what
    // they just read. Every entry point has to come through the re-read.
    const target = weeklyReportOpenTarget({
      project: PROJECT,
      weekOf: "2026-08-13",
      drafts: [localDraft({ mode: "review", reportId: "rep-1" })],
    });
    expect(target).toEqual({ kind: "reconcile", reportId: "rep-1", draftId: "draft-1" });
  });

  it("reconciles an AUTHOR draft that names a report too — mode is not a freshness property", () => {
    // The gate used to read `local.mode === "review"`, so THIS draft skipped the server read entirely.
    // The chain that made that a silent revert: a PM taps "Open week of Aug 13" on a `draft` report,
    // which seeds an AUTHOR-mode draft and saves it; they back out; the super finishes the week and
    // submits; the PM taps "Review week of Aug 13", the local draft is found, its mode is `author`, and
    // it opens with no server read. Its submit then PATCHes the PM's stale text and PUTs the PM's stale
    // photo set over the super's submitted report.
    const target = weeklyReportOpenTarget({
      project: { ...PROJECT, currentReportId: "rep-1" },
      weekOf: "2026-08-13",
      drafts: [localDraft({ id: "draft-9", mode: "author", reportId: "rep-1" })],
    });
    expect(target).toEqual({ kind: "reconcile", reportId: "rep-1", draftId: "draft-9" });
  });

  it("resumes a purely LOCAL draft from disk, never from the server", () => {
    // The one draft that must not be re-read: no row exists anywhere for this week, so the draft may hold
    // a section typed on a jobsite with no signal that only this phone has.
    const target = weeklyReportOpenTarget({
      project: PROJECT,
      weekOf: "2026-08-13",
      drafts: [localDraft({ id: "draft-9" })],
    });
    expect(target).toEqual({ kind: "resume-local", draftId: "draft-9" });
  });

  it("reconciles a local draft whose week has acquired a row from ANOTHER DEVICE", () => {
    // The phone typed the whole report but never reached the photos step, so it holds no report id. The
    // iPad reached that step for the same week and created the row under ITS submission id. Resuming the
    // phone's draft as-is leaves it posting a create that answers 409 "A report already exists for this
    // week" on every retry, with Discard as the only exit — so the week has to be reconciled instead.
    const target = weeklyReportOpenTarget({
      project: { ...PROJECT, currentReportId: "rep-ipad" },
      weekOf: "2026-08-13",
      drafts: [localDraft({ id: "draft-9", reportId: null })],
    });
    expect(target).toEqual({ kind: "reconcile", reportId: "rep-ipad", draftId: "draft-9" });
  });

  it("still resumes locally when a review draft has no report id and the server has no row either", () => {
    const target = weeklyReportOpenTarget({
      project: PROJECT,
      weekOf: "2026-08-13",
      drafts: [localDraft({ mode: "review", reportId: null })],
    });
    expect(target).toEqual({ kind: "resume-local", draftId: "draft-1" });
  });

  it("ignores a local draft for a DIFFERENT week or a different project", () => {
    const target = weeklyReportOpenTarget({
      project: PROJECT,
      weekOf: "2026-08-13",
      drafts: [
        localDraft({ id: "other-week", weekOf: "2026-08-06" }),
        localDraft({ id: "other-project", weeklyReportProjectId: "wrp-2" }),
      ],
    });
    expect(target).toEqual({ kind: "create-local" });
  });

  it("reconciles the SERVER's row for a missed week that already has one", () => {
    const target = weeklyReportOpenTarget({
      project: { ...PROJECT, outstandingWeekReportIds: { "2026-07-30": "rep-missed" } },
      weekOf: "2026-07-30",
      drafts: [],
    });
    expect(target).toEqual({ kind: "reconcile", reportId: "rep-missed", draftId: null });
  });

  it("creates a fresh local draft when neither side has anything", () => {
    expect(weeklyReportOpenTarget({ project: PROJECT, weekOf: "2026-07-30", drafts: [] })).toEqual({
      kind: "create-local",
    });
  });
});

describe("has the report reached the state we asked for", () => {
  it("counts an exact match and anything past it", () => {
    expect(weeklyReportStatusReached("pending_review", "pending_review")).toBe(true);
    // The PM approved while the response was in flight. The submit still succeeded.
    expect(weeklyReportStatusReached("approved", "pending_review")).toBe(true);
    expect(weeklyReportStatusReached("sent", "pending_review")).toBe(true);
  });

  it("does not count a report that is still short of it", () => {
    expect(weeklyReportStatusReached("draft", "pending_review")).toBe(false);
    expect(weeklyReportStatusReached("pending_review", "approved")).toBe(false);
  });

  it("refuses to read an unknown or absent status as success", () => {
    expect(weeklyReportStatusReached(null, "pending_review")).toBe(false);
    expect(weeklyReportStatusReached("archived" as never, "pending_review")).toBe(false);
  });
});

/**
 * The wizard's submit, as a sequence: it reads the persisted marker, arms it before firing, and clears it
 * again on a failure the server answered definitively. Modelled here rather than asserted one call at a
 * time, because every bug in this area is about what the SECOND attempt concludes from the first.
 */
function submitter(initialMarker: WeeklyReportStatusValue | null = null) {
  let marker = initialMarker;
  return {
    get marker() {
      return marker;
    },
    async submit(input: {
      to: WeeklyReportStatusValue;
      transition: () => Promise<WeeklyReportStatusValue>;
      readStatus: () => Promise<WeeklyReportStatusValue | null | undefined>;
    }) {
      const mayHaveCommitted = marker === input.to;
      if (!mayHaveCommitted) marker = input.to;
      try {
        return await transitionWeeklyReportIdempotently({ ...input, mayHaveCommitted });
      } catch (error) {
        if (!weeklyReportTransitionOutcomeUnknown(error)) marker = null;
        throw error;
      }
    },
  };
}

describe("filing a report when the response was lost", () => {
  it("passes the server's answer straight through when the transition succeeds", async () => {
    const outcome = await transitionWeeklyReportIdempotently({
      to: "pending_review",
      mayHaveCommitted: false,
      transition: async () => "pending_review",
      readStatus: async () => {
        throw new Error("must not be consulted on success");
      },
    });
    expect(outcome).toEqual({ status: "pending_review", alreadyThere: false });
  });

  it("recovers the submit whose reply was lost — but only across TWO attempts", async () => {
    // THE BUG THIS MODULE EXISTS FOR. The transition commits, the reply is lost on jobsite LTE, the wizard
    // catches and never records the new status. The retry's PATCH and photo PUT land (the author may still
    // edit at pending_review) and the transition answers 409 "A pending_review report cannot move to
    // pending_review" — verbatim, forever. The report was filed; the phone insisted it had failed, the
    // draft never cleared, and the only exit was a Discard dialog that reads like it destroys the report.
    //
    // Written as the sequence because the marker is what makes the second attempt's 409 legible, and a
    // one-call assertion would pass just as happily with the marker ignored.
    const phone = submitter();
    await expect(
      phone.submit({
        to: "pending_review",
        transition: async () => {
          throw apiError(0, "Network request failed");
        },
        readStatus: async () => "pending_review",
      }),
    ).rejects.toMatchObject({ status: 0 });
    // The connection died with the request in flight, so the marker STAYS: the move may well have landed.
    expect(phone.marker).toBe("pending_review");

    const outcome = await phone.submit({
      to: "pending_review",
      transition: async () => {
        throw apiError(409, "A pending_review report cannot move to pending_review");
      },
      readStatus: async () => "pending_review",
    });
    expect(outcome).toEqual({ status: "pending_review", alreadyThere: true });
  });

  it("accepts a report that moved PAST the target while this client's response was in flight", async () => {
    const phone = submitter("pending_review");
    const outcome = await phone.submit({
      to: "pending_review",
      transition: async () => {
        throw apiError(409, "An approved report cannot move to pending_review");
      },
      readStatus: async () => "approved",
    });
    expect(outcome).toEqual({ status: "approved", alreadyThere: true });
  });

  it("refuses to call SOMEBODY ELSE's transition a success", async () => {
    // The finding, end to end. A PM holds a stale local draft of a report the SUPERINTENDENT has since
    // submitted. The wizard PATCHes the PM's older text and PUTs the PM's older photo set over it, then
    // asks for draft -> pending_review. The report is already there, so the server answers 409 and a
    // re-read confirms `pending_review` — which the old rule read as "my move landed": success, draft
    // deleted, no banner, the super's narrative and photo set silently reverted.
    //
    // This client has no transition outstanding, so reaching the target is not evidence of anything it
    // did. Note the failure is NOT the raw 409: the content writes really did land on top of somebody
    // else's work, and the copy has to say so.
    const phone = submitter();
    await expect(
      phone.submit({
        to: "pending_review",
        transition: async () => {
          throw apiError(409, "A pending_review report cannot move to pending_review");
        },
        readStatus: async () => "pending_review",
      }),
    ).rejects.toBeInstanceOf(WeeklyReportOvertakenError);
    // And the marker is cleared, so tapping again cannot launder the same 409 into a success either.
    expect(phone.marker).toBeNull();
  });

  it("does not let a DEFINITELY refused attempt arm the recovery for the next one", async () => {
    // A 403 is the server saying the move did not happen. If the marker survived it, the next 409 — which
    // by then can only be somebody else's move — would be read as this client's lost reply.
    const phone = submitter();
    await expect(
      phone.submit({
        to: "pending_review",
        transition: async () => {
          throw apiError(403, "You are not assigned to this project");
        },
        readStatus: async () => "pending_review",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(phone.marker).toBeNull();

    await expect(
      phone.submit({
        to: "pending_review",
        transition: async () => {
          throw apiError(409, "A pending_review report cannot move to pending_review");
        },
        readStatus: async () => "pending_review",
      }),
    ).rejects.toBeInstanceOf(WeeklyReportOvertakenError);
  });

  it("rethrows a 409 on a report that has NOT reached the target", async () => {
    // "This report changed while you were working on it" on a report still in draft is a real conflict:
    // nothing was filed, and swallowing it would delete the local draft with the work still unsent.
    const error = apiError(409, "This report changed while you were working on it — reload and try again");
    for (const mayHaveCommitted of [true, false]) {
      await expect(
        transitionWeeklyReportIdempotently({
          to: "pending_review",
          mayHaveCommitted,
          transition: async () => {
            throw error;
          },
          readStatus: async () => "draft",
        }),
      ).rejects.toBe(error);
    }
  });

  it("never re-reads on a failure that is not a 409", async () => {
    // A 403 is a permission answer, a 400 a validation answer, and an ApiError(0) means the request may
    // never have arrived. None of those can be resolved by asking where the report is.
    for (const status of [0, 400, 403, 408, 500]) {
      const error = apiError(status, "nope");
      let consulted = false;
      await expect(
        transitionWeeklyReportIdempotently({
          to: "pending_review",
          mayHaveCommitted: true,
          transition: async () => {
            throw error;
          },
          readStatus: async () => {
            consulted = true;
            return "pending_review";
          },
        }),
      ).rejects.toBe(error);
      expect(consulted).toBe(false);
    }
  });

  it("rethrows the ORIGINAL 409 when the re-read itself fails", async () => {
    // The user is being told about the operation they asked for. A second failure on a diagnostic call is
    // noise, and "your report is saved on this phone — try again" is still the true and useful answer.
    const error = apiError(409, "A pending_review report cannot move to pending_review");
    await expect(
      transitionWeeklyReportIdempotently({
        to: "pending_review",
        mayHaveCommitted: true,
        transition: async () => {
          throw error;
        },
        readStatus: async () => {
          throw apiError(0, "Network request failed");
        },
      }),
    ).rejects.toBe(error);
  });
});

describe("could this failure have left the transition committed", () => {
  it("keeps the marker armed for anything that never got a definite answer", () => {
    // ApiError(0) is a dead socket and 408 a client-side timeout — both fire on requests that reached the
    // server and committed. A 502/503/504 comes from a proxy that may be sitting in front of a commit.
    for (const status of [0, 408, 502, 503, 504]) {
      expect(weeklyReportTransitionOutcomeUnknown(apiError(status, "x"))).toBe(true);
    }
    // Not an ApiError at all: nothing can be concluded, so nothing is.
    expect(weeklyReportTransitionOutcomeUnknown(new Error("boom"))).toBe(true);
    expect(weeklyReportTransitionOutcomeUnknown(null)).toBe(true);
  });

  it("clears it for an answer the application actually gave", () => {
    for (const status of [400, 403, 404, 409, 422, 500]) {
      expect(weeklyReportTransitionOutcomeUnknown(apiError(status, "x"))).toBe(false);
    }
  });
});
