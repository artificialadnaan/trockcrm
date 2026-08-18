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
  transitionWeeklyReportIdempotently,
  weeklyReportStatusReached,
} from "../transition";

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
  it("re-reads the server before opening a REVIEW draft, however fresh the local copy looks", () => {
    // A stale review draft replays a PATCH of explicit nulls and a whole-set photo PUT over work the
    // superintendent rewrote after it was bounced back. The PM then approves something other than what
    // they just read. Every entry point has to come through the re-read.
    const target = weeklyReportOpenTarget({
      project: PROJECT,
      weekOf: "2026-08-13",
      drafts: [localDraft({ mode: "review", reportId: "rep-1" })],
    });
    expect(target).toEqual({ kind: "review-fresh", reportId: "rep-1" });
  });

  it("resumes an AUTHORING draft from disk, never from the server", () => {
    // The exact opposite rule, for the exact opposite reason: this draft may hold a section typed on a
    // jobsite with no signal, and reseeding from the server would discard it.
    const target = weeklyReportOpenTarget({
      project: { ...PROJECT, currentReportId: "rep-1" },
      weekOf: "2026-08-13",
      drafts: [localDraft({ id: "draft-9" })],
    });
    expect(target).toEqual({ kind: "resume-local", draftId: "draft-9" });
  });

  it("falls back to opening a review draft locally only when it has no report id to re-read", () => {
    // A review draft with no reportId cannot be re-read; resuming it beats stranding the PM.
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

  it("resumes the SERVER's row for a missed week that already has one", () => {
    const target = weeklyReportOpenTarget({
      project: { ...PROJECT, outstandingWeekReportIds: { "2026-07-30": "rep-missed" } },
      weekOf: "2026-07-30",
      drafts: [],
    });
    expect(target).toEqual({ kind: "resume-server", reportId: "rep-missed" });
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

describe("filing a report when the response was lost", () => {
  it("passes the server's answer straight through when the transition succeeds", async () => {
    const outcome = await transitionWeeklyReportIdempotently({
      to: "pending_review",
      transition: async () => "pending_review",
      readStatus: async () => {
        throw new Error("must not be consulted on success");
      },
    });
    expect(outcome).toEqual({ status: "pending_review", alreadyThere: false });
  });

  it("treats 'it is already there' as the success it is", async () => {
    // THE BUG. The transition commits, the reply is lost on jobsite LTE, the wizard catches and never
    // records the new status. The retry's PATCH and photo PUT land (the author may still edit at
    // pending_review) and the transition answers 409 "A pending_review report cannot move to
    // pending_review" — verbatim, forever. The report was filed; the phone insisted it had failed, the
    // draft never cleared, and the only exit was a Discard dialog that reads like it destroys the report.
    const outcome = await transitionWeeklyReportIdempotently({
      to: "pending_review",
      transition: async () => {
        throw apiError(409, "A pending_review report cannot move to pending_review");
      },
      readStatus: async () => "pending_review",
    });
    expect(outcome).toEqual({ status: "pending_review", alreadyThere: true });
  });

  it("accepts a report that moved PAST the target while the response was in flight", async () => {
    const outcome = await transitionWeeklyReportIdempotently({
      to: "pending_review",
      transition: async () => {
        throw apiError(409, "An approved report cannot move to pending_review");
      },
      readStatus: async () => "approved",
    });
    expect(outcome).toEqual({ status: "approved", alreadyThere: true });
  });

  it("rethrows a 409 on a report that has NOT reached the target", async () => {
    // "This report changed while you were working on it" on a report still in draft is a real conflict:
    // nothing was filed, and swallowing it would delete the local draft with the work still unsent.
    const error = apiError(409, "This report changed while you were working on it — reload and try again");
    await expect(
      transitionWeeklyReportIdempotently({
        to: "pending_review",
        transition: async () => {
          throw error;
        },
        readStatus: async () => "draft",
      }),
    ).rejects.toBe(error);
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
