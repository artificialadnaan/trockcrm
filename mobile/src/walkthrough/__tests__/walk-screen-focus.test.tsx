/**
 * Screen-level behaviour of app/(app)/walk.tsx — everything that is the SCREEN's responsibility
 * rather than the walk lifecycle's (which lives in useWalk.ts / session.ts and is covered there):
 * the focus effect that resets a terminal walk, the metadata a finished walk is enqueued with,
 * the truncation notices, the refusal to record without a target, and the keep-awake lock.
 *
 * `useWalk` is fully controlled by the test rather than mocked loosely, so each case states the
 * exact walk state the screen is asked to render. Everything else the screen touches (auth, the
 * upload queue, background task registration) is stubbed out; `expo-router` is mocked to
 * faithfully reproduce the focus gotcha the first group depends on rather than to simplify it.
 */
import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { UseWalkResult } from "../useWalk";
import type { Walk, WalkState } from "../session";

let mockParams: Record<string, string | undefined> = {
  dealId: "deal-1",
  targetName: "Riverside Plaza",
  projectId: undefined,
  propertyAddress: undefined,
};
const mockRouterBack = jest.fn();

jest.mock("expo-router", () => {
  const ReactLib = require("react");
  return {
    // A deliberately FAITHFUL stand-in for the real hook's documented gotcha, not a
    // simplification of it: when the route is already focused and the CALLBACK passed in gets a
    // new identity, the real useFocusEffect re-runs the effect immediately — it does not wait
    // for an actual blur/refocus. That is exactly what a plain useEffect keyed off the callback
    // reference does, which is why aliasing to it here is the right mock for this bug rather
    // than a shortcut around it.
    useFocusEffect: (callback: () => void | (() => void)) => {
      ReactLib.useEffect(() => callback(), [callback]);
    },
    useLocalSearchParams: () => mockParams,
    useRouter: () => ({ back: mockRouterBack }),
  };
});

const mockActivateKeepAwake = jest.fn().mockResolvedValue(undefined);
const mockDeactivateKeepAwake = jest.fn().mockResolvedValue(undefined);
jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: (...args: unknown[]) => mockActivateKeepAwake(...args),
  deactivateKeepAwake: (...args: unknown[]) => mockDeactivateKeepAwake(...args),
}));

jest.mock("react-native-safe-area-context", () => {
  const ReactLib = require("react");
  const { View } = require("react-native");
  return {
    SafeAreaView: ({ children, ...props }: { children: React.ReactNode }) => (
      <View {...props}>{children}</View>
    ),
  };
});

jest.mock("../../api/client", () => ({
  apiFetch: jest.fn(),
}));

// Mutable, and only one test moves it: the walk queue's owner key is `user.id + resolved office`
// (use-queue-session.ts), so "signed out" is expressible here and nowhere else. Every other case
// wants the signed-in default, which is what beforeEach restores.
const SIGNED_IN_USER = { id: "user-1", tenantId: "tenant-1" };
let mockAuthUser: { id: string; tenantId: string } | null = SIGNED_IN_USER;
jest.mock("../../auth/AuthContext", () => ({
  // Rebuilt on every call (this is a hook), so the value below is read at render time rather than
  // frozen when the factory ran.
  useAuth: () => ({
    user: mockAuthUser,
    activeOfficeId: mockAuthUser ? "office-1" : null,
    token: "token-1",
    signOut: jest.fn(),
  }),
}));

const mockEnqueueWalk = jest.fn().mockResolvedValue(null);
const mockDrainWalkQueue = jest.fn().mockResolvedValue(undefined);
jest.mock("../upload", () => ({
  enqueueWalk: (...args: unknown[]) => mockEnqueueWalk(...args),
  drainWalkQueue: (...args: unknown[]) => mockDrainWalkQueue(...args),
}));

jest.mock("../upload-client", () => ({
  walkthroughUploadClient: {},
}));

const mockRegisterBackgroundTask = jest.fn().mockResolvedValue(undefined);
jest.mock("../upload-background-task", () => ({
  registerWalkUploadBackgroundTask: (...args: unknown[]) => mockRegisterBackgroundTask(...args),
}));

// The Meta bridge, OFF by default — `isAvailable` is a getter rather than a literal so a single
// test can turn it on without every other case in this file suddenly firing three native calls it
// never asked for. With it false the screen's readiness check short-circuits before touching any of
// the mocks below, which is exactly the behaviour every pre-existing case here was written against.
const mockWearablesConfigure = jest.fn();
const mockWearablesStatus = jest.fn();
const mockWearablesDiagnose = jest.fn();
const mockRequestCameraPermission = jest.fn();
let mockWearablesBridgeAvailable = false;
jest.mock("../../wearables/native", () => ({
  get isAvailable() {
    return mockWearablesBridgeAvailable;
  },
  Wearables: {
    configure: () => mockWearablesConfigure(),
    status: () => mockWearablesStatus(),
    diagnose: () => mockWearablesDiagnose(),
    requestCameraPermission: () => mockRequestCameraPermission(),
  },
}));

const mockReset = jest.fn();
let mockResult: UseWalkResult;

jest.mock("../useWalk", () => ({
  useWalk: (...args: unknown[]) => mockUseWalk(...args),
}));
// eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazily referenced by the
// factory above, only once useWalk() is actually called during a render (see the existing
// useWalk.test.ts mock of ../native for the same pattern).
const mockUseWalk = jest.fn((..._args: unknown[]) => mockResult);

// eslint-disable-next-line import/first
import WalkScreen from "../../../app/(app)/walk";

function makeWalk(state: WalkState, overrides: Partial<Walk> = {}): Walk {
  return {
    state,
    dealId: "deal-1",
    projectId: null,
    startedAt: 1000,
    endedAt: state === "complete" ? 5000 : null,
    durationMs: state === "complete" ? 4000 : null,
    videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
    audioUri: null,
    audioAlive: true,
    audioLevel: 0,
    audioStall: null,
    captureCensus: null,
    videoCoverage: null,
    audioCoverage: null,
    stills: [],
    error: state === "failed" ? "glasses disconnected" : null,
    ...overrides,
  };
}

function resultFor(walk: Walk, extra: Partial<UseWalkResult> = {}): UseWalkResult {
  return {
    walk,
    error: null,
    walkId: "walk-1",
    start: jest.fn(),
    capture: jest.fn(),
    end: jest.fn(),
    reset: mockReset,
    stillCount: walk.stills.length,
    bridgeAvailable: true,
    captureEnabled: true,
    atCaptureLimit: false,
    videoSize: "ok",
    stoppedAtSizeLimit: false,
    ...extra,
  };
}

beforeEach(() => {
  mockAuthUser = SIGNED_IN_USER;
  mockParams = {
    dealId: "deal-1",
    targetName: "Riverside Plaza",
    projectId: undefined,
    propertyAddress: undefined,
  };
  mockReset.mockClear();
  mockRouterBack.mockClear();
  mockEnqueueWalk.mockClear();
  mockDrainWalkQueue.mockClear();
  // Reset, not just clear: the keep-awake cases below install one-shot implementations to control
  // WHEN activation resolves, and a leftover one would silently change the next test's timing.
  mockActivateKeepAwake.mockReset().mockResolvedValue(undefined);
  mockDeactivateKeepAwake.mockReset().mockResolvedValue(undefined);
  mockWearablesBridgeAvailable = false;
  mockWearablesConfigure.mockReset();
  mockWearablesStatus.mockReset();
  mockWearablesDiagnose.mockReset();
  mockRequestCameraPermission.mockReset();
});

describe("WalkScreen focus-driven reset", () => {
  // The exact regression: with the OLD focus effect (deps: [walk.state, reset]), a walk reaching
  // "complete" WHILE this screen was already the focused route — true for the whole of this test,
  // since it's a hidden Tabs.Screen and nothing here ever blurs/refocuses it — gave the callback a
  // new identity purely because `walk.state` changed, and Expo Router ran it immediately, wiping
  // the completion summary the instant it appeared. Fixed, a state change alone (no genuine focus
  // transition) must never call reset().
  it("does not call reset() when the walk reaches COMPLETE while the screen stays focused — no blur/refocus occurs", () => {
    mockResult = resultFor(makeWalk("recording"), { stillCount: 3 });
    const { rerender, getByText } = render(<WalkScreen />);

    mockResult = resultFor(
      makeWalk("complete", { stills: [{ uri: "a", at: 1, source: "phone" }] }),
      { stillCount: 1 },
    );
    act(() => {
      rerender(<WalkScreen />);
    });

    expect(mockReset).not.toHaveBeenCalled();
    // The summary is actually on screen, not just "reset wasn't called" in the abstract.
    expect(getByText("Walk complete")).toBeTruthy();
  });

  // Same mechanism, the OTHER terminal state: a fatal failure's diagnostic must not vanish either.
  it("does not call reset() when the walk reaches FAILED while the screen stays focused", () => {
    mockResult = resultFor(makeWalk("recording"));
    const { rerender, getByText } = render(<WalkScreen />);

    mockResult = resultFor(makeWalk("failed"));
    act(() => {
      rerender(<WalkScreen />);
    });

    expect(mockReset).not.toHaveBeenCalled();
    expect(getByText("Walk failed")).toBeTruthy();
  });

  // Sanity check on the mock itself: a walk that is ALREADY terminal at mount (e.g. the estimator
  // navigated back to a walk that finished while they were elsewhere) must still be handled by
  // SOME focus transition — this one exercises the initial "focus on mount" run, which the ref
  // read correctly on the very first pass.
  it("does call reset() for a walk that is already terminal at the first focus (mount)", () => {
    mockResult = resultFor(makeWalk("complete"));
    render(<WalkScreen />);

    expect(mockReset).toHaveBeenCalledTimes(1);
  });
});

// ── FINDING 3 (P2): a preserved walk must be FILED under the target it started against ────────────
//
// useWalk already refuses to reset an ACTIVE walk, so a route-param change mid-recording leaves
// `walk.dealId` pointing at the original deal. The enqueue effect, though, read `targetName` /
// `propertyAddress` straight off the CURRENT params — so the walk was filed against deal A while
// carrying deal B's name and address. That is worse than either half being wrong on its own: the
// record looks internally consistent and names the wrong job site.
describe("WalkScreen enqueue metadata for a preserved walk", () => {
  function paramsFor(dealId: string, targetName: string, propertyAddress: string) {
    return { dealId, targetName, projectId: undefined, propertyAddress };
  }

  it("uses the target the walk STARTED against, not the params current when it ends", () => {
    mockParams = paramsFor("deal-1", "Riverside Plaza", "12 River Rd, Dallas TX");
    mockResult = resultFor(makeWalk("recording"));
    const { rerender } = render(<WalkScreen />);

    // The estimator picks a different deal in the app while the walk is still running. useWalk
    // preserves the walk (it is active), so the recording keeps belonging to deal-1.
    mockParams = paramsFor("deal-2", "Northgate Depot", "900 North Ave, Plano TX");
    act(() => {
      rerender(<WalkScreen />);
    });

    mockResult = resultFor(makeWalk("complete"));
    act(() => {
      rerender(<WalkScreen />);
    });

    expect(mockEnqueueWalk).toHaveBeenCalledTimes(1);
    const meta = mockEnqueueWalk.mock.calls[0]![3] as { title: string; siteLabel: string };
    const queuedWalk = mockEnqueueWalk.mock.calls[0]![2] as Walk;
    // Deal, title and site label all describe ONE project.
    expect(queuedWalk.dealId).toBe("deal-1");
    expect(meta.title).toContain("Riverside Plaza");
    expect(meta.title).not.toContain("Northgate Depot");
    expect(meta.siteLabel).toBe("12 River Rd, Dallas TX");
  });

  it("still uses the live params for a walk that started under them", () => {
    mockParams = paramsFor("deal-2", "Northgate Depot", "900 North Ave, Plano TX");
    mockResult = resultFor(makeWalk("recording", { dealId: "deal-2" }));
    const { rerender } = render(<WalkScreen />);

    mockResult = resultFor(makeWalk("complete", { dealId: "deal-2" }));
    act(() => {
      rerender(<WalkScreen />);
    });

    const meta = mockEnqueueWalk.mock.calls[0]![3] as { title: string; siteLabel: string };
    expect(meta.title).toContain("Northgate Depot");
    expect(meta.siteLabel).toBe("900 North Ave, Plano TX");
  });
});

// ── FINDING 1 (P1), screen half: the estimator has to be TOLD the video came up short ─────────────
describe("WalkScreen short-video notice", () => {
  const shortCoverage = { walkMs: 20 * 60 * 1000, videoMs: 5_000, shortfallMs: 1_195_000 };

  it("says plainly on the completion screen that the video is short, and by roughly how much", () => {
    mockResult = resultFor(
      makeWalk("complete", { durationMs: 20 * 60 * 1000, videoCoverage: shortCoverage }),
    );
    const { getByText } = render(<WalkScreen />);

    expect(getByText("Video is short")).toBeTruthy();
    // The numbers that make it actionable, in context: how much video there is, how long the walk
    // was, and how much is gone. Matched against the notice's own sentence rather than the bare
    // "20:00" — the duration row on this same screen reads 20:00 too.
    expect(
      getByText(/Only about 0:05 of this 20:00 walk has video — roughly 19:55 is missing/),
    ).toBeTruthy();
  });

  it("shows nothing extra for a walk whose video covered it", () => {
    mockResult = resultFor(
      makeWalk("complete", {
        durationMs: 20 * 60 * 1000,
        videoCoverage: { walkMs: 20 * 60 * 1000, videoMs: 20 * 60 * 1000 - 33, shortfallMs: 33 },
      }),
    );
    const { queryByText } = render(<WalkScreen />);
    expect(queryByText("Video is short")).toBeNull();
  });

  // The office needs it too — a walk that files as a normal 20-minute visit and turns out to hold
  // five seconds of footage is exactly the surprise this whole finding is about.
  it("marks the queued title so the truncation survives past this screen", () => {
    mockResult = resultFor(
      makeWalk("recording", { durationMs: null, videoCoverage: null }),
    );
    const { rerender } = render(<WalkScreen />);

    mockResult = resultFor(
      makeWalk("complete", { durationMs: 20 * 60 * 1000, videoCoverage: shortCoverage }),
    );
    act(() => {
      rerender(<WalkScreen />);
    });

    const meta = mockEnqueueWalk.mock.calls[0]![3] as { title: string };
    expect(meta.title).toContain("video cut short");
  });
});

// ── ROUND-4 FINDING 2 (P1), screen half: a truncated NARRATION is the expensive one ────────────────
//
// Video going short costs pictures. Audio going short costs the scope itself — the narration is
// what the extraction reads — so the estimator has to hear about it while they are still standing
// on the site, in the same register and on the same screen as the video notice.
describe("WalkScreen short-audio notice", () => {
  const shortAudio = { walkMs: 20 * 60 * 1000, audioMs: 5_000, shortfallMs: 1_195_000 };

  it("says plainly on the completion screen that the narration is short, and by roughly how much", () => {
    mockResult = resultFor(
      makeWalk("complete", { durationMs: 20 * 60 * 1000, audioCoverage: shortAudio }),
    );
    const { getByText } = render(<WalkScreen />);

    expect(getByText("Narration is short")).toBeTruthy();
    expect(
      getByText(/Only about 0:05 of this 20:00 walk has audio — roughly 19:55 is missing/),
    ).toBeTruthy();
  });

  it("shows nothing extra for a walk whose narration covered it", () => {
    mockResult = resultFor(
      makeWalk("complete", {
        durationMs: 20 * 60 * 1000,
        audioCoverage: { walkMs: 20 * 60 * 1000, audioMs: 20 * 60 * 1000, shortfallMs: 0 },
      }),
    );
    const { queryByText } = render(<WalkScreen />);
    expect(queryByText("Narration is short")).toBeNull();
  });

  it("marks the queued title so a short narration survives past this screen", () => {
    mockResult = resultFor(makeWalk("recording", { durationMs: null, audioCoverage: null }));
    const { rerender } = render(<WalkScreen />);

    mockResult = resultFor(
      makeWalk("complete", { durationMs: 20 * 60 * 1000, audioCoverage: shortAudio }),
    );
    act(() => {
      rerender(<WalkScreen />);
    });

    const meta = mockEnqueueWalk.mock.calls[0]![3] as { title: string };
    expect(meta.title).toContain("audio cut short");
  });

  // Both transports can die on one walk, and the title is a single string. The existing
  // "(video cut short)" wording must survive verbatim for a video-only truncation — the office
  // reads it — so the two markers combine rather than one overwriting the other.
  it("names both transports in the title when video and audio both came up short", () => {
    mockResult = resultFor(makeWalk("recording"));
    const { rerender } = render(<WalkScreen />);

    mockResult = resultFor(
      makeWalk("complete", {
        durationMs: 20 * 60 * 1000,
        videoCoverage: { walkMs: 20 * 60 * 1000, videoMs: 5_000, shortfallMs: 1_195_000 },
        audioCoverage: shortAudio,
      }),
    );
    act(() => {
      rerender(<WalkScreen />);
    });

    const meta = mockEnqueueWalk.mock.calls[0]![3] as { title: string };
    expect(meta.title).toContain("video and audio cut short");
  });
});

// ── Round-10 FINDING 2 (P2): an enqueue that fails must not take the walk with it ─────────────────
//
// enqueueWalk is the moment a finished site visit stops being loose files and becomes something the
// queue owns. When it rejected — a filesystem error, a phone with no space left — the catch cleared
// one ref and nothing else: no state changed, so the terminal-state effect never ran again, and the
// next focus of this never-unmounting route reset the walk out of existence. The bytes survived on
// disk, but the only thing that could still find them was the startup orphan scan, which needs the
// estimator to notice, reopen the app, and go looking. They were never told there was anything to
// look for. This screen already shows native's failures verbatim and prominently; a queue that
// refused the walk is the same kind of fact, and unlike native's it has an action attached.
describe("WalkScreen enqueue failure", () => {
  async function completeAWalk(enqueue: () => Promise<unknown>) {
    mockEnqueueWalk.mockImplementationOnce(enqueue);
    mockResult = resultFor(makeWalk("recording"));
    const view = render(<WalkScreen />);
    mockResult = resultFor(makeWalk("complete"));
    await act(async () => {
      view.rerender(<WalkScreen />);
    });
    return view;
  }

  it("says the walk is not queued, in the queue's own words, instead of dropping it", async () => {
    const { getByText } = await completeAWalk(() => Promise.reject(new Error("ENOSPC: no space left")));

    expect(getByText("This walk has not been queued")).toBeTruthy();
    // Verbatim, same rule as the error banner: "no space left" is the one word here that tells the
    // estimator what to do about it, and no paraphrase of ours knows what the failure was.
    expect(getByText(/ENOSPC: no space left/)).toBeTruthy();
  });

  // The interaction that made the old catch fatal: this route is a hidden tab that never unmounts,
  // so leaving and coming back re-runs the focus effect, which resets a terminal walk. If the notice
  // hung off walk.state it would be wiped by the same reset that discarded the problem in the first
  // place — the estimator would return to an idle screen with no sign a recording is unaccounted for.
  it("survives the focus reset that clears the terminal walk", async () => {
    const { rerender, getByText } = await completeAWalk(() =>
      Promise.reject(new Error("ENOSPC: no space left")),
    );

    mockResult = resultFor(makeWalk("idle"), { walkId: null }); // what reset() leaves behind
    await act(async () => {
      rerender(<WalkScreen />);
    });

    expect(getByText("This walk has not been queued")).toBeTruthy();
    expect(getByText("Try again")).toBeTruthy();
  });

  it("retries the SAME walk when asked, and clears the notice once it lands", async () => {
    const { getByText, queryByText, rerender } = await completeAWalk(() =>
      Promise.reject(new Error("ENOSPC: no space left")),
    );
    // The reset has already happened by the time a hurried estimator taps retry — so the retry has
    // to carry its own copy of the walk, not read one out of a screen that no longer holds it.
    mockResult = resultFor(makeWalk("idle"), { walkId: null });
    await act(async () => {
      rerender(<WalkScreen />);
    });

    await act(async () => {
      fireEvent.press(getByText("Try again"));
    });

    expect(mockEnqueueWalk).toHaveBeenCalledTimes(2);
    const [firstOwner, firstWalkId, firstWalk, firstMeta] = mockEnqueueWalk.mock.calls[0]!;
    expect(mockEnqueueWalk.mock.calls[1]).toEqual([firstOwner, firstWalkId, firstWalk, firstMeta]);
    expect(queryByText("This walk has not been queued")).toBeNull();
  });

  // GUARD (passes before the fix too): the notice is about a REFUSAL, so an enqueue that worked must
  // leave the completion summary exactly as it was.
  it("says nothing when the walk queues normally", async () => {
    const { queryByText, getByText } = await completeAWalk(() => Promise.resolve(null));
    expect(queryByText("This walk has not been queued")).toBeNull();
    expect(getByText("Walk complete")).toBeTruthy();
  });

  // The one caller `fileWalk`'s ownerKey guard could not simply return from. The terminal-state
  // effect checks ownerKey itself before ever calling in, so a silent return there is correct and
  // unreachable — but the RETRY button has no such check, and a sign-out between the refusal and the
  // tap is exactly the sequence this banner exists for (an estimator who cannot queue a walk goes
  // looking at Profile, which is where sign-out lives). The tap then set the busy flag, cleared it,
  // changed nothing, and left the same message standing: the button reads as broken on the ONE
  // surface that can still save the recording.
  it("says WHY when a retry lands with no signed-in identity, instead of failing silently", async () => {
    const { getByText, queryByText, rerender } = await completeAWalk(() =>
      Promise.reject(new Error("ENOSPC: no space left")),
    );
    expect(getByText(/ENOSPC: no space left/)).toBeTruthy();

    // Signed out while the notice is on screen. The banner survives — it is the screen's own state,
    // and this route never unmounts — so the retry is still one tap away.
    mockAuthUser = null;
    mockEnqueueWalk.mockClear();
    await act(async () => {
      rerender(<WalkScreen />);
    });

    await act(async () => {
      fireEvent.press(getByText("Try again"));
    });

    // Nothing was filed — there is no manifest namespace to file into — and the banner now says so
    // in the same words Profile's recovery card uses for the same condition.
    expect(mockEnqueueWalk).not.toHaveBeenCalled();
    expect(getByText("This walk has not been queued")).toBeTruthy();
    expect(getByText(/Sign in again before queueing this walk\./)).toBeTruthy();
    // ONE banner, not two: the same recording refusing a second time replaces its own row.
    expect(queryByText(/ENOSPC: no space left/)).toBeNull();
  });
});

// ── Round-6 FINDING 5 (P2): a walk with no deal has nowhere to be filed ───────────────────────────
//
// This is a hidden route. Opening it directly, or following a link whose dealId got dropped,
// normalised the target to "" and still rendered a working Start button. The estimator could then
// record an entire site visit — video, narration, stills, all on disk — and the failure would only
// surface later, in the upload queue, as a POST to `/field/projects//glasses-walkthroughs` that goes
// terminal. Refusing at the screen costs one tap; allowing it costs the walk.
describe("WalkScreen with no target deal", () => {
  it("refuses to offer a recording that could never be filed", () => {
    mockParams = { dealId: undefined, targetName: "Riverside Plaza", projectId: undefined, propertyAddress: undefined };
    mockResult = resultFor(makeWalk("idle"));
    const { queryByText, getByText } = render(<WalkScreen />);

    expect(queryByText("Start walk")).toBeNull();
    expect(getByText("No project selected")).toBeTruthy();
  });

  // A malformed link, rather than no link at all — same outcome, since `dealId` is normalised to ""
  // either way and "" is what would be spliced into the endpoint path.
  it("refuses an empty-string dealId too", () => {
    mockParams = { dealId: "", targetName: "Riverside Plaza", projectId: undefined, propertyAddress: undefined };
    mockResult = resultFor(makeWalk("idle"));
    const { queryByText } = render(<WalkScreen />);

    expect(queryByText("Start walk")).toBeNull();
  });

  // The refusal must be about the MISSING deal and nothing else. (Guard: this held before the fix
  // too — it is here so a future over-broad guard cannot quietly disable the normal path.)
  it("offers the walk normally when a dealId is present", () => {
    mockResult = resultFor(makeWalk("idle"));
    const { getByText } = render(<WalkScreen />);
    expect(getByText("Start walk")).toBeTruthy();
  });
});

// ── Round-6 FINDING 6 (P2): the keep-awake lock must not outlive the recording ────────────────────
//
// `activateKeepAwakeAsync` is async, and a walk can leave "recording" before it resolves — a walk
// ended within a second or two, or one that failed the moment it started. The cleanup then ran while
// `keptAwakeRef` was still false and did nothing, and the late fulfilment set the ref true after its
// only cleanup had already gone. Nothing was left holding a reference to that lock, so the screen
// stayed awake until the app was killed — on a phone that has just been put in a pocket.
describe("WalkScreen keep-awake lock", () => {
  const TAG = "trockcam-walk";

  it("releases a lock whose activation lands after the walk already stopped recording", async () => {
    let settleActivation!: () => void;
    mockActivateKeepAwake.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settleActivation = () => resolve();
        }),
    );
    mockResult = resultFor(makeWalk("recording"));
    const { rerender } = render(<WalkScreen />);
    expect(mockActivateKeepAwake).toHaveBeenCalledWith(TAG);

    // The walk ends before iOS answers.
    mockResult = resultFor(makeWalk("complete"));
    act(() => {
      rerender(<WalkScreen />);
    });
    expect(mockDeactivateKeepAwake).not.toHaveBeenCalled(); // nothing acquired yet, nothing to release

    await act(async () => {
      settleActivation();
      await Promise.resolve();
    });

    expect(mockDeactivateKeepAwake).toHaveBeenCalledWith(TAG);
  });

  // The ordinary path, unchanged: activation lands while the walk is still recording, and the lock
  // is released exactly once when recording stops. (Guard, not a regression.)
  it("releases the lock once when recording stops normally", async () => {
    mockResult = resultFor(makeWalk("recording"));
    const { rerender } = render(<WalkScreen />);
    await act(async () => {
      await Promise.resolve();
    });

    mockResult = resultFor(makeWalk("complete"));
    await act(async () => {
      rerender(<WalkScreen />);
    });

    expect(mockDeactivateKeepAwake).toHaveBeenCalledTimes(1);
    expect(mockDeactivateKeepAwake).toHaveBeenCalledWith(TAG);
  });

  // A refused activation must not be "released" — deactivating a tag that was never acquired is a
  // call about a lock this screen does not hold.
  it("does not release a lock it never acquired", async () => {
    mockActivateKeepAwake.mockRejectedValueOnce(new Error("keep-awake unavailable"));
    mockResult = resultFor(makeWalk("recording"));
    const { rerender } = render(<WalkScreen />);
    await act(async () => {
      await Promise.resolve();
    });

    mockResult = resultFor(makeWalk("complete"));
    await act(async () => {
      rerender(<WalkScreen />);
    });

    expect(mockDeactivateKeepAwake).not.toHaveBeenCalled();
  });
});

// ── Round-7 FINDING 2 (P1): a Start button that can only fail is worse than no Start button ───────
//
// Meta's camera authorization is a THIRD permission, separate from Bluetooth pairing and from the
// phone's own camera/microphone grants, and until now the only place in the app that ever requested
// it was Profile's pairing row. Nothing on the path an estimator actually walks — project → Capture
// → walk — passes through Profile, so on a fresh install with the glasses registered this screen
// offered a fully working Start button for a walk that cannot produce video, and the estimator found
// out at the far end of a site visit, from a message about stream creation that this screen never
// showed and could not have explained.
//
// The verdict is describePairing's, not a second opinion invented here: `cameraBlocked` is the exact
// status Profile already renders and already offers a grant button for. What is new is only WHERE it
// is enforced.
describe("WalkScreen glasses camera authorization", () => {
  function diagnosisWith(cameraPermission: string) {
    return {
      deviceCount: 1,
      devices: [{ name: "RB Meta 014K", linkState: "connected" }],
      cameraPermission,
      activeDeviceImmediate: "device-1",
      activeDeviceAfterWait: "device-1",
      verdict: "eligible immediately",
    };
  }

  beforeEach(() => {
    mockWearablesBridgeAvailable = true;
    mockWearablesConfigure.mockResolvedValue({ configured: true, alreadyConfigured: false });
    mockWearablesStatus.mockResolvedValue({
      registrationState: "registered",
      deviceCount: 1,
      devices: ["RB Meta 014K"],
    });
    // The fresh-install shape: registered, connected, and never authorized. MWDATCore reports
    // `denied` here before the permission has ever been requested — there is no "undetermined".
    mockWearablesDiagnose.mockResolvedValue(diagnosisWith("denied"));
    mockRequestCameraPermission.mockResolvedValue({ status: "granted" });
  });

  it("does not offer Start when Meta's camera authorization is missing", async () => {
    mockResult = resultFor(makeWalk("idle"));
    const { queryByText, findByText } = render(<WalkScreen />);

    // describePairing's own label and detail, verbatim — the estimator reads the same sentence here
    // as on Profile, about the same thing.
    expect(await findByText("Camera access needed")).toBeTruthy();
    expect(queryByText("Start walk")).toBeNull();
  });

  // The other half, and the one that decides whether this is a fix or just a refusal: the estimator
  // is standing on the site. Being told the walk cannot start is only useful if the thing that makes
  // it startable is on the same screen, one tap away.
  it("grants the permission from this screen and puts Start back", async () => {
    mockWearablesDiagnose
      .mockResolvedValueOnce(diagnosisWith("denied"))
      .mockResolvedValue(diagnosisWith("granted"));
    mockResult = resultFor(makeWalk("idle"));
    const { findByText } = render(<WalkScreen />);

    fireEvent.press(await findByText("Grant camera access"));

    expect(await findByText("Start walk")).toBeTruthy();
    expect(mockRequestCameraPermission).toHaveBeenCalledTimes(1);
  });

  // A request that resolves NOT-granted is the dead end this screen must not be silent about:
  // nothing threw, so there is no error to show, and re-checking simply reproduces the same gate.
  // Meta's own answer is the only information anyone has, so it is repeated verbatim — the same rule
  // the error banner at the top of this screen follows.
  it("says what Meta answered when the grant does not take", async () => {
    mockRequestCameraPermission.mockResolvedValue({ status: "denied" });
    mockResult = resultFor(makeWalk("idle"));
    const { findByText } = render(<WalkScreen />);

    fireEvent.press(await findByText("Grant camera access"));

    expect(await findByText(/Meta answered "denied"/)).toBeTruthy();
  });

  // GUARD (passes before the fix too): the gate must fire on a VERDICT, never on the absence of one.
  // A readiness check that could not complete knows nothing about the permission, and a screen that
  // refuses to start a walk because a diagnostic call failed has taken the site visit away over its
  // own plumbing. Unknown stays startable — native still has its own guards at the far end.
  it("still offers Start when the readiness check itself fails", async () => {
    mockWearablesDiagnose.mockRejectedValue(new Error("wearables_diagnose_failed"));
    mockResult = resultFor(makeWalk("idle"));
    const { findByText, queryByText } = render(<WalkScreen />);

    expect(await findByText("Start walk")).toBeTruthy();
    expect(queryByText("Camera access needed")).toBeNull();
  });

  // GUARD (passes before the fix too): a granted device is offered the walk exactly as before, so
  // the gate cannot quietly become a gate on everyone.
  it("offers Start normally once the authorization is in place", async () => {
    mockWearablesDiagnose.mockResolvedValue(diagnosisWith("granted"));
    mockResult = resultFor(makeWalk("idle"));
    const { findByText, queryByText } = render(<WalkScreen />);

    expect(await findByText("Start walk")).toBeTruthy();
    expect(queryByText("Camera access needed")).toBeNull();
  });

  // GUARD (passes before the fix too): the gate lives inside the pre-walk branch and nowhere else.
  // A late/flapping verdict landing mid-recording must never replace the CAPTURE control — that
  // would take the one button this screen exists for away from a walk already in progress.
  it("never disturbs a walk that is already recording", async () => {
    mockResult = resultFor(makeWalk("recording"));
    const { findByText, queryByText } = render(<WalkScreen />);

    expect(await findByText("CAPTURE")).toBeTruthy();
    expect(queryByText("Camera access needed")).toBeNull();
  });
});

// ── FINDING A (Codex): the screen's half of the recording-size bound ───────────────────────────────
//
// useWalk owns the measurement and the stop (see its own suite). What must not be left to it is the
// telling: a warning the estimator can still act on while they are standing on the site, and — if it
// comes to the stop — a reason, because a recording that ended itself with nothing said reads
// exactly like one ended by a mis-tap on a screen built to make End hard to hit by accident.
describe("WalkScreen recording-size notices", () => {
  it("tells the estimator to wrap up while the walk is still theirs to end", () => {
    mockResult = resultFor(makeWalk("recording"), { videoSize: "nearLimit" });
    const { getByText } = render(<WalkScreen />);

    expect(getByText(/close to the largest recording/i)).toBeTruthy();
    // Not a failure and not an interruption: the walk is still running, and every control it had is
    // still on screen.
    expect(getByText("CAPTURE")).toBeTruthy();
    expect(getByText("End walk")).toBeTruthy();
  });

  it("says WHY a walk stopped on its own, and that the site can still be finished", () => {
    mockResult = resultFor(makeWalk("complete"), { stoppedAtSizeLimit: true });
    const { getByText } = render(<WalkScreen />);

    // Still the completion screen — nothing failed, and the recording is uploading.
    expect(getByText("Walk complete")).toBeTruthy();
    expect(getByText(/reached the largest size/i)).toBeTruthy();
    // The one instruction that matters: the rest of the site is recorded as a SECOND walk.
    expect(getByText(/start another walk/i)).toBeTruthy();
  });

  // GUARD: an ordinary walk must say neither thing. A size notice on a normal site visit would train
  // the estimator to end walks early for no reason.
  it("says nothing about size on an ordinary walk", () => {
    mockResult = resultFor(makeWalk("recording"));
    const recording = render(<WalkScreen />);
    expect(recording.queryByText(/largest recording/i)).toBeNull();

    mockResult = resultFor(makeWalk("complete"));
    const complete = render(<WalkScreen />);
    expect(complete.queryByText(/largest size/i)).toBeNull();
  });
});

// ── The microphone, live: the meter beside the timer and the banner under it ──────────────────────
//
// Two walks on 2026-09-02 lost 3.8 minutes of narration to a microphone that went quiet mid-walk,
// and the estimator learned of it from the completion screen after leaving the site. The meter and
// the banner are what say so in seconds, while there is still an elevation to re-walk.
describe("WalkScreen narration banner", () => {
  it("shows the meter and no banner while the microphone is delivering", () => {
    mockResult = resultFor(makeWalk("recording", { audioAlive: true, audioLevel: 0.1 }));
    const { queryByText, getByLabelText } = render(<WalkScreen />);

    expect(getByLabelText("Microphone level")).toBeTruthy();
    expect(queryByText(/Narration stopped/)).toBeNull();
    expect(queryByText(/Narration failed/)).toBeNull();
  });

  it("says the mic is being restarted while native is still trying", () => {
    mockResult = resultFor(
      makeWalk("recording", {
        audioAlive: false,
        audioStall: { attempt: 1, restarted: true, sinceMs: 2100 },
      }),
    );
    const { getByText } = render(<WalkScreen />);

    expect(getByText("Narration stopped — restarting mic")).toBeTruthy();
    // Still recording: every control the walk had is still on screen.
    expect(getByText("CAPTURE")).toBeTruthy();
    expect(getByText("End walk")).toBeTruthy();
  });

  it("tells the estimator to start a new walk once native has given up", () => {
    mockResult = resultFor(
      makeWalk("recording", {
        audioAlive: false,
        audioStall: { attempt: 3, restarted: false, sinceMs: 9000 },
      }),
    );
    const { getByText, queryByText } = render(<WalkScreen />);

    expect(getByText("Narration failed — end this walk and start a new one")).toBeTruthy();
    expect(queryByText(/restarting mic/)).toBeNull();
  });

  // The banner belongs to a LIVE microphone. A finished walk has its own notice (the coverage
  // summary), and a stall that never cleared must not follow the walk onto the completion screen.
  it("draws neither on the completion screen", () => {
    mockResult = resultFor(
      makeWalk("complete", {
        audioAlive: false,
        audioStall: { attempt: 3, restarted: false, sinceMs: 9000 },
      }),
    );
    const { queryByText, queryByLabelText } = render(<WalkScreen />);

    expect(queryByText(/Narration/)).toBeNull();
    expect(queryByLabelText("Microphone level")).toBeNull();
  });
});
