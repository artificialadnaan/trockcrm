// The seam that makes upload.ts's teardown-aware recovery scan real rather than theoretical: unless
// something actually registers an in-flight endWalk, `walkTeardownsInFlight()` is always empty and
// the scan is back to reading a directory native is still writing.
//
// It is registered HERE, at the one wrapper every endWalk goes through, rather than at the two call
// sites in useWalk that issue them. Both of those are real races — the detached unmount teardown AND
// an end() the estimator tapped a moment before signing out — so a per-caller registration is one a
// future third caller can forget, at a seam where forgetting is silent and only shows up as a walk
// mislabelled unplayable. Which walk is being torn down is knowable here because native's recorder
// is a singleton: one walk slot, claimed by startWalk and released by teardown, so the last id
// started IS the one being ended.
import { NativeModules } from "react-native";

const nativeStartWalk = jest.fn();
const nativeEndWalk = jest.fn();
(NativeModules as unknown as Record<string, unknown>).WalkthroughRecorder = {
  startWalk: (walkId: string) => nativeStartWalk(walkId),
  captureStill: jest.fn(),
  endWalk: () => nativeEndWalk(),
};

// Required AFTER the line above, deliberately: native.ts resolves NativeModules.WalkthroughRecorder
// once, at module load, so an ES import (hoisted above it) would capture `undefined`.
const { Recorder } = require("../native") as typeof import("../native");
const { walkTeardownsInFlight } = require("../walk-teardown") as typeof import("../walk-teardown");

beforeEach(() => {
  nativeStartWalk.mockReset();
  nativeEndWalk.mockReset();
  nativeStartWalk.mockResolvedValue({});
});

describe("Recorder.endWalk teardown tracking", () => {
  it("claims the walk while native is finalizing it, and releases it when native answers", async () => {
    let finish!: () => void;
    nativeEndWalk.mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve({ videoUri: "file:///walk.mp4", stills: 2 });
      }),
    );
    void Recorder.startWalk("walk-77", "user-1:office-a");

    const ended = Recorder.endWalk();
    // Synchronously, not after an await: the recovery scan can be kicked off by the incoming shell's
    // mount effect in the very tick the outgoing one issued this.
    expect(walkTeardownsInFlight()).toEqual(["walk-77"]);

    finish();
    await ended;
    expect(walkTeardownsInFlight()).toEqual([]);
  });

  it("releases the claim when native REJECTS too — a failed finalize is still a finished write", async () => {
    // endWalk rejects for a writer that could not finalize, and native has already run its own
    // teardown by then. Holding the claim past that would hide the directory from every scan for the
    // life of the process — the walk this path exists to save, made invisible by the machinery
    // saving it.
    nativeEndWalk.mockRejectedValue(new Error("walk_video_finalize_failed"));
    void Recorder.startWalk("walk-88", "user-1:office-a");

    await expect(Recorder.endWalk()).rejects.toThrow("walk_video_finalize_failed");
    expect(walkTeardownsInFlight()).toEqual([]);
  });
});
