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
    await vi.waitFor(() => expect(onBusyChange).toHaveBeenCalledWith(true));

    recorderButton().click(); // stop -> transcribe -> back to idle
    await vi.waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });
});
