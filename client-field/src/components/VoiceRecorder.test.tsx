/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceRecorder } from "./VoiceRecorder";

const transcribeMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/photo-dictation", () => ({
  transcribeDescriptionAudio: transcribeMock,
}));

// Minimal controllable MediaRecorder + getUserMedia so the record -> transcribe path runs under jsdom
// (which provides neither). Enough surface for VoiceRecorder: start/stop + dataavailable/stop events.
class MockMediaRecorder {
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  private listeners: Record<string, Array<(event?: unknown) => void>> = {};
  constructor(public stream: MediaStream) {}
  addEventListener(type: string, cb: (event?: unknown) => void) {
    (this.listeners[type] ||= []).push(cb);
  }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.listeners["dataavailable"]?.forEach((cb) => cb({ data: new Blob(["x"], { type: this.mimeType }) }));
    this.listeners["stop"]?.forEach((cb) => cb());
  }
}

const originalMediaDevices = (navigator as unknown as { mediaDevices: unknown }).mediaDevices;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  transcribeMock.mockResolvedValue({ transcript: "hello world" });
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
  };
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = MockMediaRecorder;
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  transcribeMock.mockReset();
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = originalMediaDevices;
  delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
});

function render(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(element);
}

function recorderButton() {
  return container!.querySelector("button") as HTMLButtonElement;
}

describe("VoiceRecorder onBusyChange", () => {
  it("reports idle (false) on mount", async () => {
    const onBusyChange = vi.fn();
    render(<VoiceRecorder onTranscript={vi.fn()} onBusyChange={onBusyChange} />);
    await vi.waitFor(() => expect(onBusyChange).toHaveBeenCalledWith(false));
  });

  it("reports idle (false) when it unmounts (so a parent guard can never get stuck busy)", async () => {
    const onBusyChange = vi.fn();
    render(<VoiceRecorder onTranscript={vi.fn()} onBusyChange={onBusyChange} />);
    await vi.waitFor(() => expect(onBusyChange).toHaveBeenCalled());

    onBusyChange.mockClear();
    root!.unmount();
    root = null;

    expect(onBusyChange).toHaveBeenCalledWith(false);
  });

  it("does not re-fire when the parent re-renders with a new callback and the state is unchanged", async () => {
    const first = vi.fn();
    render(<VoiceRecorder onTranscript={vi.fn()} onBusyChange={first} />);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));

    const second = vi.fn();
    root!.render(<VoiceRecorder onTranscript={vi.fn()} onBusyChange={second} />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(second).not.toHaveBeenCalled();
  });

  it("reports busy (true) while recording and idle (false) again after transcription", async () => {
    const onBusyChange = vi.fn();
    render(<VoiceRecorder onTranscript={vi.fn()} onBusyChange={onBusyChange} />);
    await vi.waitFor(() => expect(recorderButton()).toBeTruthy());

    recorderButton().click(); // start recording
    await vi.waitFor(() => expect(recorderButton().textContent).toContain("Stop")); // recording, button enabled
    expect(onBusyChange).toHaveBeenCalledWith(true);

    recorderButton().click(); // stop -> transcribe -> back to idle
    await vi.waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });

  it("reports busy (true) as soon as dictation starts, before the mic permission resolves", async () => {
    let resolveStream!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>((resolve) => { resolveStream = resolve; });
    (navigator as unknown as { mediaDevices: { getUserMedia: unknown } }).mediaDevices.getUserMedia =
      vi.fn().mockReturnValue(pending);

    const onBusyChange = vi.fn();
    render(<VoiceRecorder onTranscript={vi.fn()} onBusyChange={onBusyChange} />);
    await vi.waitFor(() => expect(recorderButton()).toBeTruthy());
    onBusyChange.mockClear(); // drop the mount-time false

    recorderButton().click(); // start() -> permission still pending
    await vi.waitFor(() => expect(onBusyChange).toHaveBeenCalledWith(true));

    resolveStream({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("releases the mic and does not start recording if it unmounts while permission is pending", async () => {
    let resolveStream!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>((resolve) => { resolveStream = resolve; });
    const track = { stop: vi.fn() };
    (navigator as unknown as { mediaDevices: { getUserMedia: unknown } }).mediaDevices.getUserMedia =
      vi.fn().mockReturnValue(pending);

    render(<VoiceRecorder onTranscript={vi.fn()} onBusyChange={vi.fn()} />);
    await vi.waitFor(() => expect(recorderButton()).toBeTruthy());

    recorderButton().click(); // start() -> awaiting getUserMedia
    root!.unmount(); // builder closed while permission pending
    root = null;

    resolveStream({ getTracks: () => [track] } as unknown as MediaStream); // permission granted late
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(track.stop).toHaveBeenCalled(); // mic released, not left live
  });

  it("still records under React.StrictMode (mounted flag is reset on setup, not left false)", async () => {
    render(
      <React.StrictMode>
        <VoiceRecorder onTranscript={vi.fn()} onBusyChange={vi.fn()} />
      </React.StrictMode>,
    );
    await vi.waitFor(() => expect(recorderButton()).toBeTruthy());

    recorderButton().click();
    await vi.waitFor(() => expect(recorderButton().textContent).toContain("Stop"));
  });

  it("returns to idle and releases the mic if the recorder fails to initialize", async () => {
    const track = { stop: vi.fn() };
    (navigator as unknown as { mediaDevices: { getUserMedia: unknown } }).mediaDevices.getUserMedia =
      vi.fn().mockResolvedValue({ getTracks: () => [track] });
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = class {
      constructor() { throw new Error("recording unsupported"); }
    };

    render(<VoiceRecorder onTranscript={vi.fn()} onBusyChange={vi.fn()} />);
    await vi.waitFor(() => expect(recorderButton()).toBeTruthy());

    recorderButton().click();
    await vi.waitFor(() => expect(recorderButton().textContent).toContain("Voice")); // back to idle
    expect(track.stop).toHaveBeenCalled();
  });

  it("does not deliver a transcript that resolves after the recorder unmounts", async () => {
    let resolveTranscribe!: (result: { transcript: string }) => void;
    transcribeMock.mockReturnValue(new Promise<{ transcript: string }>((resolve) => { resolveTranscribe = resolve; }));
    const onTranscript = vi.fn();

    render(<VoiceRecorder onTranscript={onTranscript} onBusyChange={vi.fn()} />);
    await vi.waitFor(() => expect(recorderButton()).toBeTruthy());

    recorderButton().click(); // start
    await vi.waitFor(() => expect(recorderButton().textContent).toContain("Stop")); // recording
    recorderButton().click(); // stop -> transcribing (pending)
    await vi.waitFor(() => expect(recorderButton().textContent).toContain("Transcribing"));

    root!.unmount(); // builder closed mid-transcription
    root = null;
    resolveTranscribe({ transcript: "late text" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onTranscript).not.toHaveBeenCalled();
  });
});
