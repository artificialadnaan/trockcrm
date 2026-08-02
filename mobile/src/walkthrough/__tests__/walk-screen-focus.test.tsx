/**
 * Covers the P2 fix on app/(app)/walk.tsx: the focus effect that resets a terminal walk must
 * fire on a genuine focus TRANSITION, not merely because `useFocusEffect`'s callback got a new
 * identity while the route was already focused.
 *
 * The screen itself has a lot of surrounding wiring (auth, the upload queue, background task
 * registration, keep-awake) that is irrelevant to this bug, so all of it is stubbed out here —
 * only `useWalk` (fully controlled by the test) and `expo-router` (mocked to faithfully
 * reproduce the specific gotcha this bug depends on) actually matter.
 */
import React from "react";
import { act, render } from "@testing-library/react-native";
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

jest.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "user-1", tenantId: "tenant-1" },
    activeOfficeId: "office-1",
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
    ...extra,
  };
}

beforeEach(() => {
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
