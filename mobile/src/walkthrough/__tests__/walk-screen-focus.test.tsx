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
