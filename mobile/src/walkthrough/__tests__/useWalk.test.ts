import { act, renderHook } from "@testing-library/react-native";

/** The signed-in identity a walk is stamped with at start. `../native` is mocked wholesale below, so
 *  these tests never reach the filesystem — what they pin is that useWalk REFUSES to start without an
 *  owner, and passes the one it has through to the recorder. */
const TEST_OWNER = "user-1:office-a";

const mockStartWalk = jest.fn();
const mockCaptureStill = jest.fn();
const mockEndWalk = jest.fn();
/** What `walk.mp4` currently weighs on disk. The hook watches the file itself rather than guessing
 *  from a bitrate — the glasses' encoder is not ours to predict — so this is the whole input to the
 *  size bound below. */
const mockVideoBytes = { size: 0 };
jest.mock("expo-file-system/legacy", () => ({
  getInfoAsync: async () => ({ exists: true, size: mockVideoBytes.size }),
}));
let stillListener: ((still: { uri: string; bytes: number; source: string }) => void) | null = null;
let errorListener: ((error: { message: string }) => void) | null = null;

jest.mock("../native", () => ({
  isAvailable: true,
  Recorder: {
    // BOTH arguments forwarded. `Recorder.startWalk(walkId, ownerKey)` stamps the walk's directory
    // with the signed-in identity before native writes a byte (native.ts's claimWalkDirForOwner), so
    // a mock that dropped the second argument could not tell a walk stamped with the right owner
    // from one stamped with nothing.
    startWalk: (id: string, ownerKey: string) => mockStartWalk(id, ownerKey),
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
// The REAL wearables module: what is under test is whether the hook reads back what the root layout
// retained, so mocking the store would test the mock. Only its native bridge is absent here, which is
// fine — `setStartupConfigureError`/`getStartupConfigureError` are plain module state.
import { setStartupConfigureError } from "../../wearables/native";

/** A rejection shaped the way React Native delivers `reject(code, message, nil)` from Swift: the code
 *  on `.code`, the human sentence on `.message`. Anything that reads only one of the two is exactly
 *  the defect this helper exists to stop a fixture from hiding. */
function nativeReject(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Verbatim from WalkthroughRecorder.swift's `guard WearablesBridge.configured` reject — spaces, not
 *  underscores, which is the whole point. */
const NOT_CONFIGURED_MESSAGE = "Wearables SDK is not configured. Check Profile's pairing row for the real cause.";
import {
  isAudioTruncated,
  isVideoTruncated,
  MAX_WALK_ARTIFACTS,
  WALK_VIDEO_WARN_BYTES,
} from "../session";

beforeEach(() => {
  // Module state survives between tests in one file, and a leaked cause would silently change what
  // every later refusal renders.
  setStartupConfigureError(null);
  mockStartWalk.mockReset();
  mockCaptureStill.mockReset();
  mockEndWalk.mockReset();
  mockVideoBytes.size = 0;
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
    const { result } = renderHook(() => useWalk("deal-1", "proj-7", TEST_OWNER));

    expect(result.current.walk.state).toBe("idle");

    await act(async () => {
      await result.current.start();
    });

    expect(mockStartWalk).toHaveBeenCalledTimes(1);
    const usedId = mockStartWalk.mock.calls[0]![0] as string;
    // Safe as a directory component: no slashes, colons, or spaces.
    expect(usedId).toMatch(/^[a-z0-9-]+$/);
    // GUARD: the identity reaches the recorder, which is what stamps the walk directory with it
    // before the first byte. A hook that minted the id and dropped the owner would record a walk no
    // account can be shown to own — recoverable by nobody.
    expect(mockStartWalk).toHaveBeenCalledWith(usedId, TEST_OWNER);
    expect(result.current.walk.state).toBe("recording");
    expect(result.current.error).toBeNull();
    // Exposed so a caller can enqueue this walk once it reaches a terminal state — session.ts's Walk
    // carries no id of its own, so this is the only place it's available.
    expect(result.current.walkId).toBe(usedId);
  });

  // GUARD (holds before this suite covered it too — the refusal itself is not new). Here because the
  // file's own header claims these tests pin it and nothing did: `useWalkQueueSession` resolves the
  // owner asynchronously, so this screen really does render for a frame or two without one, and the
  // whole recovery path depends on the walk directory being stamped. Recording anyway costs the
  // walk — an unstamped directory is one the recovery scan can only ever offer to nobody; refusing
  // costs a retriable message, which is what the failed state carries.
  it("REFUSES to record without a signed-in owner, rather than starting an unattributable walk", async () => {
    const { result } = renderHook(() => useWalk("deal-1", null, null));

    await act(async () => {
      await result.current.start();
    });

    // Never reached native: no directory, no writer, no microphone — nothing to own.
    expect(mockStartWalk).not.toHaveBeenCalled();
    expect(result.current.walk.state).toBe("failed");
    expect(result.current.error).not.toBeNull();
    // Retriable, and it says what to do — the owner arrives a moment later on its own.
    expect(result.current.error).toMatch(/Not signed in/);
  });

  it("exposes null walkId before a walk has ever started", () => {
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));
    expect(result.current.walkId).toBeNull();
  });

  // Even a walk that fails at startWalk() itself is still "that" id — the id was already handed to
  // native before the rejection, so a caller reading walkId off a failed state must see it populated.
  it("keeps the minted walkId even when start() rejects", async () => {
    mockStartWalk.mockRejectedValue(new Error("walk_no_hfp: RB Meta 014K"));
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.walk.state).toBe("failed");
    expect(result.current.walkId).not.toBeNull();
  });

  // The exact defect called out in the plan: captureStill() resolving with `requested: false`
  // means no still event will ever follow. A hook that awaits and does nothing here would leave
  // the caller believing a still was taken.
  // A bridge method can throw SYNCHRONOUSLY — a missing native module, or an argument the bridge
  // rejects before it ever returns a promise. With the native call outside the try, that exception
  // escaped start() entirely: no "failed" dispatch, the walk stuck in "starting" forever, and
  // startInFlightRef left set so every later start was refused too. One synchronous throw wedged
  // the feature permanently.
  it("fails the walk (and stays startable) when the bridge throws synchronously", async () => {
    mockStartWalk
      .mockImplementationOnce(() => {
        throw new Error("walk_module_missing");
      })
      // The SECOND start must behave normally — the point of the test is that the synchronous throw
      // did not leave startInFlightRef holding a lock nobody can release.
      .mockResolvedValue({ videoUri: "file:///walkthroughs/walk-1/walk.mp4" });
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.walk.state).toBe("failed");
    expect(result.current.error).toContain("walk_module_missing");

    // The wedge check: a second start must still be accepted after the reset.
    await act(async () => {
      result.current.reset();
    });
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.walk.state).toBe("recording");
  });

  it("surfaces an error when captureStill reports requested: false, without failing the walk", async () => {
    mockStartWalk.mockResolvedValue({
      walkId: "w1",
      directory: "d",
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      inputPortName: "RB Meta 014K",
      negotiatedSampleRate: 16000,
    });
    mockCaptureStill.mockResolvedValue({ requested: false });
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

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
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

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
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

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
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.error).toBe("walk_no_hfp: RB Meta 014K");
    expect(result.current.walk.state).toBe("failed");
    expect(result.current.walk.error).toBe("walk_no_hfp: RB Meta 014K");
  });

  it("REGRESSION: explains a not_configured refusal with the launch-time cause the root layout retained", async () => {
    // `walk_not_configured` is native saying the SDK was never configured. It cannot say WHY, because
    // the failure happened in the root layout's `configure()` at launch — possibly on a screen this
    // estimator never opened. The layout retains that cause via `setStartupConfigureError`, and
    // nothing in the app read it back: the setter had no matching getter call anywhere, so the real
    // reason (a credential, an SDK init failure) sat in a module variable one import away while the
    // estimator was shown a refusal with no remedy in it.
    setStartupConfigureError(new Error("MetaAppID rejected: invalid client token"));
    // The REAL rejection shape. WalkthroughRecorder.swift calls
    // `reject("walk_not_configured", "Wearables SDK is not configured. …", nil)`, and React Native puts
    // the first argument on `err.code` and the second on `err.message`. The first version of this test
    // built `new Error("walk_not_configured")` — the CODE where the message goes — so it passed against
    // a check that could never have matched in production. A fixture that cannot fail for the right
    // reason is the only thing a regression test must not be.
    mockStartWalk.mockRejectedValue(nativeReject("walk_not_configured", NOT_CONFIGURED_MESSAGE));
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });

    // Native's text still LEADS — it names the state. The cause is appended, because it names the fix.
    const expected = `${NOT_CONFIGURED_MESSAGE} — MetaAppID rejected: invalid client token`;
    expect(result.current.error).toBe(expected);
    expect(result.current.walk.error).toBe(expected);
  });

  it("GUARD: does not staple the startup cause onto an unrelated refusal", async () => {
    // The retained cause explains exactly one refusal. Appending it to `walk_no_hfp` — a live audio
    // routing problem — would send the estimator after a launch-time credential for a fault that has
    // nothing to do with it.
    setStartupConfigureError(new Error("MetaAppID rejected: invalid client token"));
    mockStartWalk.mockRejectedValue(nativeReject("walk_no_hfp", "walk_no_hfp: RB Meta 014K"));
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.error).toBe("walk_no_hfp: RB Meta 014K");
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
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

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
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

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
      ({ dealId, projectId }: { dealId: string; projectId: string | null }) => useWalk(dealId, projectId, TEST_OWNER),
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
      ({ dealId, projectId }: { dealId: string; projectId: string | null }) => useWalk(dealId, projectId, TEST_OWNER),
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

  // The P1 bug this closes: an estimator recording a walk switches tabs, picks a DIFFERENT deal
  // in Capture, and returns to the walk route — the route re-renders this hook with a new
  // (dealId, projectId) while native is still actively recording. The auto-reset used to fire
  // unconditionally here, wiping the walk id/stills/dealId without ever ending or enqueuing the
  // recording — the next start() then tore down the orphaned native session with nothing to show
  // for it. Fixed: an active recording must never be silently discarded, so it keeps running,
  // still filed against the deal it actually started against (walk.dealId, which is what
  // enqueueWalk/upload.ts key the server upload on — NOT the screen's live route params).
  it("does NOT discard an ACTIVE recording when (dealId, projectId) changes mid-walk — it keeps running under its ORIGINAL deal", async () => {
    mockStartWalk.mockResolvedValue({
      walkId: "w1",
      directory: "d",
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      inputPortName: "RB Meta 014K",
      negotiatedSampleRate: 16000,
    });

    const { result, rerender } = renderHook(
      ({ dealId, projectId }: { dealId: string; projectId: string | null }) => useWalk(dealId, projectId, TEST_OWNER),
      { initialProps: { dealId: "deal-1", projectId: null as string | null } },
    );

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.walk.state).toBe("recording");
    const walkIdAtStart = result.current.walkId;

    // A still captured before the switch, to confirm nothing captured so far is discarded either.
    act(() => {
      stillListener!({ uri: "file:///s0.jpg", bytes: 1, source: "glasses" });
    });
    expect(result.current.stillCount).toBe(1);

    // The estimator switches to a DIFFERENT deal and returns to this screen.
    rerender({ dealId: "deal-2", projectId: "proj-9" });

    // Must NOT have been torn down: still recording, still attached to the ORIGINAL deal, same
    // walk id, same captured still — none of it silently discarded, and not re-attached to the
    // NEW deal either (that would be filing the walk against the wrong site).
    expect(result.current.walk.state).toBe("recording");
    expect(result.current.walk.dealId).toBe("deal-1");
    expect(result.current.walk.projectId).toBeNull();
    expect(result.current.walkId).toBe(walkIdAtStart);
    expect(result.current.stillCount).toBe(1);

    // Re-rendering again with the SAME new identity must not be treated as a further change —
    // the walk should just keep running, exactly as before.
    rerender({ dealId: "deal-2", projectId: "proj-9" });
    expect(result.current.walk.state).toBe("recording");
    expect(result.current.walk.dealId).toBe("deal-1");
  });

  // The other half of the fix: an explicit reset() the SCREEN can call (e.g. on route focus,
  // once the walk is terminal), independent of a prop/identity change.
  it("reset() snaps a terminal walk back to fresh idle for the current deal", async () => {
    mockStartWalk.mockRejectedValue(new Error("walk_no_hfp: RB Meta 014K"));
    const { result } = renderHook(() => useWalk("deal-1", "proj-7", TEST_OWNER));

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

  // reset() is documented as "only call once terminal," but must refuse a misuse too — the same
  // invariant reduceWalk itself enforces (session.ts's isWalkActive), just also applied here so
  // walkId/error (state the reducer has no say over) can't be wiped out from under a walk that is
  // still actually recording.
  it("reset() is a no-op while the walk is ACTIVE (recording), even though it's not terminal", async () => {
    mockStartWalk.mockResolvedValue({
      walkId: "w1",
      directory: "d",
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      inputPortName: "RB Meta 014K",
      negotiatedSampleRate: 16000,
    });
    const { result } = renderHook(() => useWalk("deal-1", "proj-7", TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.walk.state).toBe("recording");
    const walkIdAtStart = result.current.walkId;

    act(() => {
      result.current.reset();
    });

    expect(result.current.walk.state).toBe("recording");
    expect(result.current.walk.dealId).toBe("deal-1");
    expect(result.current.walkId).toBe(walkIdAtStart);
  });

  describe("captureEnabled / atCaptureLimit", () => {
    it("captureEnabled is false and atCaptureLimit is false before recording starts", () => {
      const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));
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
      const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

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

  describe("in-flight capture accounting", () => {
    // The P2 bug this closes: captureStill() resolves the instant the request is ACCEPTED, not
    // when the photo is actually delivered — that arrives later on a separate `walkthrough:still`
    // event. `walk.stills` only reflects DELIVERED photos, so two capture() calls issued
    // back-to-back (before either's still has landed) used to both read the same pre-capture
    // count and both pass, letting the walk's eventual completion payload exceed the server's cap
    // after every byte was already uploaded. Only ONE of two such calls must actually reach
    // native.
    it("refuses a second capture() before the first request's photo has been delivered, once only one slot remains", async () => {
      mockStartWalk.mockResolvedValue({
        walkId: "w1",
        directory: "d",
        videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
        inputPortName: "RB Meta 014K",
        negotiatedSampleRate: 16000,
      });
      mockCaptureStill.mockResolvedValue({ requested: true });
      const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

      await act(async () => {
        await result.current.start();
      });

      // Fill to exactly one remaining slot: MAX_WALK_ARTIFACTS - 2 delivered stills, the video
      // artifact accounting for the other reserved slot (same boundary as canCaptureMore's own
      // test in session.test.ts).
      act(() => {
        for (let i = 0; i < MAX_WALK_ARTIFACTS - 2; i++) {
          stillListener!({ uri: `file:///s${i}.jpg`, bytes: 1, source: "phone" });
        }
      });
      expect(result.current.stillCount).toBe(MAX_WALK_ARTIFACTS - 2);
      expect(result.current.captureEnabled).toBe(true);

      // Two fast taps, back to back — both calls share the exact same render's `capture`
      // closure, since no re-render happens between them (mirrors what two real Pressable taps
      // in quick succession do).
      await act(async () => {
        await Promise.all([result.current.capture(), result.current.capture()]);
      });

      // Only ONE tap should have actually reached native — the second must have been refused
      // because the first request was already "in flight" (accepted, not yet delivered), even
      // though NEITHER photo had landed in `walk.stills` yet when the second tap was checked.
      expect(mockCaptureStill).toHaveBeenCalledTimes(1);
    });

    it("releases the in-flight reservation once the request's still is delivered, restoring the real remaining count", async () => {
      mockStartWalk.mockResolvedValue({
        walkId: "w1",
        directory: "d",
        videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
        inputPortName: "RB Meta 014K",
        negotiatedSampleRate: 16000,
      });
      mockCaptureStill.mockResolvedValue({ requested: true });
      const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

      await act(async () => {
        await result.current.start();
      });
      act(() => {
        for (let i = 0; i < MAX_WALK_ARTIFACTS - 2; i++) {
          stillListener!({ uri: `file:///s${i}.jpg`, bytes: 1, source: "phone" });
        }
      });

      await act(async () => {
        await result.current.capture();
      });
      // The one remaining slot is now reserved (in flight) but not yet delivered.
      expect(result.current.stillCount).toBe(MAX_WALK_ARTIFACTS - 2);
      expect(result.current.captureEnabled).toBe(false);

      act(() => {
        stillListener!({ uri: "file:///delivered.jpg", bytes: 1, source: "phone" });
      });

      // Delivered: the reservation is released, but the walk is correctly AT the real cap now —
      // not stuck one slot short because of a leaked reservation.
      expect(result.current.stillCount).toBe(MAX_WALK_ARTIFACTS - 1);
      expect(result.current.captureEnabled).toBe(false);
      expect(result.current.atCaptureLimit).toBe(true);
    });

    // Explicitly the hazard called out in the fix: a request that is accepted but then REJECTED,
    // or that native later reports failed to write, must release its reservation — an in-flight
    // counter that only ever increments would wedge the CAPTURE button one slot short of the
    // real cap for the rest of the walk, which is worse than the race it replaces.
    it("releases the reservation when captureStill resolves requested:false, so the button does not wedge", async () => {
      mockStartWalk.mockResolvedValue({
        walkId: "w1",
        directory: "d",
        videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
        inputPortName: "RB Meta 014K",
        negotiatedSampleRate: 16000,
      });
      const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

      await act(async () => {
        await result.current.start();
      });
      act(() => {
        for (let i = 0; i < MAX_WALK_ARTIFACTS - 2; i++) {
          stillListener!({ uri: `file:///s${i}.jpg`, bytes: 1, source: "phone" });
        }
      });
      expect(result.current.captureEnabled).toBe(true);

      mockCaptureStill.mockResolvedValue({ requested: false });
      await act(async () => {
        await result.current.capture();
      });
      expect(result.current.error).not.toBeNull();

      // Rejected outright — no `still` event will EVER follow, so the reservation must already
      // be gone: the one real remaining slot is available again.
      expect(result.current.captureEnabled).toBe(true);
      expect(result.current.atCaptureLimit).toBe(false);

      mockCaptureStill.mockResolvedValue({ requested: true });
      await act(async () => {
        await result.current.capture();
      });
      expect(mockCaptureStill).toHaveBeenCalledTimes(2);
    });

    it("releases the reservation when native reports the still failed to write (walkthrough:error), not just on delivery", async () => {
      mockStartWalk.mockResolvedValue({
        walkId: "w1",
        directory: "d",
        videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
        inputPortName: "RB Meta 014K",
        negotiatedSampleRate: 16000,
      });
      mockCaptureStill.mockResolvedValue({ requested: true });
      const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

      await act(async () => {
        await result.current.start();
      });
      act(() => {
        for (let i = 0; i < MAX_WALK_ARTIFACTS - 2; i++) {
          stillListener!({ uri: `file:///s${i}.jpg`, bytes: 1, source: "phone" });
        }
      });

      await act(async () => {
        await result.current.capture();
      });
      expect(result.current.captureEnabled).toBe(false); // reserved, awaiting delivery

      // No `still` event ever arrives for this one — instead native reports it failed to write.
      act(() => {
        errorListener!({ message: "still write failed: disk full" });
      });

      expect(result.current.stillCount).toBe(MAX_WALK_ARTIFACTS - 2); // never delivered
      expect(result.current.captureEnabled).toBe(true); // but the slot is free again
    });
  });
});

// ── FINDING 1 (P1): a walk whose VIDEO source stopped early must not upload as a complete one ─────
//
// The failure these cover is silent by construction: when the glasses disconnect (or their
// publisher just goes quiet) while the phone microphone keeps feeding the writer, nothing ever
// fails. No append is attempted, so the writer-failure latch never trips, and AVAssetWriter
// finishes .completed with a perfectly valid walk.mp4 that happens to hold five seconds of picture
// against a twenty-minute site visit. `endWalk`'s census is the ONLY place that difference is
// visible, and it is visible only at this seam — after the file is closed, a frame that never
// arrived and a walk that genuinely lasted five seconds are indistinguishable.
describe("useWalk video-coverage check", () => {
  const STARTED = {
    walkId: "w1",
    directory: "d",
    videoUri: "file:///docs/walkthroughs/w1/PARTIAL.mp4",
    inputPortName: "RB Meta 014K",
    negotiatedSampleRate: 48000,
  };

  /** Drives Date.now() so the walk's wall-clock duration is exact rather than test-machine timing. */
  function withClock(): { advance: (ms: number) => void; restore: () => void } {
    let now = 1_700_000_000_000;
    const spy = jest.spyOn(Date, "now").mockImplementation(() => now);
    return {
      advance: (ms: number) => {
        now += ms;
      },
      restore: () => spy.mockRestore(),
    };
  }

  it("flags a 20-minute walk whose glasses stopped after 5 seconds — without failing it or dropping the video", async () => {
    const clock = withClock();
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockResolvedValue({
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      stills: 0,
      // Frames arrived for the first 5s and then stopped; the writer kept taking audio the whole
      // time, so it finished .completed with nothing latched.
      census: {
        videoFramesReceived: 150,
        videoFramesAppended: 150,
        videoFramesDropped: 0,
        audioBuffersAppended: 56_250,
        secondsSinceLastFrameArrived: 1_195,
        writerStatus: 2,
        writerError: "none",
        failedLatched: false,
      },
    });
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    clock.advance(20 * 60 * 1000);
    await act(async () => {
      await result.current.end();
    });

    // Evidence is NEVER discarded: five seconds of a job site is still five seconds of a job site,
    // and the stills are untouched by whatever the video transport did. So this stays "complete"
    // with its finalised video — marking it "failed" would drop the video entirely (upload-core's
    // toQueuedWalk only queues a video for a COMPLETE walk).
    expect(result.current.walk.state).toBe("complete");
    expect(result.current.walk.videoUri).toBe("file:///docs/walkthroughs/w1/walk.mp4");
    expect(result.current.walk.durationMs).toBe(20 * 60 * 1000);

    const coverage = result.current.walk.videoCoverage;
    expect(coverage).not.toBeNull();
    expect(coverage!.walkMs).toBe(20 * 60 * 1000);
    expect(coverage!.videoMs).toBe(5_000);
    expect(coverage!.shortfallMs).toBe(1_195_000);
    expect(isVideoTruncated(coverage)).toBe(true);
    clock.restore();
  });

  it("leaves a healthy walk unflagged — the last frame always lands a moment before the walk ends", async () => {
    const clock = withClock();
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockResolvedValue({
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      stills: 0,
      // ~1.2 frame intervals at 30fps plus the bridge hop — the normal end-of-walk picture.
      census: {
        videoFramesReceived: 36_000,
        videoFramesAppended: 36_000,
        videoFramesDropped: 0,
        audioBuffersAppended: 56_250,
        secondsSinceLastFrameArrived: 0.04,
        writerStatus: 2,
        writerError: "none",
        failedLatched: false,
      },
    });
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    clock.advance(20 * 60 * 1000);
    await act(async () => {
      await result.current.end();
    });

    expect(result.current.walk.state).toBe("complete");
    expect(isVideoTruncated(result.current.walk.videoCoverage)).toBe(false);
    clock.restore();
  });

  // The trap: native reports -1, not 0, when NO frame ever arrived (`lastFrameArrivedAt.isValid`
  // is false — WalkVideoWriter.census()). Read as a duration, -1 second of quiet is the healthiest
  // number in the whole range, so the obvious `quiet > tolerance` comparison would wave through the
  // single worst walk this recorder can produce: a video track with nothing in it at all.
  it("treats native's -1 'no frame ever arrived' sentinel as ZERO coverage, not as a healthy walk", async () => {
    const clock = withClock();
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockResolvedValue({
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      stills: 2,
      census: {
        videoFramesReceived: 0,
        videoFramesAppended: 0,
        videoFramesDropped: 0,
        audioBuffersAppended: 28_125,
        secondsSinceLastFrameArrived: -1,
        writerStatus: 2,
        writerError: "none",
        failedLatched: false,
      },
    });
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    clock.advance(10 * 60 * 1000);
    await act(async () => {
      await result.current.end();
    });

    expect(result.current.walk.state).toBe("complete");
    const coverage = result.current.walk.videoCoverage;
    expect(coverage!.videoMs).toBe(0);
    expect(coverage!.shortfallMs).toBe(10 * 60 * 1000);
    expect(isVideoTruncated(coverage)).toBe(true);
    clock.restore();
  });

  // An older dev client's endWalk resolves without a census at all. "Unknown" must not read as
  // "truncated" — an unverifiable walk is not a short one, and flagging every walk on a build that
  // cannot report would train the estimator to ignore the notice.
  it("leaves coverage unknown (null), not truncated, when native reports no census", async () => {
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockResolvedValue({ videoUri: "file:///docs/walkthroughs/w1/walk.mp4", stills: 0 });
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.end();
    });

    expect(result.current.walk.state).toBe("complete");
    expect(result.current.walk.videoCoverage).toBeNull();
    expect(isVideoTruncated(result.current.walk.videoCoverage)).toBe(false);
  });
});

// ── FINDING 2 (P1): unmounting mid-recording must stop the native recorder ─────────────────────────
//
// The estimator opens Profile mid-walk and signs out. `app/(app)/_layout.tsx`'s authenticated tab
// tree unmounts, taking this hook with it — but native is a singleton with its own lifetime: the
// DAT video stream, the phone microphone, and AVAssetWriter all keep running with nothing left in
// JS that knows the walkId. Enqueueing on the way out is not an option (ownerKey is already gone at
// sign-out), so the correct outcome is that native FINALISES to disk: `Documents/walkthroughs/
// <walkId>/walk.mp4` + `still-NNN.jpg` are exactly what upload.ts's findRecoverableWalks scans for
// at the next login.
describe("useWalk unmount while recording", () => {
  const STARTED = {
    walkId: "w1",
    directory: "d",
    videoUri: "file:///docs/walkthroughs/w1/PARTIAL.mp4",
    inputPortName: "RB Meta 014K",
    negotiatedSampleRate: 48000,
  };

  /** A native call left hanging on purpose, so a test can unmount while it is still in flight. */
  function pending(): { promise: Promise<unknown>; release: (value: unknown) => void } {
    let release!: (value: unknown) => void;
    const promise = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  it("stops the native recorder when the hook unmounts with a walk still recording", async () => {
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockResolvedValue({ videoUri: "file:///docs/walkthroughs/w1/walk.mp4", stills: 0 });
    const { result, unmount } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.walk.state).toBe("recording");
    expect(mockEndWalk).not.toHaveBeenCalled();

    await act(async () => {
      unmount();
    });

    expect(mockEndWalk).toHaveBeenCalledTimes(1);
  });

  it("does not touch native when the hook unmounts with no walk in flight", async () => {
    const { unmount } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));
    await act(async () => {
      unmount();
    });
    expect(mockEndWalk).not.toHaveBeenCalled();
  });

  it("does not touch native when the hook unmounts after the walk already completed", async () => {
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockResolvedValue({ videoUri: "file:///docs/walkthroughs/w1/walk.mp4", stills: 0 });
    const { result, unmount } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.end();
    });
    expect(mockEndWalk).toHaveBeenCalledTimes(1);

    await act(async () => {
      unmount();
    });

    expect(mockEndWalk).toHaveBeenCalledTimes(1); // the end() call, and nothing more
  });

  // A second endWalk while the first is still inside AVAssetWriter.finishWriting() would race two
  // finalisations against one writer. Unmounting during "finalizing" needs no help anyway: the
  // in-flight promise is unaffected by the unmount, and native's own teardown still runs.
  it("does not issue a SECOND endWalk when the hook unmounts while the first is still finalizing", async () => {
    mockStartWalk.mockResolvedValue(STARTED);
    const hangingEnd = pending();
    mockEndWalk.mockImplementation(() => hangingEnd.promise);
    const { result, unmount } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      void result.current.end();
    });
    expect(result.current.walk.state).toBe("finalizing");
    expect(mockEndWalk).toHaveBeenCalledTimes(1);

    await act(async () => {
      unmount();
    });

    expect(mockEndWalk).toHaveBeenCalledTimes(1);
    hangingEnd.release({ videoUri: "file:///docs/walkthroughs/w1/walk.mp4", stills: 0 });
  });

  // The narrower half of the same hazard, and the one the state check above cannot see. `end()`
  // assigns endInFlightRef and dispatches "ended" in ONE tick; React commits "finalizing" on a
  // LATER one. A sign-out landing between those two — the estimator taps "Yes, end walk", then
  // immediately opens Profile and signs out — finds walkStateRef still reading "recording", so the
  // cleanup's state check waves it through and issues a second endWalk against a walk that is
  // already inside AVAssetWriter.finishWriting(). Two Tasks then remove the same audio tap and
  // finalise the same writer.
  //
  // The unmount is deliberately in the SAME act() as end() and after it with no await between: that
  // is the only shape the bug has, and it is the shape a real sign-out produces. The mid-act
  // assertion is not decoration — it pins the precondition, so if React ever starts committing that
  // dispatch earlier this test fails loudly instead of quietly passing for the wrong reason.
  it("does not issue a SECOND endWalk when the tree unmounts before React commits finalizing", async () => {
    mockStartWalk.mockResolvedValue(STARTED);
    const hangingEnd = pending();
    mockEndWalk.mockImplementation(() => hangingEnd.promise);
    const { result, unmount } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.walk.state).toBe("recording");

    await act(async () => {
      void result.current.end();
      // Still the last COMMITTED state — "finalizing" has been dispatched but not rendered, which
      // is exactly the window the unmount below lands in.
      expect(result.current.walk.state).toBe("recording");
      unmount();
    });

    expect(mockEndWalk).toHaveBeenCalledTimes(1);
    hangingEnd.release({ videoUri: "file:///docs/walkthroughs/w1/walk.mp4", stills: 0 });
  });

  // Sign-out landing in the ~1s "Starting…" window. Native has no writer yet, so an endWalk issued
  // right now finalises nothing and tears down nothing — and the start it raced then goes on to
  // open the stream and the microphone with no JS left to ever close them.
  it("waits for an in-flight startWalk to settle before stopping, so the stop is not a no-op", async () => {
    const hangingStart = pending();
    mockStartWalk.mockImplementation(() => hangingStart.promise);
    mockEndWalk.mockResolvedValue({ videoUri: "file:///docs/walkthroughs/w1/walk.mp4", stills: 0 });
    const { result, unmount } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    act(() => {
      void result.current.start();
    });
    expect(result.current.walk.state).toBe("starting");

    act(() => {
      unmount();
    });
    expect(mockEndWalk).not.toHaveBeenCalled();

    await act(async () => {
      hangingStart.release(STARTED);
    });

    expect(mockEndWalk).toHaveBeenCalledTimes(1);
  });
});

// ── ROUND-4 FINDING 2 (P1): a walk whose NARRATION was truncated must say so ───────────────────────
//
// The audio half of the same silence the video census exists to break, and the more expensive half:
// the spoken narration is what scope extraction actually reads, so a walk with no usable phone-mic
// track is a site visit that has to be repeated even if every frame landed. When
// `audioInput.isReadyForMoreMediaData` goes false the writer drops the buffer and says nothing —
// the video track stays healthy, AVAssetWriter finishes .completed, and the walk uploads as
// complete with a fraction of the narration in it. Only the census can tell.
describe("useWalk audio-coverage check", () => {
  const STARTED = {
    walkId: "w1",
    directory: "d",
    videoUri: "file:///docs/walkthroughs/w1/PARTIAL.mp4",
    inputPortName: "iPhone Microphone",
    negotiatedSampleRate: 48000,
  };

  /** Drives Date.now() so the walk's wall-clock duration is exact rather than test-machine timing. */
  function withClock(): { advance: (ms: number) => void; restore: () => void } {
    let now = 1_700_000_000_000;
    const spy = jest.spyOn(Date, "now").mockImplementation(() => now);
    return {
      advance: (ms: number) => {
        now += ms;
      },
      restore: () => spy.mockRestore(),
    };
  }

  /** A healthy 20-minute video census, so an audio verdict is never an artifact of the video one. */
  const HEALTHY_VIDEO = {
    videoFramesReceived: 36_000,
    videoFramesAppended: 36_000,
    videoFramesDropped: 0,
    secondsSinceLastFrameArrived: 0.03,
    writerStatus: 2,
    writerError: "none",
    failedLatched: false,
  };

  it("flags a 20-minute walk whose audio stopped being accepted after 5 seconds — without failing it", async () => {
    const clock = withClock();
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockResolvedValue({
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      stills: 0,
      // The writer took ~5s of phone audio and then refused every buffer for the rest of the walk.
      // Nothing about this census looks like a failure: the video track is perfect, the writer
      // reached .completed, and no latch tripped.
      census: {
        ...HEALTHY_VIDEO,
        audioBuffersReceived: 56_250,
        audioBuffersAppended: 235,
        audioBuffersDropped: 56_015,
        audioSecondsAppended: 5,
        longestAudioDropRun: 56_015,
      },
    });
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    clock.advance(20 * 60 * 1000);
    await act(async () => {
      await result.current.end();
    });

    // Annotated, never downgraded: "failed" queues no video (upload-core's toQueuedWalk), which
    // would throw away twenty minutes of perfectly good footage over a bad audio track.
    expect(result.current.walk.state).toBe("complete");
    expect(result.current.walk.videoUri).toBe("file:///docs/walkthroughs/w1/walk.mp4");
    expect(isVideoTruncated(result.current.walk.videoCoverage)).toBe(false);

    const coverage = result.current.walk.audioCoverage;
    expect(coverage).not.toBeNull();
    expect(coverage!.walkMs).toBe(20 * 60 * 1000);
    expect(coverage!.audioMs).toBe(5_000);
    expect(coverage!.shortfallMs).toBe(1_195_000);
    expect(isAudioTruncated(coverage)).toBe(true);
    clock.restore();
  });

  it("leaves a healthy walk unflagged — the tap always stops a moment after the walk ends", async () => {
    const clock = withClock();
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockResolvedValue({
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      stills: 0,
      census: {
        ...HEALTHY_VIDEO,
        audioBuffersReceived: 56_250,
        audioBuffersAppended: 56_250,
        audioBuffersDropped: 0,
        // A shade OVER the walk clock: the tap is installed before startWalk resolves and removed
        // after endWalk is called, so a healthy walk holds marginally more audio than wall clock.
        audioSecondsAppended: 1_200.4,
        longestAudioDropRun: 0,
      },
    });
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    clock.advance(20 * 60 * 1000);
    await act(async () => {
      await result.current.end();
    });

    expect(result.current.walk.state).toBe("complete");
    expect(result.current.walk.audioCoverage!.shortfallMs).toBe(0);
    expect(isAudioTruncated(result.current.walk.audioCoverage)).toBe(false);
    clock.restore();
  });

  // The trap, and it is the video sentinel's mirror image. A dev client built before the audio
  // counters existed still resolves a census — just without them — so the field arrives
  // `undefined`. Zero is the WORST value in this range (no narration at all), so the obvious
  // `census.audioSecondsAppended ?? 0` would report every walk from that build as having recorded
  // nothing, and a warning that fires on every walk is a warning nobody reads.
  it("leaves audio coverage unknown (null), not zero, when the census predates the audio counters", async () => {
    const clock = withClock();
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockResolvedValue({
      videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
      stills: 0,
      census: { ...HEALTHY_VIDEO, audioBuffersAppended: 56_250 },
    });
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    clock.advance(20 * 60 * 1000);
    await act(async () => {
      await result.current.end();
    });

    expect(result.current.walk.state).toBe("complete");
    expect(result.current.walk.audioCoverage).toBeNull();
    expect(isAudioTruncated(result.current.walk.audioCoverage)).toBe(false);
    clock.restore();
  });
});

// ── ROUND-4 FINDING 3 (P2): a second start() must not reach the native singleton ───────────────────
//
// `start()` dispatches "starting" and then awaits native. React commits that dispatch on a LATER
// tick, so the reducer's own idle-only guard cannot see the first call yet: two taps landing in the
// same tick both read `idle`, both mint an id, and both call `Recorder.startWalk()`. Native is a
// singleton — one `session`, one `stream`, one `walkDirectory`, one writer — so the second start
// overwrites the first's state and the first recording is orphaned mid-walk.
describe("useWalk double-start guard", () => {
  const STARTED = {
    walkId: "w1",
    directory: "d",
    videoUri: "file:///docs/walkthroughs/w1/PARTIAL.mp4",
    inputPortName: "iPhone Microphone",
    negotiatedSampleRate: 48000,
  };

  it("refuses a second start() issued before the first has resolved", async () => {
    let release!: (value: unknown) => void;
    mockStartWalk.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    // Both calls in ONE act() and with no await between them: this is a double tap inside a single
    // tick, which is the only shape the bug has. Awaiting the first would let React commit
    // "starting" and the reducer would refuse the second on its own.
    await act(async () => {
      void result.current.start();
      void result.current.start();
      release(STARTED);
    });

    expect(mockStartWalk).toHaveBeenCalledTimes(1);
    expect(result.current.walk.state).toBe("recording");
  });

  // The in-flight promise is cleared once the first start resolves, so the promise guard alone
  // stops covering the walk the moment it is actually recording — which is exactly when a second
  // startWalk() would be most destructive (native tears the live session down to build a new one).
  it("refuses a start() once the walk is already recording", async () => {
    mockStartWalk.mockResolvedValue(STARTED);
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.walk.state).toBe("recording");

    await act(async () => {
      await result.current.start();
    });

    expect(mockStartWalk).toHaveBeenCalledTimes(1);
    expect(result.current.walk.state).toBe("recording");
  });

  // The guard must not be a one-way door: a walk that finished (or failed) has no native session
  // left, and the estimator has to be able to start the next one.
  it("allows a new start() once the previous walk has completed", async () => {
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockResolvedValue({ videoUri: "file:///docs/walkthroughs/w1/walk.mp4", stills: 0 });
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.end();
    });
    expect(result.current.walk.state).toBe("complete");

    act(() => {
      result.current.reset();
    });
    await act(async () => {
      await result.current.start();
    });

    expect(mockStartWalk).toHaveBeenCalledTimes(2);
    expect(result.current.walk.state).toBe("recording");
  });
});

// ── Round-6 FINDING 3 (P1): End walk is a second control that native cannot serve twice ───────────
//
// `start()` has had a synchronous in-flight guard since the double-start fix; `end()` had none, so
// two taps landing before React commits "finalizing" both reached Recorder.endWalk(). Native
// launches an INDEPENDENT Task per call: they race to remove the same audio tap, finalise the same
// AVAssetWriter, and tear down the same singleton. The reducer cannot help — its "ended" guard only
// sees state that has already been committed, which is exactly what has not happened yet.
describe("useWalk double-end guard", () => {
  const STARTED = {
    walkId: "w1",
    directory: "d",
    videoUri: "file:///docs/walkthroughs/w1/PARTIAL.mp4",
    inputPortName: "iPhone Microphone",
    negotiatedSampleRate: 48000,
  };
  const FINALIZED = { videoUri: "file:///docs/walkthroughs/w1/walk.mp4", stills: 0 };

  it("refuses a second end() issued before the first has resolved", async () => {
    mockStartWalk.mockResolvedValue(STARTED);
    let release!: (value: unknown) => void;
    mockEndWalk.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));
    await act(async () => {
      await result.current.start();
    });

    // Both calls in ONE act() with no await between them — a double tap inside a single tick, the
    // only shape the bug has. Awaiting the first would let React commit "finalizing" and the
    // reducer would absorb the second on its own.
    await act(async () => {
      void result.current.end();
      void result.current.end();
      release(FINALIZED);
    });

    expect(mockEndWalk).toHaveBeenCalledTimes(1);
    expect(result.current.walk.state).toBe("complete");
  });

  // The guard must not be a one-way door: it is cleared when the call it covers settles, so the
  // NEXT walk on this same mounted screen can still be ended. (Passes before the fix too — it is a
  // guard against the fix over-reaching, not a reproduction of the bug.)
  it("still ends the NEXT walk after a previous end() resolved", async () => {
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockResolvedValue(FINALIZED);
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.end();
    });
    expect(result.current.walk.state).toBe("complete");

    act(() => {
      result.current.reset();
    });
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.end();
    });

    expect(mockEndWalk).toHaveBeenCalledTimes(2);
    expect(result.current.walk.state).toBe("complete");
  });

  // A rejected endWalk must release the guard too, or a walk that failed to finalise could never be
  // ended again — and the walk is terminal-failed at that point, so the next attempt is a NEW walk.
  it("releases the guard when endWalk rejects", async () => {
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockRejectedValueOnce(new Error("finishWriting failed")).mockResolvedValue(FINALIZED);
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.end();
    });
    expect(result.current.walk.state).toBe("failed");

    act(() => {
      result.current.reset();
    });
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.end();
    });
    expect(result.current.walk.state).toBe("complete");
  });
});

// ── Round-6 FINDING 4 (P1): a reservation belongs to a WALK, not to the hook ──────────────────────
//
// A capture request native accepts but never resolves — no `walkthrough:still`, no
// `walkthrough:error` — leaves its JS reservation held for good; nothing correlates a request to an
// outcome, so there is no timeout that could safely release it mid-walk. That is survivable within
// one walk. What is not is carrying it into the NEXT one: reset() cleared the reducer state and the
// walkId but not the in-flight count, so every later walk on the same mounted screen started one
// slot short of the server's artifact cap, permanently, and the CAPTURE button went dark early with
// nothing on screen able to explain why.
describe("useWalk in-flight reservations across walks", () => {
  const STARTED = {
    walkId: "w1",
    directory: "d",
    videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
    inputPortName: "iPhone Microphone",
    negotiatedSampleRate: 48000,
  };

  /**
   * How many capture requests this walk will actually let through, measured rather than asserted
   * about indirectly.
   *
   * Deliberately NOT measured by delivering stills up to the cap: a delivered still releases a
   * reservation generically (native carries no id, so useWalk releases the oldest outstanding one),
   * which means the very first delivery would ABSORB the ghost and hide the bug. Only requests that
   * stay outstanding accumulate against the cap, so only requests can reveal a stale one.
   */
  async function countAcceptedCaptures(capture: () => Promise<void>): Promise<number> {
    mockCaptureStill.mockClear();
    await act(async () => {
      for (let i = 0; i < MAX_WALK_ARTIFACTS + 1; i++) await capture();
    });
    return mockCaptureStill.mock.calls.length;
  }

  /** Every slot but the one the walk's own video occupies. */
  const FULL_ALLOWANCE = MAX_WALK_ARTIFACTS - 1;

  it("does not carry a never-resolved reservation from a finished walk into the next one", async () => {
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockResolvedValue({ videoUri: "file:///docs/walkthroughs/w1/walk.mp4", stills: 0 });
    mockCaptureStill.mockResolvedValue({ requested: true });
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    // Accepted by native, and then nothing — the photo never arrives and native never reports a
    // failure for it either. Held for the rest of THIS walk, which is correct.
    await act(async () => {
      await result.current.capture();
    });
    await act(async () => {
      await result.current.end();
    });
    act(() => {
      result.current.reset();
    });

    await act(async () => {
      await result.current.start();
    });

    expect(await countAcceptedCaptures(() => result.current.capture())).toBe(FULL_ALLOWANCE);
  });

  // The same leak reached via the OTHER reset path — a re-render against a different deal, which
  // walk.tsx can produce without any focus transition (it is a hidden Tabs.Screen).
  it("clears reservations when the walk is auto-reset by a change of target deal", async () => {
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockResolvedValue({ videoUri: "file:///docs/walkthroughs/w1/walk.mp4", stills: 0 });
    mockCaptureStill.mockResolvedValue({ requested: true });
    const { result, rerender } = renderHook(
      ({ dealId }: { dealId: string }) => useWalk(dealId, null, TEST_OWNER),
      { initialProps: { dealId: "deal-1" } },
    );

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.capture();
    });
    await act(async () => {
      await result.current.end();
    });
    act(() => {
      rerender({ dealId: "deal-2" });
    });
    expect(result.current.walk.state).toBe("idle");

    await act(async () => {
      await result.current.start();
    });

    expect(await countAcceptedCaptures(() => result.current.capture())).toBe(FULL_ALLOWANCE);
  });

  // Within ONE walk the reservation must still be honoured — the fix must not turn the cap gate
  // into a no-op. (Guard, not a regression: this held before the fix too.)
  it("still holds a reservation for the walk that made it", async () => {
    mockStartWalk.mockResolvedValue(STARTED);
    mockCaptureStill.mockResolvedValue({ requested: true });
    const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      for (let i = 0; i < MAX_WALK_ARTIFACTS - 2; i++) {
        stillListener!({ uri: `file:///s${i}.jpg`, bytes: 1, source: "phone" });
      }
    });
    await act(async () => {
      await result.current.capture();
    });

    expect(result.current.captureEnabled).toBe(false);
  });
});

// ── FINDING A (Codex): an unbounded recording against a bounded upload ─────────────────────────────
//
// A walk has no duration limit and the glasses' encoder has no output-bitrate limit this app sets, so
// a long enough recording produces a walk.mp4 larger than the 2 GiB the server accepts per artifact
// (glasses-walkthrough-service.ts's MAX_GLASSES_WALKTHROUGH_ARTIFACT_BYTES). Nothing downstream can
// recover from that: every presign for that video is refused on its size, the queue burns all five
// PUT attempts, and — because completion needs EVERY artifact — the stills beside it never file
// either. Retrying from the failed-walk card cannot change a file's size, and orphan recovery cannot
// offer a stills-only salvage because the manifest already claims the directory.
//
// The only moment the outcome is still open is DURING the recording, which is why the bound lives
// here. Ending the walk at the bound is not a loss: endWalk finalizes a valid, uploadable file and
// the estimator can start another walk on the same job immediately. Letting it run past the ceiling
// IS the loss — the whole video, not just the excess.
describe("useWalk recording-size bound", () => {
  const STARTED = {
    walkId: "w1",
    directory: "d",
    videoUri: "file:///docs/walkthroughs/w1/walk.mp4",
    inputPortName: "RB Meta 014K",
    negotiatedSampleRate: 48000,
  };
  const FINALIZED = { videoUri: "file:///docs/walkthroughs/w1/walk.mp4", stills: 0 };
  /** Half a gigabyte PAST the server's 2 GiB per-artifact ceiling — far enough that no headroom this
   *  module chooses could leave it filable. Stated as a literal rather than derived from the mirror
   *  constant so this case pins the server's rule, not our arithmetic about it. */
  const OVER_THE_SERVER_CEILING = 2.5 * 1024 * 1024 * 1024;

  async function recordingWalk() {
    mockStartWalk.mockResolvedValue(STARTED);
    mockEndWalk.mockResolvedValue(FINALIZED);
    const hook = renderHook(() => useWalk("deal-1", null, TEST_OWNER));
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.walk.state).toBe("recording");
    return hook;
  }

  it("ends the walk itself rather than letting walk.mp4 grow past what the server will accept", async () => {
    jest.useFakeTimers();
    try {
      const { result } = await recordingWalk();

      mockVideoBytes.size = OVER_THE_SERVER_CEILING;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });

      // Ended ONCE, through the ordinary path — so the writer finalizes and the file is a real,
      // uploadable recording rather than a truncated one.
      expect(mockEndWalk).toHaveBeenCalledTimes(1);
      expect(result.current.walk.state).toBe("complete");
      // …and the screen can say WHY, because a walk that stopped on its own with no explanation is
      // indistinguishable from one the estimator ended by accident.
      expect(result.current.stoppedAtSizeLimit).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("warns while there is still time to act, before it stops anything", async () => {
    jest.useFakeTimers();
    try {
      const { result } = await recordingWalk();
      expect(result.current.videoSize).toBe("ok");

      // Inside the warning margin but under the bound: the estimator gets told, the walk keeps
      // running, and ending it stays THEIR decision for as long as that is safe.
      mockVideoBytes.size = WALK_VIDEO_WARN_BYTES;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });

      expect(result.current.videoSize).toBe("nearLimit");
      expect(mockEndWalk).not.toHaveBeenCalled();
      expect(result.current.walk.state).toBe("recording");
    } finally {
      jest.useRealTimers();
    }
  });

  // GUARD: an ordinary walk must be untouched. A bound that fires on a normal site visit would be
  // worse than the failure it prevents — it would end walks that were never in danger.
  it("leaves an ordinary walk alone", async () => {
    jest.useFakeTimers();
    try {
      const { result } = await recordingWalk();

      mockVideoBytes.size = 400 * 1024 * 1024; // ~an hour of glasses video, comfortably filable
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10 * 60_000);
      });

      expect(result.current.videoSize).toBe("ok");
      expect(mockEndWalk).not.toHaveBeenCalled();
      expect(result.current.walk.state).toBe("recording");
    } finally {
      jest.useRealTimers();
    }
  });

  // A walk native reported no path for cannot be measured, and an unmeasurable walk must not be
  // stopped: the same rule the coverage verdicts follow for a census that never arrived (unknown is
  // not "bad"). Taking a site visit away over our own inability to read a file is the one outcome
  // this whole bound exists to avoid.
  it("never stops a walk it cannot measure", async () => {
    jest.useFakeTimers();
    try {
      mockStartWalk.mockResolvedValue({ ...STARTED, videoUri: null });
      mockEndWalk.mockResolvedValue(FINALIZED);
      mockVideoBytes.size = OVER_THE_SERVER_CEILING; // would stop it, if anything were reading it
      const { result } = renderHook(() => useWalk("deal-1", null, TEST_OWNER));
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });

      expect(result.current.videoSize).toBe("ok");
      expect(mockEndWalk).not.toHaveBeenCalled();
      expect(result.current.walk.state).toBe("recording");
    } finally {
      jest.useRealTimers();
    }
  });
});
