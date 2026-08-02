import { act, renderHook } from "@testing-library/react-native";

const mockStartWalk = jest.fn();
const mockCaptureStill = jest.fn();
const mockEndWalk = jest.fn();
let stillListener: ((still: { uri: string; bytes: number; source: string }) => void) | null = null;
let errorListener: ((error: { message: string }) => void) | null = null;

jest.mock("../native", () => ({
  isAvailable: true,
  Recorder: {
    startWalk: (id: string) => mockStartWalk(id),
    captureStill: () => mockCaptureStill(),
    endWalk: () => mockEndWalk(),
  },
  onStill: (cb: (still: { uri: string; bytes: number; source: string }) => void) => {
    stillListener = cb;
    return () => {
      stillListener = null;
    };
  },
  onRecorderError: (cb: (error: { message: string }) => void) => {
    errorListener = cb;
    return () => {
      errorListener = null;
    };
  },
}));

import { useWalk } from "../useWalk";
import { MAX_WALK_ARTIFACTS } from "../session";

beforeEach(() => {
  mockStartWalk.mockReset();
  mockCaptureStill.mockReset();
  mockEndWalk.mockReset();
  stillListener = null;
  errorListener = null;
});

describe("useWalk", () => {
  it("starts a walk with a filesystem-safe id and moves it to recording", async () => {
    mockStartWalk.mockResolvedValue({
      walkId: "w1",
      directory: "file:///docs/walkthroughs/w1",
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      inputPortName: "RB Meta 014K",
      negotiatedSampleRate: 16000,
    });
    const { result } = renderHook(() => useWalk("deal-1", "proj-7"));

    expect(result.current.walk.state).toBe("idle");

    await act(async () => {
      await result.current.start();
    });

    expect(mockStartWalk).toHaveBeenCalledTimes(1);
    const usedId = mockStartWalk.mock.calls[0]![0] as string;
    // Safe as a directory component: no slashes, colons, or spaces.
    expect(usedId).toMatch(/^[a-z0-9-]+$/);
    expect(result.current.walk.state).toBe("recording");
    expect(result.current.error).toBeNull();
    // Exposed so a caller can enqueue this walk once it reaches a terminal state — session.ts's Walk
    // carries no id of its own, so this is the only place it's available.
    expect(result.current.walkId).toBe(usedId);
  });

  it("exposes null walkId before a walk has ever started", () => {
    const { result } = renderHook(() => useWalk("deal-1", null));
    expect(result.current.walkId).toBeNull();
  });

  // Even a walk that fails at startWalk() itself is still "that" id — the id was already handed to
  // native before the rejection, so a caller reading walkId off a failed state must see it populated.
  it("keeps the minted walkId even when start() rejects", async () => {
    mockStartWalk.mockRejectedValue(new Error("walk_no_hfp: RB Meta 014K"));
    const { result } = renderHook(() => useWalk("deal-1", null));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.walk.state).toBe("failed");
    expect(result.current.walkId).not.toBeNull();
  });

  // The exact defect called out in the plan: captureStill() resolving with `requested: false`
  // means no still event will ever follow. A hook that awaits and does nothing here would leave
  // the caller believing a still was taken.
  it("surfaces an error when captureStill reports requested: false, without failing the walk", async () => {
    mockStartWalk.mockResolvedValue({
      walkId: "w1",
      directory: "d",
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      inputPortName: "RB Meta 014K",
      negotiatedSampleRate: 16000,
    });
    mockCaptureStill.mockResolvedValue({ requested: false });
    const { result } = renderHook(() => useWalk("deal-1", null));

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.capture();
    });

    expect(mockCaptureStill).toHaveBeenCalledTimes(1);
    expect(result.current.error).not.toBeNull();
    // The walk itself is still fine — one rejected still request is not a fatal error.
    expect(result.current.walk.state).toBe("recording");
    expect(result.current.stillCount).toBe(0);
  });

  it("does not call captureStill when the walk cannot capture (not recording)", async () => {
    const { result } = renderHook(() => useWalk("deal-1", null));

    await act(async () => {
      await result.current.capture();
    });

    expect(mockCaptureStill).not.toHaveBeenCalled();
  });

  it("appends a still when the native still event fires while recording", async () => {
    mockStartWalk.mockResolvedValue({
      walkId: "w1",
      directory: "d",
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      inputPortName: "RB Meta 014K",
      negotiatedSampleRate: 16000,
    });
    mockCaptureStill.mockResolvedValue({ requested: true });
    const { result } = renderHook(() => useWalk("deal-1", null));

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.capture();
    });

    expect(result.current.error).toBeNull();
    expect(stillListener).not.toBeNull();

    act(() => {
      stillListener!({ uri: "file:///still-1.jpg", bytes: 1024, source: "glasses" });
    });

    expect(result.current.stillCount).toBe(1);
    expect(result.current.walk.stills[0]!.uri).toBe("file:///still-1.jpg");
  });

  // Native's rejection message is the entire diagnostic value (e.g. names the audio input it
  // would have recorded from) and must reach the caller unmodified.
  it("propagates a native start rejection message verbatim and marks the walk failed", async () => {
    mockStartWalk.mockRejectedValue(new Error("walk_no_hfp: RB Meta 014K"));
    const { result } = renderHook(() => useWalk("deal-1", null));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.error).toBe("walk_no_hfp: RB Meta 014K");
    expect(result.current.walk.state).toBe("failed");
    expect(result.current.walk.error).toBe("walk_no_hfp: RB Meta 014K");
  });

  // The finalised path must come from endWalk, NOT from startWalk. Native only resolves endWalk
  // once AVAssetWriter reports .completed; the path known at start points at a file that is still
  // being written. Taking the wrong one hands the uploader a truncated .mp4 that looks like a
  // successful walk — worse than a failure, because nothing surfaces it.
  it("finalizes with the video uri from endWalk, not the one known at start", async () => {
    mockStartWalk.mockResolvedValue({
      walkId: "w1",
      directory: "d",
      videoUri: "file:///docs/walkthroughs/w1/PARTIAL.mp4",
      inputPortName: "RB Meta 014K",
      negotiatedSampleRate: 16000,
    });
    mockEndWalk.mockResolvedValue({
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      stills: 0,
    });
    const { result } = renderHook(() => useWalk("deal-1", null));

    await act(async () => {
      await result.current.start();
    });
    // Mid-walk the partial path is held deliberately: a walk that fails here still needs to know
    // where its file is, because a partial site visit is not a site visit that can be redone.
    expect(result.current.walk.videoUri).toBe("file:///docs/walkthroughs/w1/PARTIAL.mp4");

    await act(async () => {
      await result.current.end();
    });

    expect(result.current.walk.state).toBe("complete");
    expect(result.current.walk.videoUri).toBe("file:///docs/walkthroughs/w1/walk.mp4");
    // Null by design — audio is a track inside the .mp4, not a separate artifact.
    expect(result.current.walk.audioUri).toBeNull();
  });

  it("surfaces a recorder error event without disturbing the walk state", async () => {
    mockStartWalk.mockResolvedValue({
      walkId: "w1",
      directory: "d",
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      inputPortName: "RB Meta 014K",
      negotiatedSampleRate: 16000,
    });
    const { result } = renderHook(() => useWalk("deal-1", null));

    await act(async () => {
      await result.current.start();
    });

    expect(errorListener).not.toBeNull();
    act(() => {
      errorListener!({ message: "still write failed: disk full" });
    });

    expect(result.current.error).toBe("still write failed: disk full");
    expect(result.current.walk.state).toBe("recording");
  });

  // The bug this closes: walk.tsx is a hidden Tabs.Screen that never unmounts on navigation, so
  // returning here for a DIFFERENT deal used to find the reducer stuck in the PREVIOUS walk's
  // terminal state — absorbing every future "starting" event — while still carrying that walk's
  // stale dealId/videoUri/stills.
  it("resets to fresh idle for a NEW deal once the previous walk reached a terminal state", async () => {
    mockStartWalk.mockResolvedValue({
      walkId: "w1",
      directory: "d",
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      inputPortName: "RB Meta 014K",
      negotiatedSampleRate: 16000,
    });
    mockEndWalk.mockResolvedValue({ videoUri: "file:///docs/walkthroughs/w1/walk.mp4", stills: 0 });

    const { result, rerender } = renderHook(
      ({ dealId, projectId }: { dealId: string; projectId: string | null }) => useWalk(dealId, projectId),
      { initialProps: { dealId: "deal-1", projectId: null as string | null } },
    );

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.end();
    });
    expect(result.current.walk.state).toBe("complete");
    expect(result.current.walk.dealId).toBe("deal-1");
    const firstWalkId = result.current.walkId;
    expect(firstWalkId).not.toBeNull();

    rerender({ dealId: "deal-2", projectId: "proj-9" });

    expect(result.current.walk.state).toBe("idle");
    expect(result.current.walk.dealId).toBe("deal-2");
    expect(result.current.walk.projectId).toBe("proj-9");
    expect(result.current.walk.videoUri).toBeNull();
    expect(result.current.walkId).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("does NOT reset when re-rendered with the SAME (dealId, projectId)", async () => {
    mockStartWalk.mockResolvedValue({
      walkId: "w1",
      directory: "d",
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      inputPortName: "RB Meta 014K",
      negotiatedSampleRate: 16000,
    });
    mockEndWalk.mockResolvedValue({ videoUri: "file:///docs/walkthroughs/w1/walk.mp4", stills: 0 });

    const { result, rerender } = renderHook(
      ({ dealId, projectId }: { dealId: string; projectId: string | null }) => useWalk(dealId, projectId),
      { initialProps: { dealId: "deal-1", projectId: null as string | null } },
    );

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.end();
    });
    expect(result.current.walk.state).toBe("complete");

    rerender({ dealId: "deal-1", projectId: null });

    // Same target — this must NOT be treated as a fresh walk to start.
    expect(result.current.walk.state).toBe("complete");
  });

  // The other half of the fix: an explicit reset() the SCREEN can call (e.g. on route focus,
  // once the walk is terminal), independent of a prop/identity change.
  it("reset() snaps a terminal walk back to fresh idle for the current deal", async () => {
    mockStartWalk.mockRejectedValue(new Error("walk_no_hfp: RB Meta 014K"));
    const { result } = renderHook(() => useWalk("deal-1", "proj-7"));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.walk.state).toBe("failed");

    act(() => {
      result.current.reset();
    });

    expect(result.current.walk.state).toBe("idle");
    expect(result.current.walk.dealId).toBe("deal-1");
    expect(result.current.walk.projectId).toBe("proj-7");
    expect(result.current.walkId).toBeNull();
    expect(result.current.error).toBeNull();
  });

  describe("captureEnabled / atCaptureLimit", () => {
    it("captureEnabled is false and atCaptureLimit is false before recording starts", () => {
      const { result } = renderHook(() => useWalk("deal-1", null));
      expect(result.current.captureEnabled).toBe(false);
      expect(result.current.atCaptureLimit).toBe(false);
    });

    it("captureEnabled goes false — and atCaptureLimit true — once the walk hits the server's artifact cap, and capture() stops requesting new stills", async () => {
      mockStartWalk.mockResolvedValue({
        walkId: "w1",
        directory: "d",
        videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
        inputPortName: "RB Meta 014K",
        negotiatedSampleRate: 16000,
      });
      mockCaptureStill.mockResolvedValue({ requested: true });
      const { result } = renderHook(() => useWalk("deal-1", null));

      await act(async () => {
        await result.current.start();
      });
      expect(result.current.captureEnabled).toBe(true);
      expect(result.current.atCaptureLimit).toBe(false);

      // Drive the walk up to MAX_WALK_ARTIFACTS - 1 stills — the video artifact already accounts
      // for the other slot in the server's per-walk cap.
      act(() => {
        for (let i = 0; i < MAX_WALK_ARTIFACTS - 1; i++) {
          stillListener!({ uri: `file:///s${i}.jpg`, bytes: 1, source: "phone" });
        }
      });

      expect(result.current.stillCount).toBe(MAX_WALK_ARTIFACTS - 1);
      expect(result.current.captureEnabled).toBe(false);
      expect(result.current.atCaptureLimit).toBe(true);

      await act(async () => {
        await result.current.capture();
      });
      expect(mockCaptureStill).not.toHaveBeenCalled();
    });
  });
});
