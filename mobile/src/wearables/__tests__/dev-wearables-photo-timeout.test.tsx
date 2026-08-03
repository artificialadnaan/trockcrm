/**
 * Rung 7's "accepted, then nothing" case.
 *
 * `capturePhoto` resolves the moment the SDK TAKES the request; the image arrives later on the
 * photo event, or not at all. Without a deadline the rung sits on "waiting for image…" forever with
 * its RUN button disabled — indistinguishable from a slow transfer, and unrecoverable without
 * leaving the screen. The success path must be untouched by the fix, which is the second test here.
 */
import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { PhotoMeasurement } from "../native";

const mockUnsubscribe = jest.fn();
let mockPhotoListener: ((photo: PhotoMeasurement) => void) | null = null;
const mockCapturePhoto = jest.fn();

jest.mock("expo-linking", () => ({
  addEventListener: () => ({ remove: jest.fn() }),
}));

jest.mock("../native", () => ({
  isAvailable: true,
  onPhoto: (listener: (photo: PhotoMeasurement) => void) => {
    mockPhotoListener = listener;
    return mockUnsubscribe;
  },
  // Every rung reads a method off this object while the list is being built, so all of them have to
  // exist even though only capturePhoto is exercised.
  Wearables: {
    configure: jest.fn(),
    capabilities: jest.fn(),
    status: jest.fn(),
    diagnose: jest.fn(),
    checkHfpWithStream: jest.fn(),
    measureStreamWithoutAudio: jest.fn(),
    measureStreamWithPhoneAudio: jest.fn(),
    checkPhoneCameraDuringHfp: jest.fn(),
    startRegistration: jest.fn(),
    handleUrl: jest.fn(),
    requestCameraPermission: jest.fn(),
    startStream: jest.fn(),
    streamInfo: jest.fn(),
    stopStream: jest.fn(),
    capturePhoto: (...args: unknown[]) => mockCapturePhoto(...args),
    recordGlassesAudio: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import DevWearablesScreen from "../../../app/(app)/dev-wearables";

const PHOTO_RUNG_LABEL = "7  capturePhoto → size";

const arrivedPhoto: PhotoMeasurement = {
  bytes: 512_000,
  format: "jpeg",
  width: 1080,
  height: 1440,
  megapixels: 1.56,
  largerThanStreamCeiling: true,
  fileUri: "file:///tmp/photo.jpg",
};

beforeEach(() => {
  jest.useFakeTimers();
  mockPhotoListener = null;
  mockUnsubscribe.mockClear();
  mockCapturePhoto.mockReset().mockResolvedValue({ requested: true });
});

afterEach(() => {
  jest.useRealTimers();
});

/** Tap RUN on rung 7 and let capturePhoto's promise settle. */
async function runPhotoRung(press: (label: string) => void): Promise<void> {
  press(PHOTO_RUNG_LABEL);
  await act(async () => {});
}

describe("dev-wearables rung 7", () => {
  it("fails the rung when an accepted request never delivers an image", async () => {
    const { getByText, queryByText } = render(<DevWearablesScreen />);
    await runPhotoRung((label) => fireEvent.press(getByText(label)));

    expect(queryByText(/waiting for image/)).not.toBeNull();

    act(() => {
      jest.advanceTimersByTime(15_000);
    });

    expect(queryByText(/waiting for image/)).toBeNull();
    expect(queryByText(/accepted, then no image within 15s/)).not.toBeNull();
  });

  it("leaves a delivered photo alone, and does not fail it once the deadline passes", async () => {
    const { getByText, queryByText } = render(<DevWearablesScreen />);
    await runPhotoRung((label) => fireEvent.press(getByText(label)));

    act(() => mockPhotoListener?.(arrivedPhoto));
    expect(queryByText(/FULL-SENSOR/)).not.toBeNull();

    // Well past the deadline: the timer the request armed must have been cancelled by the arrival,
    // or a good measurement would be overwritten with a failure fifteen seconds after the fact.
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(queryByText(/accepted, then no image/)).toBeNull();
    expect(queryByText(/FULL-SENSOR/)).not.toBeNull();
  });

  it("clears the pending timer on unmount", async () => {
    // Identified by its delay rather than by a timer COUNT: pressing a Pressable arms RN's own
    // press-delay timers too, so a bare count cannot say which one survived — and "some timer is
    // left" is not the claim being made here.
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");
    const clearTimeoutSpy = jest.spyOn(global, "clearTimeout");

    const { getByText, unmount } = render(<DevWearablesScreen />);
    await runPhotoRung((label) => fireEvent.press(getByText(label)));

    const armed = setTimeoutSpy.mock.calls
      .map((call, i) => ({ delay: call[1], id: setTimeoutSpy.mock.results[i].value }))
      .filter((t) => t.delay === 15_000);
    expect(armed).toHaveLength(1);

    unmount();

    // A surviving timer calls setState on an unmounted screen, and nothing else in this component
    // would ever clear it — the subscription's cleanup is the only place that can.
    expect(clearTimeoutSpy).toHaveBeenCalledWith(armed[0].id);
    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});
