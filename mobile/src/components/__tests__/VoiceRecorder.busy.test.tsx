// The leave guard, over the window that actually matters.
//
// `voiceBusy` (weekly-reports/editor-state.ts) exists because leaving mid-dictation unmounts the recorder
// before the transcript comes back — the user's spoken paragraph, gone with no trace that it existed.
// Moving the formatting pass to the server made that window LONGER, not shorter: the transcript now has a
// second network round trip to survive after whisper answers. This file pins that the guard covers BOTH
// legs, by driving the real component and watching what it tells its parent.
//
// The whole assertion is about ORDER, so it is written as "no `false` was reported between here and
// there" rather than "`false` was reported at the end" — a component that reported idle the instant the
// transcript arrived would satisfy the second and fail the first, and that is exactly the bug.

import React from "react";
import { render, fireEvent, act } from "@testing-library/react-native";

// `mock`-prefixed so jest's module factory is allowed to close over it (out-of-scope guard).
const mockRecorder = {
  prepareToRecordAsync: jest.fn(async () => undefined),
  record: jest.fn(),
  stop: jest.fn(async () => undefined),
  uri: "file:///tmp/voice-note.m4a",
};

jest.mock("expo-audio", () => ({
  AudioModule: { requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })) },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: jest.fn(async () => undefined),
  useAudioRecorder: () => mockRecorder,
}));

jest.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ token: "field-token", activeOfficeId: "office-1" }),
}));

const mockTranscribeAudio = jest.fn(async () => ({ transcript: "poured the north slab" }));
jest.mock("../../dictation/transcribe", () => ({ transcribeAudio: () => mockTranscribeAudio() }));

import { VoiceRecorder } from "../VoiceRecorder";

/** A promise the test resolves by hand, standing in for the server-side dictation round trip. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Every busy value the component has reported, oldest first. */
function reported(spy: jest.Mock): boolean[] {
  return spy.mock.calls.map((call) => call[0] as boolean);
}

describe("VoiceRecorder busy window", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTranscribeAudio.mockResolvedValue({ transcript: "poured the north slab" });
  });

  it("stays busy until an async onTranscript settles, not merely until the transcript arrives", async () => {
    const format = deferred<void>();
    const onTranscript = jest.fn(() => format.promise);
    const onBusyChange = jest.fn();

    const { getByLabelText } = render(
      <VoiceRecorder onTranscript={onTranscript} onBusyChange={onBusyChange} />,
    );

    // Record, then stop. `stop()` awaits transcription, then awaits the handler.
    await act(async () => {
      fireEvent.press(getByLabelText("Record voice note"));
    });
    await act(async () => {
      fireEvent.press(getByLabelText("Stop voice note"));
    });

    // The transcript is IN HAND and the handler is still running. This is the window a phone is actually
    // lost in: the recorder is no longer recording, the words exist only in that pending promise.
    expect(mockTranscribeAudio).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("poured the north slab");
    const duringRoundTrip = reported(onBusyChange);
    const firstBusy = duringRoundTrip.indexOf(true);
    expect(firstBusy).toBeGreaterThanOrEqual(0);
    // Not one `false` since the recorder went busy — so the parent's guard is continuously armed.
    expect(duringRoundTrip.slice(firstBusy)).not.toContain(false);
    // And the button says so, rather than looking idle and tappable.
    getByLabelText("Record voice note");

    // Only once the round trip settles does it report idle.
    await act(async () => {
      format.resolve();
      await format.promise;
    });
    expect(reported(onBusyChange).at(-1)).toBe(false);
  });

  it("reports idle again even if the handler rejects, so the wizard is never left un-leavable", async () => {
    // weekly-reports/dictation.ts never throws, but a handler that did must not strand the guard on.
    const onBusyChange = jest.fn();
    const onTranscript = jest.fn(async () => {
      throw new Error("handler blew up");
    });

    const { getByLabelText } = render(
      <VoiceRecorder onTranscript={onTranscript} onBusyChange={onBusyChange} />,
    );
    await act(async () => {
      fireEvent.press(getByLabelText("Record voice note"));
    });
    await act(async () => {
      fireEvent.press(getByLabelText("Stop voice note"));
    });

    expect(onTranscript).toHaveBeenCalled();
    expect(reported(onBusyChange).at(-1)).toBe(false);
  });

  it("still reports busy across transcription itself when the handler is synchronous", async () => {
    // The pre-existing guarantee, kept: making onTranscript awaitable must not shorten the first leg.
    const transcription = deferred<{ transcript: string }>();
    mockTranscribeAudio.mockReturnValue(transcription.promise as never);
    const onBusyChange = jest.fn();
    const onTranscript = jest.fn();

    const { getByLabelText } = render(
      <VoiceRecorder onTranscript={onTranscript} onBusyChange={onBusyChange} />,
    );
    await act(async () => {
      fireEvent.press(getByLabelText("Record voice note"));
    });
    await act(async () => {
      fireEvent.press(getByLabelText("Stop voice note"));
    });

    expect(onTranscript).not.toHaveBeenCalled();
    const duringTranscription = reported(onBusyChange);
    const firstBusy = duringTranscription.indexOf(true);
    expect(duringTranscription.slice(firstBusy)).not.toContain(false);

    await act(async () => {
      transcription.resolve({ transcript: "framing starts monday" });
      await transcription.promise;
    });
    expect(onTranscript).toHaveBeenCalledWith("framing starts monday");
    expect(reported(onBusyChange).at(-1)).toBe(false);
  });
});
