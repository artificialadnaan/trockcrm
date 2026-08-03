/**
 * app/(app)/walk.tsx, the notice for a walk the upload queue REFUSED — specifically what happens
 * when it refuses more than once in a single shell lifecycle.
 *
 * The existing screen tests (src/walkthrough/__tests__/walk-screen-focus.test.tsx) cover ONE failed
 * filing: it is announced, it survives the focus reset, and retrying it re-files the same walk.
 * This file covers the second one, because the second one used to erase the first — see the
 * describe below. The mock scaffolding is deliberately the same shape as that file's (useWalk fully
 * controlled, everything else stubbed, expo-router's focus gotcha reproduced faithfully) so the two
 * describe the same screen rather than two different idealisations of it.
 */
import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { UseWalkResult } from "../walkthrough/useWalk";
import type { Walk, WalkState } from "../walkthrough/session";

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
    // Faithful to the real hook's documented gotcha, not a simplification of it — see the identical
    // mock in walk-screen-focus.test.tsx for why this aliasing is the right stand-in.
    useFocusEffect: (callback: () => void | (() => void)) => {
      ReactLib.useEffect(() => callback(), [callback]);
    },
    useLocalSearchParams: () => mockParams,
    useRouter: () => ({ back: mockRouterBack }),
  };
});

jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(async () => undefined),
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

jest.mock("../api/client", () => ({
  apiFetch: jest.fn(),
}));

jest.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "user-1", tenantId: "tenant-1" },
    activeOfficeId: "office-1",
    token: "token-1",
    signOut: jest.fn(),
  }),
}));

const mockEnqueueWalk = jest.fn().mockResolvedValue(null);
const mockDrainWalkQueue = jest.fn().mockResolvedValue(undefined);
jest.mock("../walkthrough/upload", () => ({
  enqueueWalk: (...args: unknown[]) => mockEnqueueWalk(...args),
  drainWalkQueue: (...args: unknown[]) => mockDrainWalkQueue(...args),
}));

jest.mock("../walkthrough/upload-client", () => ({
  walkthroughUploadClient: {},
}));

jest.mock("../walkthrough/upload-background-task", () => ({
  registerWalkUploadBackgroundTask: jest.fn(async () => undefined),
}));

// No Meta bridge in this build: the screen's readiness check short-circuits before touching any
// native call, which is all these cases need from it.
jest.mock("../wearables/native", () => ({
  isAvailable: false,
  Wearables: {},
}));

let mockResult: UseWalkResult;
jest.mock("../walkthrough/useWalk", () => ({
  useWalk: (...args: unknown[]) => mockUseWalk(...args),
}));
// eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazily referenced by the
// factory above, only once useWalk() is actually called during a render.
const mockUseWalk = jest.fn((..._args: unknown[]) => mockResult);

// eslint-disable-next-line import/first
import WalkScreen from "../../app/(app)/walk";

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
    reset: jest.fn(),
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
  mockEnqueueWalk.mockReset().mockResolvedValue(null);
  mockDrainWalkQueue.mockClear();
  mockRouterBack.mockClear();
});

// ── Round-11 FINDING A (P2): the second refused filing erased the first ───────────────────────────
//
// The notice held exactly ONE failed filing. Start stays available while it is up (deliberately —
// blocking Start strands an estimator who has a site to record), so the estimator walks the next
// job; when THAT enqueue also fails, the state setter replaced the first walk with the second. The
// first recording then had no surface left: its files are on disk, its walk is long since reset by
// the focus effect, and the startup orphan scan — the only other thing that would ever find it —
// does not run again for the rest of the shell lifecycle. It became invisible until sign-out or a
// process restart, with nobody told there was anything to look for.
//
// A queue that refuses twice is refusing for a reason that has not gone away (a full phone, a
// broken manifest write), so two-in-a-row is the EXPECTED shape of this failure, not a corner case.
describe("WalkScreen with more than one refused filing", () => {
  /**
   * Record a walk under `targetName` and let its enqueue fail with `message` — then leave the screen
   * as the focus reset leaves it (idle, no walkId), which is what the estimator's next walk starts
   * from and what takes the screen's copy of the walk away.
   */
  async function failToQueue(
    view: ReturnType<typeof render>,
    walkId: string,
    dealId: string,
    targetName: string,
    message: string,
  ) {
    mockParams = { dealId, targetName, projectId: undefined, propertyAddress: undefined };
    mockResult = resultFor(makeWalk("recording", { dealId }), { walkId });
    await act(async () => {
      view.rerender(<WalkScreen />);
    });

    mockEnqueueWalk.mockImplementationOnce(() => Promise.reject(new Error(message)));
    mockResult = resultFor(makeWalk("complete", { dealId }), { walkId });
    await act(async () => {
      view.rerender(<WalkScreen />);
    });

    // What reset() leaves behind when the estimator navigates away and back before starting again.
    mockResult = resultFor(makeWalk("idle", { dealId }), { walkId: null });
    await act(async () => {
      view.rerender(<WalkScreen />);
    });
  }

  it("keeps the first refused walk on screen when a second one is also refused", async () => {
    mockResult = resultFor(makeWalk("idle"));
    const view = render(<WalkScreen />);

    await failToQueue(view, "walk-1", "deal-1", "Riverside Plaza", "ENOSPC: no space left");
    await failToQueue(view, "walk-2", "deal-2", "Northgate Depot", "EIO: manifest write failed");

    // Both, verbatim and side by side. The first walk is the one at risk: nothing else in the app
    // will mention it again this session.
    expect(view.getByText(/ENOSPC: no space left/)).toBeTruthy();
    expect(view.getByText(/EIO: manifest write failed/)).toBeTruthy();
    expect(view.getAllByText("This walk has not been queued")).toHaveLength(2);
    expect(view.getAllByText("Try again")).toHaveLength(2);
    // And each says WHICH walk it is about — two identical notices would leave the estimator
    // retrying one of them twice and never learning which recording is still unfiled. Read off the
    // retry buttons' own labels, which is where a screen reader gets the same distinction (the
    // target name alone appears elsewhere on this screen, on the "About to record" card).
    expect(view.getByLabelText(/Try queueing this walk again — .*Riverside Plaza/)).toBeTruthy();
    expect(view.getByLabelText(/Try queueing this walk again — .*Northgate Depot/)).toBeTruthy();
  });

  it("retries each walk with ITS OWN recording and metadata, not the newest one's", async () => {
    mockResult = resultFor(makeWalk("idle"));
    const view = render(<WalkScreen />);

    await failToQueue(view, "walk-1", "deal-1", "Riverside Plaza", "ENOSPC: no space left");
    await failToQueue(view, "walk-2", "deal-2", "Northgate Depot", "EIO: manifest write failed");

    const [, firstWalkId, firstWalk, firstMeta] = mockEnqueueWalk.mock.calls[0]!;
    mockEnqueueWalk.mockClear();

    // The FIRST notice's retry — the older walk, whose copy of everything the screen no longer has.
    await act(async () => {
      fireEvent.press(view.getAllByText("Try again")[0]!);
    });

    expect(mockEnqueueWalk).toHaveBeenCalledTimes(1);
    const [, retriedWalkId, retriedWalk, retriedMeta] = mockEnqueueWalk.mock.calls[0]!;
    expect(retriedWalkId).toBe(firstWalkId);
    expect(retriedWalk).toEqual(firstWalk);
    expect(retriedMeta).toEqual(firstMeta);
    expect((retriedWalk as Walk).dealId).toBe("deal-1");
    expect((retriedMeta as { title: string }).title).toContain("Riverside Plaza");
  });

  it("clears only the walk that queued, leaving the other one still asking", async () => {
    mockResult = resultFor(makeWalk("idle"));
    const view = render(<WalkScreen />);

    await failToQueue(view, "walk-1", "deal-1", "Riverside Plaza", "ENOSPC: no space left");
    await failToQueue(view, "walk-2", "deal-2", "Northgate Depot", "EIO: manifest write failed");

    await act(async () => {
      fireEvent.press(view.getAllByText("Try again")[0]!);
    });

    expect(view.queryByText(/ENOSPC: no space left/)).toBeNull();
    expect(view.getByText(/EIO: manifest write failed/)).toBeTruthy();
    expect(view.getAllByText("Try again")).toHaveLength(1);
  });

  // GUARD (passes before this change too): one refused filing must still read exactly as it did —
  // one notice, one retry, the queue's own words. The collection is for the SECOND failure; it must
  // not turn the ordinary single failure into a list of one that reads differently.
  it("still announces a single refused filing exactly as before", async () => {
    mockResult = resultFor(makeWalk("idle"));
    const view = render(<WalkScreen />);

    await failToQueue(view, "walk-1", "deal-1", "Riverside Plaza", "ENOSPC: no space left");

    expect(view.getByText("This walk has not been queued")).toBeTruthy();
    expect(view.getByText(/ENOSPC: no space left/)).toBeTruthy();
    expect(view.getByText("Try again")).toBeTruthy();
  });
});
